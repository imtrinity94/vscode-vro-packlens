'use strict';
const vscode = require('vscode');
const path = require('path');
const zlib = require('zlib');
const AdmZip = require('adm-zip');
const rebuild = require('./lib/rebuild');

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

/* ---------- editing: virtual script documents + -modified.package writer ---------- */

const SCHEME = 'vropkg';
const LANG_EXT = { javascript: '.js', node: '.js', powershell: '.ps1', python: '.py', plaintext: '.txt' };
const sessions = new Map();  // source package uri -> session
const vdocs = new Map();     // virtual document path -> { session, elementId, elementType, origVersion, key, content, ctime, mtime }

function safeName(s) { return String(s || 'unnamed').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'unnamed'; }

function getSession(srcUri, bytes) {
  const key = srcUri.toString();
  let s = sessions.get(key);
  if (!s) {
    const name = path.basename(srcUri.fsPath || srcUri.path);
    const targetName = rebuild.modifiedFileName(name);
    s = {
      key: key, srcUri: srcUri, name: name, baseBytes: Buffer.from(bytes), edits: {}, panels: new Set(), confirmed: false,
      target: targetName === name ? srcUri : vscode.Uri.joinPath(srcUri, '..', targetName)
    };
    sessions.set(key, s);
  }
  return s;
}

async function writeSession(s) {
  if (!s.confirmed && s.target.toString() !== s.srcUri.toString()) {
    let exists = false;
    try { await vscode.workspace.fs.stat(s.target); exists = true; } catch (e) { /* new file */ }
    if (exists) {
      const choice = await vscode.window.showWarningMessage(
        path.basename(s.target.fsPath) + ' already exists. Replace it with ' + s.name + ' plus the edits made now?',
        { modal: true, detail: 'Edits made earlier in that copy and not repeated here would be lost. To keep building on that copy, open it in vRO PackLens and edit there instead.' },
        'Replace');
      if (choice !== 'Replace') throw new Error('Not saved - ' + path.basename(s.target.fsPath) + ' was left as it is.');
    }
    s.confirmed = true;
  }
  const out = rebuild.rebuildPackage(s.baseBytes, s.edits);
  await vscode.workspace.fs.writeFile(s.target, out);
}

/** Record one edit, rebuild the package copy and tell open viewers. Rolls the edit back on failure. */
async function commitEdit(s, elementId, elementType, origVersion, apply, notice) {
  const prev = s.edits[elementId] ? JSON.parse(JSON.stringify(s.edits[elementId])) : null;
  const e = s.edits[elementId] || (s.edits[elementId] = { type: elementType, version: rebuild.nextVersion(origVersion), scripts: {}, values: {} });
  apply(e);
  try {
    await writeSession(s);
  } catch (err) {
    if (prev) s.edits[elementId] = prev; else delete s.edits[elementId];
    throw err;
  }
  const count = Object.keys(s.edits).length;
  s.panels.forEach(function (p) {
    p.webview.postMessage(Object.assign({ type: 'edited', elementId: elementId, version: e.version, target: path.basename(s.target.fsPath), elementCount: count }, notice));
  });
  vscode.window.setStatusBarMessage('vRO PackLens: saved to ' + path.basename(s.target.fsPath) + ' (version ' + e.version + ')', 4000);
}

class PackageScriptFs {
  constructor() { this._emitter = new vscode.EventEmitter(); this.onDidChangeFile = this._emitter.event; }
  watch() { return new vscode.Disposable(function () {}); }
  stat(uri) {
    const d = vdocs.get(uri.path);
    if (!d) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: d.ctime, mtime: d.mtime, size: Buffer.byteLength(d.content, 'utf8') };
  }
  readDirectory() { return []; }
  createDirectory() { throw vscode.FileSystemError.NoPermissions('Package scripts are virtual files'); }
  readFile(uri) {
    const d = vdocs.get(uri.path);
    if (!d) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(d.content, 'utf8');
  }
  async writeFile(uri, content) {
    const d = vdocs.get(uri.path);
    if (!d) throw vscode.FileSystemError.NoPermissions('This script is no longer linked to a package. Reopen it from vRO PackLens.');
    const text = Buffer.from(content).toString('utf8');
    await commitEdit(d.session, d.elementId, d.elementType, d.origVersion, function (e) { e.scripts[d.key] = text; }, { key: d.key, code: text });
    d.content = text;
    d.mtime = Date.now();
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: uri }]);
  }
  delete() { throw vscode.FileSystemError.NoPermissions('Package scripts cannot be deleted here'); }
  rename() { throw vscode.FileSystemError.NoPermissions('Package scripts cannot be renamed'); }
}

