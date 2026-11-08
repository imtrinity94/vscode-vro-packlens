'use strict';
/*
 * Write script and configuration-value edits back into a copy of a .package.
 * Ported from vRO Peekage (src/lib/rebuild.ts). Rules learned from importing into Orchestrator 9.1:
 *   - every original file stays, including signatures/ and certificates/ (an unsigned package is
 *     rejected as corrupted); a changed file with a stale signature is accepted
 *   - Orchestrator only picks up an element whose version is higher than the installed one, so
 *     every changed element gets a version bump
 *   - SecureString values are never changed
 * Only the edited text is replaced inside each element's XML; everything else stays as exported.
 */
const AdmZip = require('adm-zip');
const zlib = require('zlib');

const ACTION_SCRIPT = '__action__';
const EDITABLE_VALUE_TYPES = { string: 1, number: 1, boolean: 1 };

function nextVersion(v) {
  if (!v) return '0.0.1';
  const parts = v.split('.');
  if (parts.every(function (p) { return /^\d+$/.test(p); })) {
    parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
    return parts.join('.');
  }
  return v + '.1';
}

const reEsc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
const escAttr = function (s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); };
function cdata(s) { return '<![CDATA[' + s.split(']]>').join(']]]]><![CDATA[>') + ']]>'; }

function setRootVersion(xml, rootTag, version) {
  const m = new RegExp('<' + reEsc(rootTag) + '\\b[^>]*>').exec(xml);
  if (!m) throw new Error('<' + rootTag + '> not found');
  const tag = m[0];
  const next = /\sversion="[^"]*"/.test(tag)
    ? tag.replace(/(\sversion=")[^"]*(")/, '$1' + escAttr(version) + '$2')
    : tag.replace(/\s*(\/?>)$/, ' version="' + escAttr(version) + '"$1');
  return xml.slice(0, m.index) + next + xml.slice(m.index + tag.length);
}

function replaceScriptIn(xml, code, from, to) {
  from = from || 0; to = to == null ? xml.length : to;
  const part = xml.slice(from, to);
  const m = /<script\b[^>]*\/>|<script\b[^>]*>[\s\S]*?<\/script>/.exec(part);
  if (!m) throw new Error('script not found');
  const replaced = part.slice(0, m.index) + '<script encoded="false">' + cdata(code) + '</script>' + part.slice(m.index + m[0].length);
  return xml.slice(0, from) + replaced + xml.slice(to);
}

function setWorkflowItemScript(xml, itemName, code) {
  const open = new RegExp('<workflow-item\\b[^>]*\\sname="' + reEsc(itemName) + '"[^>]*>').exec(xml);
  if (!open) throw new Error('workflow item ' + itemName + ' not found');
  const end = xml.indexOf('</workflow-item>', open.index);
  if (end < 0) throw new Error('workflow item ' + itemName + ' is not closed');
  return replaceScriptIn(xml, code, open.index, end);
}

function setConfigValue(xml, attName, value) {
  const open = new RegExp('<att\\b[^>]*\\sname="' + reEsc(attName) + '"[^>]*?(\\/?)>').exec(xml);
  if (!open) throw new Error('attribute ' + attName + ' not found');
  const valueXml = '<value encoded="n">' + cdata(value) + '</value>';
  if (open[1] === '/') {
    const tag = open[0].replace(/\s*\/>$/, '>');
    return xml.slice(0, open.index) + tag + '\n      ' + valueXml + '\n    </att>' + xml.slice(open.index + open[0].length);
  }
  const bodyStart = open.index + open[0].length;
  const end = xml.indexOf('</att>', bodyStart);
  if (end < 0) throw new Error('attribute ' + attName + ' is not closed');
  const body = xml.slice(bodyStart, end);
  const vm = /<value\b[^>]*\/>|<value\b[^>]*>[\s\S]*?<\/value>/.exec(body);
  const nextBody = vm ? body.slice(0, vm.index) + valueXml + body.slice(vm.index + vm[0].length) : '\n      ' + valueXml + body;
  return xml.slice(0, bodyStart) + nextBody + xml.slice(end);
}

/** Decode element bytes and return an encoder that writes back in the same encoding. */
function decodeSame(buf) {
  function utf16(s, be, bom) {
    const body = Buffer.from(s, 'utf16le');
    if (be) for (let i = 0; i + 1 < body.length; i += 2) { const t = body[i]; body[i] = body[i + 1]; body[i + 1] = t; }
    return bom ? Buffer.concat([Buffer.from(be ? [0xfe, 0xff] : [0xff, 0xfe]), body]) : body;
  }
  function swap(b) { const o = Buffer.from(b); for (let i = 0; i + 1 < o.length; i += 2) { const t = o[i]; o[i] = o[i + 1]; o[i + 1] = t; } return o; }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: swap(buf.slice(2)).toString('utf16le'), encode: function (s) { return utf16(s, true, true); } };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.slice(2).toString('utf16le'), encode: function (s) { return utf16(s, false, true); } };
  if (buf[0] === 0x00 && buf[1] !== 0x00) return { text: swap(buf).toString('utf16le'), encode: function (s) { return utf16(s, true, false); } };
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.slice(3).toString('utf8'), encode: function (s) { return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]); } };
  return { text: buf.toString('utf8'), encode: function (s) { return Buffer.from(s, 'utf8'); } };
}

const ROOT_TAG = { ScriptModule: 'dunes-script-module', Workflow: 'workflow', ConfigurationElement: 'config-element' };

/** e: { type, version (new), scripts: {key: code}, values: {name: value} } */
function applyEdits(xml, e) {
  let out = xml;
  Object.keys(e.scripts || {}).forEach(function (key) {
    out = key === ACTION_SCRIPT ? replaceScriptIn(out, e.scripts[key]) : setWorkflowItemScript(out, key, e.scripts[key]);
  });
  Object.keys(e.values || {}).forEach(function (name) { out = setConfigValue(out, name, e.values[name]); });
  const root = ROOT_TAG[e.type];
  if (!root) throw new Error('Editing ' + e.type + ' elements is not supported');
  return setRootVersion(out, root, e.version);
}

/**
 * Apply all edits to the original package bytes and return the new package bytes.
 * edits: { elementId: { type, version, scripts, values } }
 */
function rebuildPackage(originalBytes, edits) {
  const zip = new AdmZip(Buffer.from(originalBytes));
  const pending = {};
  Object.keys(edits).forEach(function (id) { pending['elements/' + id + '/data'] = id; });
  zip.getEntries().forEach(function (entry) {
    const id = pending[entry.entryName];
    if (!id) return;
    let raw = entry.getData();
    const gz = raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b;
    if (gz) raw = zlib.gunzipSync(raw);
    const d = decodeSame(raw);
    let bytes = d.encode(applyEdits(d.text, edits[id]));
    if (gz) bytes = zlib.gzipSync(bytes);
    zip.updateFile(entry.entryName, bytes);
    delete pending[entry.entryName];
  });
  const missing = Object.keys(pending);
  if (missing.length) throw new Error('Could not find ' + missing.join(', ') + ' in the package');
  return zip.toBuffer();
}

function modifiedFileName(fileName) {
  if (/-modified\.package$/i.test(fileName)) return fileName;
  return fileName.replace(/(\.package)?$/i, '-modified.package');
}

module.exports = { ACTION_SCRIPT: ACTION_SCRIPT, EDITABLE_VALUE_TYPES: EDITABLE_VALUE_TYPES, nextVersion: nextVersion, rebuildPackage: rebuildPackage, modifiedFileName: modifiedFileName, applyEdits: applyEdits };
