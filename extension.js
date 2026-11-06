'use strict';
const vscode = require('vscode');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const VIEW_TYPE = 'vroPackLens.packageViewer';
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

/* ---------- decoding helpers ---------- */

function maybeInflate(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try { return zlib.gunzipSync(buf); } catch (e) { return buf; }
  }
  return buf;
}

function swap16(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; }
  return out;
}

/** Decode element bytes to text. Handles UTF-8 / UTF-16 (with or without BOM). Returns null for binary. */
function decodeText(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf[0] === 0xfe && buf[1] === 0xff) return swap16(buf.slice(2)).toString('utf16le');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
  // UTF-16 without BOM: "<" followed by 0x00 or 0x00 followed by "<"
  if (buf.length > 3 && buf[0] === 0x00 && buf[1] === 0x3c) return swap16(buf).toString('utf16le');
  if (buf.length > 3 && buf[0] === 0x3c && buf[1] === 0x00) return buf.toString('utf16le');
  // binary sniff: NUL bytes in the first 8 KB
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) { if (buf[i] === 0) return null; }
  return buf.toString('utf8');
}

function cleanXml(text) {
  if (text == null) return text;
  const i = text.indexOf('<');
  return i > 0 && i < 64 ? text.slice(i) : text;
}

/* ---------- package reading ---------- */

function readPackage(bytes) {
  const zip = new AdmZip(Buffer.from(bytes));
  const elements = {};
  let meta = '';
  const otherFiles = [];

  zip.getEntries().forEach(function (entry) {
    if (entry.isDirectory) return;
    const name = entry.entryName.replace(/\\/g, '/');
    const m = /^elements\/([^/]+)\/(.+)$/.exec(name);
    if (m) {
      const id = m[1];
      const part = m[2];
      const el = elements[id] || (elements[id] = { id: id });
      const raw = maybeInflate(entry.getData());
      if (part === 'data') {
        el.size = raw.length;
        const txt = raw.length <= MAX_TEXT_BYTES ? decodeText(raw) : null;
        el.binary = txt === null;
        el.data = txt === null ? null : txt;
      } else if (part === 'info') {
        el.info = cleanXml(decodeText(raw) || '');
      } else if (part === 'categories') {
        el.categories = cleanXml(decodeText(raw) || '');
      } else if (part === 'version-history') {
        el.history = cleanXml(decodeText(raw) || '');
      } else if (part === 'tags' || part.indexOf('tags') === 0) {
        el.tags = cleanXml(decodeText(raw) || '');
      }
      return;
    }
    if (name === 'dunes-meta-inf') { meta = decodeText(maybeInflate(entry.getData())) || ''; return; }
    otherFiles.push(name);
  });

  return { meta: meta, elements: Object.keys(elements).map(function (k) { return elements[k]; }), otherFiles: otherFiles };
}

function getResourceBytes(bytes, id) {
  const zip = new AdmZip(Buffer.from(bytes));
  const entry = zip.getEntry('elements/' + id + '/data');
  return entry ? maybeInflate(entry.getData()) : null;
}

/* ---------- custom editor ---------- */

class PackageDocument {
  constructor(uri) { this.uri = uri; }
  dispose() {}
}

class PackageEditorProvider {
  constructor(context) { this.context = context; }

  openCustomDocument(uri) { return new PackageDocument(uri); }

  async resolveCustomEditor(document, panel) {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    panel.webview.html = this.getHtml(panel.webview, mediaRoot);

    let bytes = null;
    const fileName = path.basename(document.uri.fsPath || document.uri.path);

    const load = async () => {
      try {
        bytes = await vscode.workspace.fs.readFile(document.uri);
        const pkg = readPackage(bytes);
        pkg.fileName = fileName;
        pkg.fileSize = bytes.length;
        panel.webview.postMessage({ type: 'package', pkg: pkg });
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: 'Could not read ' + fileName + ': ' + (err && err.message ? err.message : err) });
      }
    };

    // Reload when the file changes on disk
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), fileName));
    watcher.onDidChange(load);
    panel.onDidDispose(function () { watcher.dispose(); });

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'ready') { await load(); }
        else if (msg.type === 'openText') {
          const doc = await vscode.workspace.openTextDocument({ content: msg.content || '', language: msg.language || 'plaintext' });
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        }
        else if (msg.type === 'saveResource') {
          const data = getResourceBytes(bytes, msg.id);
          if (!data) { vscode.window.showErrorMessage('Resource data not found.'); return; }
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(document.uri, '..', msg.name || msg.id) });
          if (target) { await vscode.workspace.fs.writeFile(target, data); vscode.window.showInformationMessage('Saved ' + path.basename(target.fsPath)); }
        }
        else if (msg.type === 'export') {
          const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Export here', defaultUri: vscode.Uri.joinPath(document.uri, '..') });
          if (!picked || !picked.length) return;
          const root = vscode.Uri.joinPath(picked[0], msg.folderName || 'package-export');
          let count = 0;
          for (const f of msg.files) {
            const target = vscode.Uri.joinPath(root, ...f.path.split('/'));
            const content = f.resourceId ? getResourceBytes(bytes, f.resourceId) : Buffer.from(f.text || '', 'utf8');
            if (!content) continue;
            await vscode.workspace.fs.writeFile(target, content);
            count++;
          }
          const choice = await vscode.window.showInformationMessage('Exported ' + count + ' files to ' + root.fsPath, 'Open Folder in New Window', 'Reveal');
          if (choice === 'Open Folder in New Window') vscode.commands.executeCommand('vscode.openFolder', root, true);
          else if (choice === 'Reveal') vscode.commands.executeCommand('revealFileInOS', root);
        }
        else if (msg.type === 'copy') {
          await vscode.env.clipboard.writeText(msg.text || '');
          vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
        }
      } catch (err) {
        vscode.window.showErrorMessage('vRO PackLens: ' + (err && err.message ? err.message : err));
      }
    });
  }

  getHtml(webview, mediaRoot) {
    const nonce = Array.from({ length: 32 }, function () { return 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]; }).join('');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const version = this.context.extension.packageJSON.version;
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + webview.cspSource + '; img-src ' + webview.cspSource + ' data:; script-src \'nonce-' + nonce + '\';">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<link href="' + styleUri + '" rel="stylesheet"><title>vRO PackLens</title></head>' +
      '<body data-version="' + version + '"><div id="app"><div class="loading">Reading package…</div></div>' +
      '<script nonce="' + nonce + '" src="' + scriptUri + '"></script></body></html>';
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new PackageEditorProvider(context), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true
    }),
    vscode.commands.registerCommand('vroPackLens.open', function (uri) {
      const target = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
      if (!target) { vscode.window.showWarningMessage('Select a .package file first.'); return; }
      vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    })
  );
}

function deactivate() {}

module.exports = { activate: activate, deactivate: deactivate, readPackage: readPackage, decodeText: decodeText };