async function openScriptEditor(s, msg) {
  const ext = LANG_EXT[msg.lang] || '.js';
  const vpath = '/' + safeName(s.name.replace(/\.package$/i, '')) + '/' + safeName(msg.elementName) + '/' + safeName(msg.label) + ext;
  let d = vdocs.get(vpath);
  if (!d || d.session !== s) {
    d = { session: s, elementId: msg.elementId, elementType: msg.elementType, origVersion: msg.origVersion, key: msg.key, content: msg.code || '', ctime: Date.now(), mtime: Date.now() };
    vdocs.set(vpath, d);
  }
  const uri = vscode.Uri.from({ scheme: SCHEME, path: vpath });
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  if (!s.hinted) {
    s.hinted = true;
    vscode.window.showInformationMessage('Edit and save (Ctrl/Cmd+S): changes go into ' + path.basename(s.target.fsPath) + ' with the element version bumped. ' + s.name + ' itself is not changed.');
  }
}

async function editConfigValue(s, msg) {
  const t = String(msg.attType || '').toLowerCase();
  const isNum = t === 'number', isBool = t === 'boolean';
  let value;
  if (isBool) {
    const pick = await vscode.window.showQuickPick(['true', 'false'], { title: msg.elementName + ' / ' + msg.name, placeHolder: 'Current value: ' + (msg.value || '(empty)') });
    if (pick === undefined) return;
    value = pick;
  } else {
    value = await vscode.window.showInputBox({
      title: msg.elementName + ' / ' + msg.name + ' (' + msg.attType + ')', value: msg.value || '', prompt: 'Saved into ' + path.basename(s.target.fsPath),
      validateInput: isNum ? function (v) { return v.trim() === '' || isNaN(Number(v)) ? 'Enter a number' : null; } : undefined
    });
    if (value === undefined) return;
  }
  await commitEdit(s, msg.elementId, 'ConfigurationElement', msg.origVersion, function (e) { e.values[msg.name] = value; }, { valueName: msg.name, value: value });
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
        const s = sessions.get(document.uri.toString());
        const overlay = s && s.target.toString() !== document.uri.toString() ? { edits: s.edits, target: path.basename(s.target.fsPath) } : null;
        panel.webview.postMessage({ type: 'package', pkg: pkg, overlay: overlay });
      } catch (err) {
        panel.webview.postMessage({ type: 'error', message: 'Could not read ' + fileName + ': ' + (err && err.message ? err.message : err) });
      }
    };

    // Reload when the file changes on disk
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), fileName));
    watcher.onDidChange(load);
    const sessionPanels = [];
    panel.onDidDispose(function () { watcher.dispose(); sessionPanels.forEach(function (s) { s.panels.delete(panel); }); });
    const session = function () {
      const s = getSession(document.uri, bytes);
      if (!s.panels.has(panel)) { s.panels.add(panel); sessionPanels.push(s); }
      return s;
    };
    const existing = sessions.get(document.uri.toString());
    if (existing) { existing.panels.add(panel); sessionPanels.push(existing); }

    panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'ready') { await load(); }
        else if (msg.type === 'editScript') { await openScriptEditor(session(), msg); }
        else if (msg.type === 'editValue') { await editConfigValue(session(), msg); }
        else if (msg.type === 'openModified') {
          const s = sessions.get(document.uri.toString());
          if (s) vscode.commands.executeCommand('vscode.openWith', s.target, VIEW_TYPE);
        }
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
        else if (msg.type === 'saveFile') {
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(document.uri, '..', msg.name || 'schema.svg') });
          if (!target) return;
          await vscode.workspace.fs.writeFile(target, msg.base64 ? Buffer.from(msg.base64, 'base64') : Buffer.from(msg.text || '', 'utf8'));
          vscode.window.showInformationMessage('Saved ' + path.basename(target.fsPath));
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
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vroIcons.js'));
    const schemaUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'schema.js'));
    const hljsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'vendor', 'highlight.min.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
    const version = this.context.extension.packageJSON.version;
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src ' + webview.cspSource + '; img-src ' + webview.cspSource + ' data:; script-src \'nonce-' + nonce + '\';">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<link href="' + styleUri + '" rel="stylesheet"><title>vRO PackLens</title></head>' +
      '<body data-version="' + version + '"><div id="app"><div class="loading">Reading package…</div></div>' +
      '<script nonce="' + nonce + '" src="' + hljsUri + '"></script>' +
      '<script nonce="' + nonce + '" src="' + iconsUri + '"></script>' +
      '<script nonce="' + nonce + '" src="' + schemaUri + '"></script>' +
      '<script nonce="' + nonce + '" src="' + scriptUri + '"></script></body></html>';
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCHEME, new PackageScriptFs(), { isCaseSensitive: true }),
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
