(function () {
  'use strict';
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: function () {}, getState: function () { return null; }, setState: function () {} };
  const app = document.getElementById('app');
  const VERSION = document.body.getAttribute('data-version') || '';

  /* ---------- category definitions ---------- */
  const GROUPS = [
    { key: 'Workflow', label: 'Workflows', icon: 'workflow' },
    { key: 'ScriptModule', label: 'Actions', icon: 'action' },
    { key: 'ConfigurationElement', label: 'Configuration Elements', icon: 'config' },
    { key: 'ResourceElement', label: 'Resource Elements', icon: 'resource' },
    { key: 'PolicyTemplate', label: 'Policy Templates', icon: 'policy' },
    { key: 'Other', label: 'Other', icon: 'other' }
  ];
  const TYPE_ALIASES = { Action: 'ScriptModule', ConfigElement: 'ConfigurationElement', Resource: 'ResourceElement', Policy: 'PolicyTemplate' };

  const ICONS = {
    chevron: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M6 4l4 4-4 4z"/></svg>',
    folder: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M1.5 3h4.3l1.4 1.5h7.3v8.5h-13z" opacity=".85"/></svg>',
    module: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7zM8 3.2L4.3 5.1 8 7l3.7-1.9zM3.8 6.3v4.4L7.4 12.6V8.2zm8.4 0L8.6 8.2v4.4l3.6-1.9z"/></svg>',
    workflow: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M2 2h5v4H2zm7 8h5v4H9zM4 6h1v3h6v1H4z"/></svg>',
    action: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M9.5 1L4 9h3.5L6.5 15 12 7H8.5z"/></svg>',
    config: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M2 3h12v2H2zm0 4h12v2H2zm0 4h12v2H2z" opacity=".9"/><circle cx="5" cy="4" r="1.4" fill="var(--vscode-editor-background)"/><circle cx="10" cy="8" r="1.4" fill="var(--vscode-editor-background)"/><circle cx="6" cy="12" r="1.4" fill="var(--vscode-editor-background)"/></svg>',
    resource: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M3 1.5h6.5L13 5v9.5H3zM9 2.5V5.5h3"/></svg>',
    policy: '<svg viewBox="0 0 16 16" width="16" height="16"><path fill="currentColor" d="M8 1l5.5 2v4.5c0 3.3-2.4 6-5.5 7.5-3.1-1.5-5.5-4.2-5.5-7.5V3z"/></svg>',
    other: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg>',
    package: '<svg viewBox="0 0 16 16" width="18" height="18"><path fill="currentColor" d="M8 1l6.5 3.2v7.6L8 15l-6.5-3.2V4.2zM8 2.6L3.4 4.8 8 7l4.6-2.2zM2.9 6v4.9L7.3 13V8.2zm10.2 0L8.7 8.2V13l4.4-2.1z"/></svg>'
  };

  /* ---------- state ---------- */
  let pkg = null;
  const EDITABLE_TYPES = { string: 1, number: 1, boolean: 1 };
  let editState = null;  // { target, count }
  let items = [];           // parsed elements
  let byId = {};
  let selectedId = null;
  let collapsed = {};       // node path -> true
  let filterText = '';
  let searchScripts = false;
  const saved = vscode.getState() || {};
  if (saved.collapsed) collapsed = saved.collapsed;
  if (saved.searchScripts) searchScripts = true;

  function persist() { vscode.setState({ collapsed: collapsed, searchScripts: searchScripts, selectedId: selectedId }); }

  /* ---------- XML helpers ---------- */
  const parser = new DOMParser();
  function parseXml(text) {
    if (!text || text.replace(/^\s+/, '').charAt(0) !== '<') return null;
    const doc = parser.parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) return null;
    return doc;
  }
  function kids(node, tag) {
    const out = [];
    if (!node) return out;
    for (let c = node.firstElementChild; c; c = c.nextElementSibling) { if (!tag || c.localName === tag) out.push(c); }
    return out;
  }
  function kid(node, tag) { return kids(node, tag)[0] || null; }
  function txt(node) { return node ? (node.textContent || '').trim() : ''; }
  function attr(node, name) { return node && node.getAttribute(name) != null ? node.getAttribute(name) : ''; }

  function parseProps(text) {
    const out = {};
    if (!text) return out;
    const doc = parseXml(text);
    if (doc && doc.documentElement) {
      Array.prototype.forEach.call(doc.getElementsByTagName('entry'), function (e) { out[attr(e, 'key')] = e.textContent; });
      if (Object.keys(out).length) return out;
    }
    text.split(/\r?\n/).forEach(function (line) {
      if (!line || line.charAt(0) === '#' || line.charAt(0) === '!') return;
      const m = /^\s*([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/\\(.)/g, '$1');
    });
    return out;
  }

  function parseCategories(text) {
    const doc = parseXml(text);
    if (!doc) return [];
    return Array.prototype.map.call(doc.getElementsByTagName('category'), function (c) {
      const n = kid(c, 'name');
      return n ? txt(n) : attr(c, 'name');
    }).filter(Boolean);
  }

  function langForRuntime(runtime) {
    const r = (runtime || '').toLowerCase();
    if (r.indexOf('python') === 0) return 'python';
    if (r.indexOf('powershell') === 0 || r.indexOf('powercli') === 0) return 'powershell';
    return 'javascript';
  }
  const LANG_NAME = { powershell: 'PowerShell', python: 'Python', node: 'Node.js', javascript: 'JavaScript' };
  /** Best guess from the script text, used when the runtime lives in an action environment. */
  function detectScriptLang(code) {
    if (!code) return null;
    const t = code.slice(0, 60000);
    const count = function (re) { return (t.match(re) || []).length; };
    const ps = count(/^\s*param\s*\(/gim) * 3 + count(/function\s+Handler\s*\(\s*\$context/gi) * 4 + count(/\$[A-Za-z_][\w:]*\s*=/g) +
      count(/\b(?:Get|Set|New|Remove|Add|Connect|Disconnect|Write|Import|Invoke|ConvertTo|ConvertFrom|Select|Where|ForEach)-[A-Z][A-Za-z]+/g) * 2 +
      count(/\s-(?:eq|ne|gt|lt|ge|le|like|match|and|or|not)\s/gi) + count(/\[(?:string|int|bool|hashtable|PSCustomObject|array)\]/gi);
    const py = count(/^\s*def\s+handler\s*\(\s*context/gim) * 4 + count(/^\s*def\s+\w+\s*\([^)]*\)\s*(?:->[^:]+)?:\s*$/gm) * 2 +
      count(/^\s*(?:import\s+\w|from\s+[\w.]+\s+import\s)/gm) * 2 + count(/^\s*(?:elif|except|with)\b.*:\s*$/gm) + count(/\b(?:None|True|False)\b/g) * 0.5;
    const node = count(/\bexports\.handler\s*=/g) * 4 + count(/\brequire\(\s*['"]/g) * 2 + count(/\b(?:async\s+function|await)\b/g);
    const best = Math.max(ps, py, node);
    if (best < 3) return null;
    return best === ps ? 'powershell' : best === py ? 'python' : 'node';
  }
  /** runtime → environment → detection → JavaScript (Rhino) */
  function resolveRuntime(runtime, environmentId, script) {
    if (runtime && !environmentId) return { lang: langForRuntime(runtime), label: runtime };
    if (environmentId) {
      const env = envs[environmentId.trim().toLowerCase()];
      if (env && env.runtime) return { lang: langForRuntime(env.runtime), label: env.runtime + ' · environment ' + env.name };
      const guess = detectScriptLang(script);
      const where = env ? 'environment ' + env.name : 'environment not in package';
      if (guess) return { lang: guess === 'node' ? 'javascript' : guess, label: LANG_NAME[guess] + ' (detected) · ' + where };
      return { lang: 'plaintext', label: 'Unknown runtime · ' + where };
    }
    return { lang: 'javascript', label: 'JavaScript (Rhino)' };
  }
  let envs = {};

  function num(v) { return v === '' || v == null ? null : parseFloat(v); }

  function decodeScript(node) {
    if (!node) return '';
    let s = node.textContent || '';
    if (attr(node, 'encoded') === 'true') { try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { /* keep */ } }
    return s;
  }

  function params(node) {
    return kids(node, 'param').map(function (p) {
      const d = kid(p, 'description');
      return { name: attr(p, 'name') || attr(p, 'n'), type: attr(p, 'type') || attr(p, 't'), description: d ? txt(d) : (p.firstElementChild ? '' : txt(p)) };
    });
  }

  /* ---------- element parsing ---------- */
  function sniffType(root) {
    if (!root) return 'Other';
    const n = root.localName;
    if (n === 'workflow') return 'Workflow';
    if (n === 'dunes-script-module' || n === 'script-module') return 'ScriptModule';
    if (n === 'config-element' || n === 'configuration-element') return 'ConfigurationElement';
    if (n === 'policy-template' || n === 'policy') return 'PolicyTemplate';
    return 'Other';
  }

  function parseElement(raw) {
    const info = parseProps(raw.info);
    const cats = parseCategories(raw.categories);
    const doc = raw.binary ? null : parseXml(raw.data);
    const root = doc ? doc.documentElement : null;
    let type = info.type || '';
    type = TYPE_ALIASES[type] || type;
    if (!type || GROUPS.every(function (g) { return g.key !== type; })) {
      type = raw.binary ? (info.mimetype || info['mime-type'] ? 'ResourceElement' : 'Other') : sniffType(root);
    }
    const it = { id: raw.id, type: type, info: info, categories: cats, raw: raw, root: root, scripts: [] };

    if (type === 'Workflow' && root) {
      it.name = txt(kid(root, 'display-name')) || info.name || raw.id;
      it.description = txt(kid(root, 'description'));
      it.version = attr(root, 'version');
      it.apiVersion = attr(root, 'api-version');
      it.objectId = attr(root, 'id');
      it.inputs = params(kid(root, 'input'));
      it.outputs = params(kid(root, 'output'));
      it.attributes = kids(root, 'attrib').map(function (a) {
        return { name: attr(a, 'name'), type: attr(a, 'type'), readOnly: attr(a, 'read-only') === 'true', value: txt(kid(a, 'value')), description: txt(kid(a, 'description')) };
      });
      it.wfItems = kids(root, 'workflow-item').map(function (w) {
        const sc = kid(w, 'script');
        const o = {
          name: attr(w, 'name'), type: attr(w, 'type'), displayName: txt(kid(w, 'display-name')) || attr(w, 'name'),
          description: txt(kid(w, 'description')), script: decodeScript(sc), linked: attr(w, 'linked-workflow-id'),
          module: attr(w, 'script-module'), next: attr(w, 'out-name'), altNext: attr(w, 'alt-out-name'), catchName: attr(w, 'catch-name'),
          endMode: attr(w, 'end-mode'), prototypeId: attr(w, 'prototype-id'), launchedWorkflowId: attr(w, 'launched-workflow-id'),
          conditionTargets: kids(w, 'condition').map(function (c) { return attr(c, 'label'); }).filter(function (l) { return l && l !== 'null'; }),
          x: num(attr(kid(w, 'position'), 'x')), y: num(attr(kid(w, 'position'), 'y')),
          inBind: kids(kid(w, 'in-binding'), 'bind').map(function (b) { return { name: attr(b, 'name'), type: attr(b, 'type'), source: attr(b, 'export-name') }; }),
          outBind: kids(kid(w, 'out-binding'), 'bind').map(function (b) { return { name: attr(b, 'name'), type: attr(b, 'type'), target: attr(b, 'export-name') }; })
        };
        o.runtime = txt(kid(w, 'runtime'));
        o.environmentId = o.runtime.indexOf('environment:') === 0 ? o.runtime.slice(12) : '';
        if (o.script && o.script.trim()) { o.scriptIdx = it.scripts.length; it.scripts.push({ label: o.displayName + ' (' + o.name + ')', code: o.script, key: o.name, editLabel: o.displayName + ' (' + o.name + ')' }); }
        return o;
      });
      it.rootName = attr(root, 'root-name');
      const sp = kid(root, 'position');
      it.start = sp ? { x: num(attr(sp, 'x')) || 0, y: num(attr(sp, 'y')) || 0 } : null;
      it.errorHandlers = kids(root, 'error-handler').map(function (e) { return attr(e, 'name'); }).filter(Boolean);
      const presentation = kid(root, 'presentation');
      it.presentation = presentation ? presentation.outerHTML : '';
    } else if (type === 'ScriptModule' && root) {
      it.name = attr(root, 'name') || info.name || raw.id;
      it.module = cats.length ? cats.join('.') : (info.module || '');
      it.description = txt(kid(root, 'description'));
      it.version = attr(root, 'version');
      it.returnType = attr(root, 'result-type');
      it.inputs = params(root);
      it.runtime = attr(root, 'runtime') || txt(kid(root, 'runtime'));
      it.environmentId = (it.runtime.indexOf('environment:') === 0 ? it.runtime.slice(12) : '') || attr(root, 'environment') || txt(kid(root, 'environment'));
      it.script = decodeScript(kid(root, 'script'));
      it.scripts.push({ label: it.name, code: it.script, key: '__action__', editLabel: it.name });
    } else if (type === 'ConfigurationElement' && root) {
      it.name = txt(kid(root, 'display-name')) || attr(root, 'name') || info.name || raw.id;
      it.description = txt(kid(root, 'description'));
      it.version = attr(root, 'version');
      const atts = kid(root, 'atts') || root;
      it.attributes = kids(atts, 'att').map(function (a) {
        const t = attr(a, 'type');
        const v = kid(a, 'value');
        let value = txt(v);
        const secure = /^SecureString$/i.test(t) || attr(v, 'encoded') === 'y';
        if (secure) value = value ? '•••••• (encrypted)' : '';
        return { name: attr(a, 'name'), type: t, value: value, secure: secure, description: txt(kid(a, 'description')) };
      });
    } else if (type === 'ResourceElement') {
      it.name = info.name || info['display-name'] || raw.id;
      it.mime = info.mimetype || info['mime-type'] || '';
      it.description = info.description || '';
      it.version = info.version || '';
    } else {
      it.name = (root && (txt(kid(root, 'display-name')) || attr(root, 'name'))) || info.name || raw.id;
      it.description = root ? txt(kid(root, 'description')) : '';
      it.version = root ? attr(root, 'version') : '';
    }
    it.searchText = (it.name + ' ' + (it.module || '') + ' ' + it.categories.join('/') + ' ' + it.id + ' ' + (it.description || '')).toLowerCase();
    it.scriptText = it.scripts.map(function (s) { return s.code; }).join('\n').toLowerCase();
    return it;
  }

  function resolveLanguages(it) {
    it.origVersion = it.version;
    if (it.type === 'ScriptModule') {
      const r = resolveRuntime(it.runtime, it.environmentId, it.script);
      it.lang = r.lang; it.runtimeLabel = r.label;
      it.scripts.forEach(function (s) { s.lang = r.lang; });
    } else if (it.type === 'Workflow') {
      it.wfItems.forEach(function (w) {
        const r = resolveRuntime(w.runtime, w.environmentId, w.script);
        w.lang = r.lang; w.runtimeLabel = r.label;
        if (w.scriptIdx != null) it.scripts[w.scriptIdx].lang = r.lang;
      });
    }
  }

  /** Apply a saved edit to the in-memory element so the viewer shows what is in the -modified copy. */
  function patchItem(id, m, quiet) {
    const it = byId[id];
    if (!it) return;
    it.edited = true;
    if (m.version) it.version = m.version;
    if (m.key != null) {
      if (it.type === 'ScriptModule') { it.script = m.code; it.scripts[0].code = m.code; it.scripts[0].edited = true; }
      else if (it.type === 'Workflow') {
        const w = it.wfItems.filter(function (x) { return x.name === m.key; })[0];
        if (w) { w.script = m.code; if (w.scriptIdx != null) { it.scripts[w.scriptIdx].code = m.code; it.scripts[w.scriptIdx].edited = true; } }
      }
      it.scriptText = it.scripts.map(function (s) { return s.code; }).join('\n').toLowerCase();
    }
    if (m.valueName != null && it.attributes) {
      it.attributes.forEach(function (a) { if (a.name === m.valueName) { a.value = m.value; a.edited = true; } });
    }
  }

  function renderBanner() {
    const el = document.getElementById('editbar');
    if (!el) return;
    if (!editState) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<span>' + editState.count + ' element' + (editState.count === 1 ? '' : 's') + ' edited — saved to <b class="mono">' + esc(editState.target) + '</b> with versions bumped. The original package is unchanged.</span>' +
      '<button data-act="open-modified">Open copy</button>';
  }

  /* ---------- tree building ---------- */
  function folderPath(it) {
    if (it.type === 'ScriptModule') return [{ name: it.module || '(no module)', kind: 'module' }];
    return it.categories.map(function (c) { return { name: c, kind: 'folder' }; });
  }

  function buildTree(list) {
    const groups = GROUPS.map(function (g) { return { group: g, key: g.key, label: g.label, folders: {}, leaves: [], count: 0, path: g.key }; });
    const byKey = {};
    groups.forEach(function (g) { byKey[g.key] = g; });
    list.forEach(function (it) {
      const g = byKey[it.type] || byKey.Other;
      g.count++;
      let node = g;
      folderPath(it).forEach(function (seg) {
        if (!node.folders[seg.name]) node.folders[seg.name] = { label: seg.name, kind: seg.kind, folders: {}, leaves: [], count: 0, path: node.path + '/' + seg.name };
        node = node.folders[seg.name];
        node.count++;
      });
      node.leaves.push(it);
    });
    return groups.filter(function (g) { return g.count > 0; });
  }

  function matches(it) {
    if (!filterText) return true;
    if (it.searchText.indexOf(filterText) >= 0) return true;
    return searchScripts && it.scriptText.indexOf(filterText) >= 0;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  const byLabel = function (a, b) { return String(a.label || a.name).localeCompare(String(b.label || b.name), undefined, { sensitivity: 'base', numeric: true }); };

  function renderNode(node, depth, isGroup) {
    const leaves = node.leaves.filter(matches).sort(byLabel);
    const folderHtml = Object.keys(node.folders).map(function (k) { return node.folders[k]; }).sort(byLabel)
      .map(function (f) { return renderNode(f, depth + 1, false); }).filter(Boolean).join('');
    if (!leaves.length && !folderHtml) return '';
    const isCollapsed = !filterText && collapsed[node.path] === true;
    const icon = isGroup ? ICONS[node.group.icon] : (node.kind === 'module' ? ICONS.module : ICONS.folder);
    const cls = isGroup ? 'row group ic-' + node.group.icon : 'row folder' + (node.kind === 'module' ? ' ic-module' : '');
    const count = isGroup ? '<span class="count">' + node.count + '</span>' : '';
    let html = '<div class="' + cls + (isCollapsed ? ' collapsed' : '') + '" data-path="' + esc(node.path) + '" data-d="' + depth + '" role="treeitem" aria-expanded="' + (!isCollapsed) + '">' +
      '<span class="twisty">' + ICONS.chevron + '</span><span class="ico">' + icon + '</span><span class="label">' + esc(node.label) + '</span>' + count + '</div>';
    if (!isCollapsed) {
      html += folderHtml;
      html += leaves.map(function (it) {
        const g = GROUPS.filter(function (x) { return x.key === it.type; })[0] || GROUPS[5];
        return '<div class="row leaf ic-' + g.icon + (it.id === selectedId ? ' selected' : '') + '" data-id="' + esc(it.id) + '" data-d="' + (depth + 1) + '" role="treeitem" title="' + esc(it.name) + '">' +
          '<span class="twisty"></span><span class="ico">' + ICONS[g.icon] + '</span><span class="label">' + esc(it.name) + '</span>' + (it.edited ? '<span class="mod" title="Edited">M</span>' : '') + '</div>';
      }).join('');
    }
    return html;
  }

  /* ---------- detail rendering ---------- */
  function kv(rows) {
    return '<table class="kv">' + rows.filter(function (r) { return r[1]; }).map(function (r) { return '<tr><th>' + esc(r[0]) + '</th><td>' + (r[2] ? r[1] : esc(r[1])) + '</td></tr>'; }).join('') + '</table>';
  }
  function table(cols, rows, empty) {
    if (!rows.length) return '<p class="muted">' + esc(empty || 'None') + '</p>';
    return '<table class="grid"><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c[0]) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + cols.map(function (c) { const v = r[c[1]]; return '<td' + (c[2] ? ' class="' + c[2] + '"' : '') + '>' + esc(v === true ? 'yes' : v === false ? '' : v) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  }
  function section(title, body, count) {
    return '<section><h3>' + esc(title) + (count != null ? ' <span class="count">' + count + '</span>' : '') + '</h3>' + body + '</section>';
  }
  function highlight(code, lang) {
    if (!code) return '';
    try {
      if (window.hljs && lang && lang !== 'plaintext' && window.hljs.getLanguage(lang)) return window.hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch (e) { /* fall back to plain */ }
    return esc(code);
  }
  function codeBlock(code, label, idx, lang, edited) {
    lang = lang || 'javascript';
    return '<div class="code' + (edited ? ' edited' : '') + '"><div class="code-head"><span>' + esc(label) + ' <span class="lang-badge lang-' + lang + '">' + esc(LANG_NAME[lang] || lang) + '</span>' +
      (edited ? ' <span class="edited-badge">edited</span>' : '') + '</span><span class="code-actions">' +
      '<button class="link" data-act="copy-script" data-idx="' + idx + '">Copy</button>' +
      '<button class="link" data-act="edit-script" data-idx="' + idx + '" title="Opens in an editor tab; saving writes a -modified.package copy">Edit</button></span></div>' +
      '<pre class="hljs">' + (code ? highlight(code, lang) : '<span class="muted">(empty)</span>') + '</pre></div>';
  }

  function renderDetail(it) {
    if (!it) {
      return '<div class="empty-detail"><div class="big">' + ICONS.package + '</div><p>Select an item on the left to see inside.</p></div>';
    }
    const g = GROUPS.filter(function (x) { return x.key === it.type; })[0] || GROUPS[5];
    const where = it.type === 'ScriptModule' ? (it.module || '') : it.categories.join(' / ');
    let h = '<header class="d-head ic-' + g.icon + '"><span class="ico">' + ICONS[g.icon] + '</span><div><div class="d-type">' + esc(g.label.replace(/s$/, '')) + '</div>' +
      '<h2>' + esc(it.name) + '</h2>' + (where ? '<div class="d-path">' + esc(where) + '</div>' : '') + '</div>' +
      '<div class="d-actions">' + (it.raw.data != null ? '<button data-act="open-xml">' + (it.type === 'ResourceElement' ? 'Open content' : 'View XML') + '</button>' : '') +
      (it.type === 'ResourceElement' ? '<button data-act="save-res">Save as…</button>' : '') + '</div></header>';
    if (it.description) h += '<p class="desc">' + esc(it.description) + '</p>';

    if (it.type === 'Workflow') {
      const tabs = [['schema', 'Schema', it.wfItems.length], ['details', 'Inputs & variables', it.inputs.length + it.outputs.length + it.attributes.length], ['scripts', 'Scripts', it.scripts.length]];
      h += '<div class="tabs" role="tablist">' + tabs.map(function (t) { return '<button class="tab' + (wfTab === t[0] ? ' active' : '') + '" role="tab" data-act="wf-tab" data-tab="' + t[0] + '">' + esc(t[1]) + ' <span class="count">' + t[2] + '</span></button>'; }).join('') + '</div>';
      if (wfTab === 'schema') {
        h += '<div class="wf-toolbar"><button class="icon-btn" data-act="zoom-out" title="Zoom out">−</button><span id="wfzoom" class="muted small zoomval"></span>' +
          '<button class="icon-btn" data-act="zoom-in" title="Zoom in">+</button><button data-act="zoom-fit">Fit</button><button data-act="zoom-100">100%</button>' +
          '<span class="spacer"></span><button data-act="save-svg">Save SVG…</button><button data-act="save-png">Save PNG…</button></div>' +
          '<div id="wfview" class="wf-view"></div>' +
          '<div class="legend"><span><i class="lg lg-blue"></i> next</span><span><i class="lg lg-green"></i> from a decision</span><span><i class="lg lg-red"></i> false path / error handling</span>' +
          '<span class="muted">Click a step for its details. Drag to pan, Ctrl + scroll to zoom.</span></div><div id="wfitem"></div>';
      } else if (wfTab === 'details') {
        h += kv([['ID', it.objectId || it.id], ['Version', it.version + (it.edited ? ' (edited)' : '')], ['API version', it.apiVersion]]);
        h += section('Inputs', table([['Name', 'name', 'mono'], ['Type', 'type', 'mono'], ['Description', 'description']], it.inputs), it.inputs.length);
        h += section('Outputs', table([['Name', 'name', 'mono'], ['Type', 'type', 'mono'], ['Description', 'description']], it.outputs), it.outputs.length);
        h += section('Variables', table([['Name', 'name', 'mono'], ['Type', 'type', 'mono'], ['Value', 'value', 'mono'], ['Read-only', 'readOnly']], it.attributes), it.attributes.length);
        const flow = it.wfItems.map(function (w) {
          return { name: w.name, displayName: w.displayName, type: w.type, calls: w.module || w.linked || '', next: w.next,
            inputs: w.inBind.map(function (b) { return b.name + (b.source ? ' ← ' + b.source : ''); }).join(', '),
            outputs: w.outBind.map(function (b) { return b.name + (b.target ? ' → ' + b.target : ''); }).join(', ') };
        });
        h += section('Schema items', table([['Item', 'name', 'mono nowrap'], ['Name', 'displayName'], ['Type', 'type'], ['Calls', 'calls', 'mono'], ['In', 'inputs', 'mono'], ['Out', 'outputs', 'mono'], ['Next', 'next', 'mono nowrap']], flow), flow.length);
      } else {
        h += section('Scripts', it.scripts.length ? it.scripts.map(function (s, i) { return codeBlock(s.code, s.label, i, s.lang, s.edited); }).join('') : '<p class="muted">No scriptable tasks.</p>', it.scripts.length);
      }
    } else if (it.type === 'ScriptModule') {
      h += kv([['Module', it.module], ['ID', it.id], ['Version', it.version + (it.edited ? ' (edited)' : '')], ['Return type', it.returnType || 'void'], ['Runtime', it.runtimeLabel]]);
      h += section('Inputs', table([['Name', 'name', 'mono'], ['Type', 'type', 'mono'], ['Description', 'description']], it.inputs), it.inputs.length);
      h += section('Script', codeBlock(it.script, it.module + '/' + it.name, 0, it.scripts[0].lang, it.edited && it.scripts[0].edited));
    } else if (it.type === 'ConfigurationElement') {
      h += kv([['ID', it.id], ['Version', it.version + (it.edited ? ' (edited)' : '')]]);
      h += section('Attributes', it.attributes.length ? '<table class="grid"><thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Description</th><th></th></tr></thead><tbody>' +
        it.attributes.map(function (a, i) {
          const editable = EDITABLE_TYPES[a.type] && !a.secure;
          return '<tr' + (a.edited ? ' class="edited-row"' : '') + '><td class="mono">' + esc(a.name) + '</td><td class="mono">' + esc(a.type) + '</td><td class="mono">' + esc(a.value) + (a.edited ? ' <span class="edited-badge">edited</span>' : '') + '</td><td>' + esc(a.description) + '</td>' +
            '<td class="nowrap">' + (editable ? '<button class="link" data-act="edit-value" data-idx="' + i + '">Edit</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table>' : '<p class="muted">None</p>', it.attributes.length);
    } else if (it.type === 'ResourceElement') {
      h += kv([['ID', it.id], ['MIME type', it.mime], ['Size', fmtSize(it.raw.size)], ['Version', it.version]]);
      if (it.raw.data != null) h += section('Content preview', '<pre class="preview">' + esc(it.raw.data.slice(0, 20000)) + (it.raw.data.length > 20000 ? '\n…' : '') + '</pre>');
      else h += '<p class="muted">Binary content. Use “Save as…” to extract it.</p>';
    } else {
      h += kv([['ID', it.id], ['Type', it.info.type || '(unknown)'], ['Version', it.version]]);
    }
    const infoRows = Object.keys(it.info).filter(function (k) { return k !== 'type'; }).map(function (k) { return { key: k, value: it.info[k] }; });
    if (infoRows.length) h += '<details class="meta"><summary>Element info</summary>' + table([['Key', 'key', 'mono'], ['Value', 'value', 'mono']], infoRows) + '</details>';
    return h;
  }

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  /* ---------- layout ---------- */
  function renderShell() {
    const meta = parseProps(pkg.meta);
    const pkgName = meta['pkg-name'] || meta.name || pkg.fileName.replace(/\.package$/i, '');
    const counts = GROUPS.map(function (g) {
      const n = items.filter(function (i) { return i.type === g.key; }).length;
      return n ? '<span class="chip ic-' + g.icon + '"><span class="ico">' + ICONS[g.icon] + '</span>' + n + ' ' + esc(g.label) + '</span>' : '';
    }).join('');
    app.innerHTML =
      '<div class="topbar"><span class="brand">' + ICONS.package + '<b>vRO PackLens</b><span class="ver">' + esc(VERSION) + '</span></span>' +
      '<span class="pkgname" title="' + esc(pkg.fileName) + '">' + esc(pkgName) + '</span><span class="muted small">' + fmtSize(pkg.fileSize) + '</span>' +
      '<span class="spacer"></span><button data-act="export" title="Write every workflow, action and element to a folder">Export to folder…</button></div>' +
      (meta['pkg-description'] ? '<div class="pkgdesc">' + esc(meta['pkg-description']) + '</div>' : '') +
      '<div class="chips">' + counts + '</div><div id="editbar" class="editbar" hidden></div>' +
      '<div class="main"><aside class="side"><div class="search"><input id="q" type="text" placeholder="Filter by name, module, folder…" spellcheck="false" value="' + esc(filterText) + '">' +
      '<label class="small"><input id="qs" type="checkbox"' + (searchScripts ? ' checked' : '') + '> in scripts</label>' +
      '<span class="tree-actions"><button class="icon-btn" data-act="expand" title="Expand all">+</button><button class="icon-btn" data-act="collapse" title="Collapse all">−</button></span></div>' +
      '<div id="tree" class="tree" role="tree" tabindex="0"></div></aside><div class="splitter"></div><main id="detail" class="detail"></main></div>';
    renderTree();
    renderDetailPane();
    renderBanner();
    wireShell();
  }

  function renderTree() {
    const tree = document.getElementById('tree');
    const html = buildTree(items).map(function (g) { return renderNode(g, 0, true); }).join('');
    tree.innerHTML = html || '<p class="muted pad">' + (items.length ? 'No matches.' : 'This package has no elements.') + '</p>';
    // The webview CSP blocks inline style attributes, so indent through the CSSOM instead
    Array.prototype.forEach.call(tree.querySelectorAll('.row[data-d]'), function (r) { r.style.paddingLeft = (6 + (+r.dataset.d) * 16) + 'px'; });
  }
  function renderDetailPane() {
    document.getElementById('detail').innerHTML = renderDetail(byId[selectedId]);
    const it = byId[selectedId];
    if (it && it.type === 'Workflow' && wfTab === 'schema') mountSchema(it, true);
  }

  /* ---------- workflow schema ---------- */
  let wfTab = 'schema';
  let wfSel = null;
  let zoom = 1;
  let layoutCache = null;

  function mountSchema(it, fit) {
    const view = document.getElementById('wfview');
    if (!view || !window.PackLensSchema) return;
    if (!layoutCache || layoutCache.id !== it.id) layoutCache = { id: it.id, layout: window.PackLensSchema.computeLayout(it) };
    const layout = layoutCache.layout;
    if (!layout) { view.outerHTML = '<p class="muted">No schema layout information in this workflow.</p>'; return; }
    view.innerHTML = window.PackLensSchema.renderSvg(it, layout, wfSel, true);
    if (fit) zoom = Math.min(1, Math.max(0.5, Math.round(((view.clientWidth - 2) / layout.width) * 100) / 100 || 1));
    applyZoom();
    renderItemPanel(it);
  }
  function applyZoom() {
    const svg = document.querySelector('#wfview svg');
    const l = layoutCache && layoutCache.layout;
    if (!svg || !l) return;
    svg.setAttribute('width', Math.round(l.width * zoom));
    svg.setAttribute('height', Math.round(l.height * zoom));
    const zv = document.getElementById('wfzoom');
    if (zv) zv.textContent = Math.round(zoom * 100) + '%';
  }
  function setZoom(z) { zoom = Math.min(2.5, Math.max(0.25, Math.round(z * 100) / 100)); applyZoom(); }

  function renderItemPanel(it) {
    const box = document.getElementById('wfitem');
    if (!box) return;
    const w = it.wfItems.filter(function (x) { return x.name === wfSel; })[0];
    if (!w) { box.innerHTML = ''; return; }
    let h = '<div class="item-panel"><div class="ip-head"><img alt="" width="28" height="28" src="' + window.PackLensSchema.iconUri(window.PackLensSchema.iconFor(w)) + '"><div><div class="d-type">' + esc(w.type) + ' · ' + esc(w.name) + '</div><h3 class="ip-title">' + esc(w.displayName) + '</h3></div></div>';
    if (w.description) h += '<p class="desc">' + esc(w.description) + '</p>';
    h += kv([['Calls action', w.module], ['Calls workflow', w.linked || w.launchedWorkflowId], ['Next', w.next], ['False / alt path', w.altNext], ['On error', w.catchName], ['Prototype', w.prototypeId]]);
    h += section('Inputs', table([['Name', 'name', 'mono'], ['Type', 'type', 'mono'], ['Bound to', 'source', 'mono']], w.inBind), w.inBind.length);
    h += section('Outputs', table([['Name', 'name', 'mono'], ['Type', 'type', 'mono'], ['Bound to', 'target', 'mono']], w.outBind), w.outBind.length);
    if (w.scriptIdx != null) h += section('Script', codeBlock(w.script, w.displayName, w.scriptIdx, it.scripts[w.scriptIdx].lang, it.scripts[w.scriptIdx].edited));
    if (w.runtimeLabel && w.runtimeLabel !== 'JavaScript (Rhino)') h = h.replace('<h3 class="ip-title">', '<h3 class="ip-title" title="' + esc(w.runtimeLabel) + '">');
    box.innerHTML = h + '</div>';
  }

  function serializeSchema() {
    const svg = document.querySelector('#wfview svg');
    const l = layoutCache.layout;
    const c = svg.cloneNode(true);
    c.setAttribute('width', Math.round(l.width));
    c.setAttribute('height', Math.round(l.height));
    Array.prototype.forEach.call(c.querySelectorAll('[data-ui]'), function (n) { n.remove(); });
    return new XMLSerializer().serializeToString(c);
  }
  function saveSchema(kind, it) {
    if (!document.querySelector('#wfview svg')) return;
    const base = safe(it.name).replace(/\s+/g, '_') + '-schema';
    const text = serializeSchema();
    if (kind === 'svg') { vscode.postMessage({ type: 'saveFile', name: base + '.svg', text: text }); return; }
    const l = layoutCache.layout, k = 2;
    const img = new Image();
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(l.width * k); canvas.height = Math.round(l.height * k);
      const ctx = canvas.getContext('2d');
      ctx.scale(k, k);
      ctx.drawImage(img, 0, 0, l.width, l.height);
      vscode.postMessage({ type: 'saveFile', name: base + '.png', base64: canvas.toDataURL('image/png').split(',')[1] });
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  }

  function select(id) {
    if (id !== selectedId) { wfSel = null; }
    selectedId = id;
    persist();
    Array.prototype.forEach.call(document.querySelectorAll('.row.leaf.selected'), function (r) { r.classList.remove('selected'); });
    const row = document.querySelector('.row.leaf[data-id="' + CSS.escape(id) + '"]');
    if (row) row.classList.add('selected');
    renderDetailPane();
    document.getElementById('detail').scrollTop = 0;
  }

  function allPaths() {
    const out = [];
    (function walk(nodes) { nodes.forEach(function (n) { out.push(n.path); walk(Object.keys(n.folders).map(function (k) { return n.folders[k]; })); }); })(buildTree(items));
    return out;
  }

  function wireShell() {
    const tree = document.getElementById('tree');
    tree.addEventListener('click', function (e) {
      const row = e.target.closest('.row');
      if (!row) return;
      if (row.dataset.id) { select(row.dataset.id); return; }
      const p = row.dataset.path;
      if (filterText) return;
      if (collapsed[p]) delete collapsed[p]; else collapsed[p] = true;
      persist();
      renderTree();
    });
    tree.addEventListener('keydown', function (e) {
      const rows = Array.prototype.slice.call(tree.querySelectorAll('.row.leaf'));
      if (!rows.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      let i = rows.findIndex(function (r) { return r.dataset.id === selectedId; });
      i = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1);
      select(rows[i].dataset.id);
      rows[i].scrollIntoView({ block: 'nearest' });
    });
    const q = document.getElementById('q');
    q.addEventListener('input', function () { filterText = q.value.trim().toLowerCase(); renderTree(); });
    document.getElementById('qs').addEventListener('change', function (e) { searchScripts = e.target.checked; persist(); renderTree(); });

    app.addEventListener('click', function (e) {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const it = byId[selectedId];
      if (act === 'expand') { collapsed = {}; persist(); renderTree(); }
      else if (act === 'collapse') { collapsed = {}; allPaths().forEach(function (p) { collapsed[p] = true; }); persist(); renderTree(); }
      else if (act === 'open-modified') { vscode.postMessage({ type: 'openModified' }); }
      else if (act === 'export') { vscode.postMessage({ type: 'export', folderName: safe((parseProps(pkg.meta)['pkg-name'] || pkg.fileName.replace(/\.package$/i, ''))), files: exportFiles() }); }
      else if (!it) { return; }
      else if (act === 'edit-script') {
        const sc = it.scripts[+b.dataset.idx];
        vscode.postMessage({ type: 'editScript', elementId: it.id, elementType: it.type, elementName: it.type === 'ScriptModule' ? it.module + '.' + it.name : it.name,
          origVersion: it.origVersion, key: sc.key, label: sc.editLabel, lang: sc.lang, code: sc.code });
      }
      else if (act === 'edit-value') {
        const a = it.attributes[+b.dataset.idx];
        vscode.postMessage({ type: 'editValue', elementId: it.id, elementName: it.name, origVersion: it.origVersion, name: a.name, attType: a.type, value: a.value });
      }
      else if (act === 'copy-script') { vscode.postMessage({ type: 'copy', text: it.scripts[+b.dataset.idx].code }); }
      else if (act === 'open-xml') { vscode.postMessage({ type: 'openText', language: it.root ? 'xml' : guessLang(it), content: it.raw.data || '' }); }
      else if (act === 'save-res') { vscode.postMessage({ type: 'saveResource', id: it.id, name: it.name }); }
      else if (act === 'wf-tab') { wfTab = b.dataset.tab; renderDetailPane(); }
      else if (act === 'zoom-in') { setZoom(zoom + 0.15); }
      else if (act === 'zoom-out') { setZoom(zoom - 0.15); }
      else if (act === 'zoom-100') { setZoom(1); }
      else if (act === 'zoom-fit') { const v = document.getElementById('wfview'); if (v && layoutCache.layout) setZoom((v.clientWidth - 2) / layoutCache.layout.width); }
      else if (act === 'save-svg') { saveSchema('svg', it); }
      else if (act === 'save-png') { saveSchema('png', it); }
    });

    // schema: click a step, drag to pan, ctrl/cmd + wheel to zoom
    const detail = document.getElementById('detail');
    let drag = null;
    function pickNode(node) {
      const it = byId[selectedId];
      if (!it) return;
      wfSel = wfSel === node.dataset.item ? null : node.dataset.item;
      const view = document.getElementById('wfview');
      const sl = view.scrollLeft, st = view.scrollTop;
      view.innerHTML = window.PackLensSchema.renderSvg(it, layoutCache.layout, wfSel, true);
      applyZoom();
      view.scrollLeft = sl; view.scrollTop = st;
      renderItemPanel(it);
    }
    detail.addEventListener('pointerdown', function (e) {
      const view = e.target.closest('#wfview');
      if (!view || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, sl: view.scrollLeft, st: view.scrollTop, moved: false, node: e.target.closest('.wf-node'), view: view };
      view.setPointerCapture(e.pointerId);
    });
    detail.addEventListener('pointermove', function (e) {
      if (!drag) return;
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
      if (drag.moved) { drag.view.scrollLeft = drag.sl - (e.clientX - drag.x); drag.view.scrollTop = drag.st - (e.clientY - drag.y); }
    });
    detail.addEventListener('pointerup', function () {
      if (drag && !drag.moved && drag.node) pickNode(drag.node);
      drag = null;
    });
    detail.addEventListener('keydown', function (e) {
      const n = e.target.closest && e.target.closest('.wf-node');
      if (n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pickNode(n); }
    });
    detail.addEventListener('wheel', function (e) {
      if (!(e.ctrlKey || e.metaKey) || !e.target.closest('#wfview')) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 0.9));
    }, { passive: false });

    // resizable split
    const side = app.querySelector('.side');
    const split = app.querySelector('.splitter');
    if (saved.sideWidth) side.style.width = saved.sideWidth + 'px';
    split.addEventListener('mousedown', function (e) {
      e.preventDefault();
      const startX = e.clientX, startW = side.getBoundingClientRect().width;
      function move(ev) { side.style.width = Math.max(200, Math.min(window.innerWidth - 260, startW + ev.clientX - startX)) + 'px'; }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); saved.sideWidth = side.getBoundingClientRect().width; vscode.setState(Object.assign({}, saved, { collapsed: collapsed, searchScripts: searchScripts, selectedId: selectedId })); }
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  function guessLang(it) {
    const m = (it.mime || '') + ' ' + it.name;
    if (/json/i.test(m)) return 'json';
    if (/ya?ml/i.test(m)) return 'yaml';
    if (/xml/i.test(m)) return 'xml';
    if (/html/i.test(m)) return 'html';
    if (/javascript|\.js\b/i.test(m)) return 'javascript';
    if (/\.ps1|powershell/i.test(m)) return 'powershell';
    if (/\.py\b|python/i.test(m)) return 'python';
    if (/\.sh\b|shell/i.test(m)) return 'shellscript';
    return 'plaintext';
  }

  /* ---------- export ---------- */
  function safe(s) { return String(s || 'unnamed').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+$/, '').replace(/^\.+/, '_') || 'unnamed'; }
  function exportFiles() {
    const files = [];
    const used = {};
    function add(p, f) { let q = p, n = 2; while (used[q.toLowerCase()]) { q = p.replace(/(\.[^./]+)?$/, ' (' + n++ + ')$1'); } used[q.toLowerCase()] = 1; f.path = q; files.push(f); }
    items.forEach(function (it) {
      const g = GROUPS.filter(function (x) { return x.key === it.type; })[0] || GROUPS[5];
      const dir = [safe(g.label)].concat(folderPath(it).map(function (s) { return safe(s.name); })).join('/');
      if (it.type === 'ScriptModule') {
        const header = '/**\n * ' + it.module + '/' + it.name + '\n' + (it.description ? ' * ' + it.description.replace(/\n/g, '\n * ') + '\n' : '') +
          it.inputs.map(function (p) { return ' * @param {' + p.type + '} ' + p.name + (p.description ? ' - ' + p.description : ''); }).join('\n') + (it.inputs.length ? '\n' : '') +
          ' * @return {' + (it.returnType || 'void') + '}\n */\n';
        add(dir + '/' + safe(it.name) + '.js', { text: header + (it.script || '') });
      } else if (it.type === 'Workflow') {
        add(dir + '/' + safe(it.name) + '.xml', { text: it.raw.data || '' });
        it.wfItems.forEach(function (w) { if (w.script && w.script.trim()) add(dir + '/' + safe(it.name) + '/' + safe(w.name + ' - ' + w.displayName) + '.js', { text: w.script }); });
      } else if (it.type === 'ResourceElement') {
        add(dir + '/' + safe(it.name), { resourceId: it.id });
      } else {
        add(dir + '/' + safe(it.name) + '.xml', { text: it.raw.data || '' });
      }
    });
    return files;
  }

  /* ---------- messages ---------- */
  window.addEventListener('message', function (e) {
    const msg = e.data || {};
    if (msg.type === 'package') {
      pkg = msg.pkg;
      envs = {};
      pkg.elements.forEach(function (raw) {
        const info = parseProps(raw.info);
        if (info.type === 'ActionEnvironment') envs[raw.id.toLowerCase()] = { name: info.name || raw.id, runtime: info.runtime || '' };
      });
      items = pkg.elements.map(parseElement);
      items.forEach(resolveLanguages);
      byId = {};
      items.forEach(function (i) { byId[i.id] = i; });
      editState = null;
      if (msg.overlay && msg.overlay.edits) {
        Object.keys(msg.overlay.edits).forEach(function (id) {
          const e = msg.overlay.edits[id];
          Object.keys(e.scripts || {}).forEach(function (k) { patchItem(id, { key: k, code: e.scripts[k], version: e.version }, true); });
          Object.keys(e.values || {}).forEach(function (n) { patchItem(id, { valueName: n, value: e.values[n], version: e.version }, true); });
        });
        editState = { target: msg.overlay.target, count: Object.keys(msg.overlay.edits).length };
      }
      if (saved.selectedId && byId[saved.selectedId] && !selectedId) selectedId = saved.selectedId;
      if (selectedId && !byId[selectedId]) selectedId = null;
      renderShell();
    } else if (msg.type === 'edited') {
      editState = { target: msg.target, count: msg.elementCount };
      patchItem(msg.elementId, msg, false);
      renderBanner();
      renderTree();
      const keepScroll = document.getElementById('detail').scrollTop;
      const view = document.getElementById('wfview');
      const sl = view ? view.scrollLeft : 0, st = view ? view.scrollTop : 0;
      if (msg.elementId === selectedId) {
        renderDetailPane();
        document.getElementById('detail').scrollTop = keepScroll;
        const v2 = document.getElementById('wfview');
        if (v2) { v2.scrollLeft = sl; v2.scrollTop = st; }
      }
    } else if (msg.type === 'error') {
      app.innerHTML = '<div class="error"><h2>Could not open this package</h2><p>' + esc(msg.message) + '</p><p class="muted">vRO PackLens reads packages exported from vRealize Orchestrator 7.x, Aria Automation Orchestrator 8.x and VCF Operations Orchestrator 9.x.</p></div>';
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
