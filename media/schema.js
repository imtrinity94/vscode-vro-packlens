/*
 * Workflow schema drawing, ported from vRO Peekage's SchemaDiagram.
 * Items sit at the positions saved in the workflow XML, with the same per-type anchor
 * offsets the Orchestrator client uses. Icons come from wdt4vro (MIT).
 */
(function () {
  'use strict';
  const ICONS = window.VRO_ICONS || {};
  const LABEL_W = 116, ICON = 40, ICON_DECISION = 44, TRIM = 40, MARGIN = 40, STACK_GAP = 88;
  const C = {
    canvas: '#fafcfd', dot: '#cbd4d8', text: '#21333b', blue: '#0079ad', green: '#2e8540',
    switchDefault: '#4CAF50', red: '#c92100', select: 'rgba(0, 124, 187, 0.16)'
  };
  const DECISIONS = { condition: 1, decision: 1, 'custom-condition': 1, 'decision-activity': 1 };
  const PROTOTYPE_ICONS = {};
  ['change-credential', 'sleep', 'wait-until-date', 'wait-custom-event', 'send-custom-event', 'increase-counter', 'decrease-counter',
    'system-log', 'system-warning', 'system-error', 'server-log', 'server-warning', 'server-error', 'system-server-log',
    'system-server-warning', 'system-server-error', 'http-post', 'http-get'].forEach(function (k) { PROTOTYPE_ICONS[k] = 1; });

  function anchor(kind) {
    if (kind === 'start') return { dx: -10, dy: 38 };
    if (kind === 'end') return { dx: -10, dy: 128 };
    if (DECISIONS[kind]) return { dx: 30, dy: 70 };
    return { dx: 30, dy: 48 };
  }

  function iconFor(it) {
    const type = it.type;
    if (type === 'end') return it.endMode === '1' ? 'exception' : 'end';
    if (type === 'task' && it.launchedWorkflowId && it.outBind.some(function (b) { return b.type === 'WorkflowToken' && b.name === 'wfToken'; })) return 'workflow-async';
    const isTask = type === 'task' || type === 'scriptable-task';
    if (isTask && it.module) return 'action';
    if (isTask) {
      const sched = it.inBind.some(function (b) { return b.name === 'workflowScheduleDate'; }) && it.outBind.some(function (b) { return b.name === 'scheduledTask'; });
      if (sched || (it.displayName || '').indexOf('Schedule') >= 0) return 'workflow-schedule';
    }
    if (it.prototypeId && PROTOTYPE_ICONS[it.prototypeId]) return it.prototypeId;
    if (type === 'task') return 'scriptable-task';
    if (type === 'link') return 'workflow';
    if (type === 'custom-condition') return 'condition';
    return ICONS[type] ? type : 'workflow';
  }
  function labelFor(it) { return it.type === 'end' ? '' : (it.displayName || it.name); }

  function wrap(text, max, lines) {
    max = max || 19; lines = lines || 3;
    if (!text) return [];
    const out = [];
    let cur = '';
    text.split(/\s+/).forEach(function (word) {
      let w = word;
      while (w.length > max) { if (cur) { out.push(cur); cur = ''; } out.push(w.slice(0, max)); w = w.slice(max); }
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
      else { out.push(cur); cur = w; }
    });
    if (cur) out.push(cur);
    if (out.length > lines) { const kept = out.slice(0, lines); kept[lines - 1] = kept[lines - 1].slice(0, max - 1) + '…'; return kept; }
    return out;
  }

  function labelRect(label, size) {
    const lines = wrap(label);
    if (!lines.length) return undefined;
    const longest = Math.max.apply(null, lines.map(function (l) { return l.length; }));
    size = size || ICON;
    return { hw: Math.min(LABEL_W, longest * 6.4) / 2, top: size / 2 + 4, bottom: size / 2 + 6 + lines.length * 15 };
  }

  function exitLabel(ux, uy, r) {
    if (!r) return 0;
    let tmin = -Infinity, tmax = Infinity;
    function slab(u, lo, hi) {
      if (Math.abs(u) < 1e-9) { if (0 < lo || 0 > hi) tmin = Infinity; return; }
      const t1 = lo / u, t2 = hi / u;
      tmin = Math.max(tmin, Math.min(t1, t2));
      tmax = Math.min(tmax, Math.max(t1, t2));
    }
    slab(ux, -r.hw, r.hw);
    slab(uy, r.top, r.bottom);
    return tmax > Math.max(tmin, 0) ? tmax + 6 : 0;
  }

  function arrow(x1, y1, x2, y2, fromLabel, toLabel) {
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    if (!len) return '';
    const ux = dx / len, uy = dy / len;
    const t1 = Math.max(TRIM, exitLabel(ux, uy, fromLabel));
    const t2 = Math.max(TRIM, exitLabel(-ux, -uy, toLabel));
    if (len <= t1 + t2 + 8) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      return 'M' + (mx - ux * 4).toFixed(1) + ',' + (my - uy * 4).toFixed(1) + ' L' + (mx + ux * 4).toFixed(1) + ',' + (my + uy * 4).toFixed(1);
    }
    return 'M' + (x1 + ux * t1).toFixed(1) + ',' + (y1 + uy * t1).toFixed(1) + ' L' + (x2 - ux * t2).toFixed(1) + ',' + (y2 - uy * t2).toFixed(1);
  }

  function verticalStretch(items) {
    let f = 1;
    items.forEach(function (a) {
      items.forEach(function (b) {
        const dyRaw = b.y - a.y;
        if (dyRaw <= 0) return;
        const aa = anchor(a.type), ab = anchor(b.type);
        if (Math.abs(b.x + ab.dx - (a.x + aa.dx)) >= LABEL_W) return;
        const need = (STACK_GAP - (ab.dy - aa.dy)) / dyRaw;
        if (need > f) f = need;
      });
    });
    return Math.min(f, 2.5);
  }

  /** wf: { wfItems, rootName, start, errorHandlers } */
  function computeLayout(wf) {
    const items = wf.wfItems.filter(function (i) { return i.x != null && i.y != null && !isNaN(i.x) && !isNaN(i.y); });
    if (!items.length) return null;
    const pos = {};
    const fy = verticalStretch(items);
    const minY0 = Math.min.apply(null, items.map(function (i) { return i.y; }));
    items.forEach(function (it) { const a = anchor(it.type); pos[it.name] = { x: it.x + a.dx, y: minY0 + (it.y - minY0) * fy + a.dy }; });

    const extras = [];
    const root = wf.rootName ? pos[wf.rootName] : undefined;
    if (root) {
      const a = anchor('start');
      const sp = wf.start ? { x: wf.start.x + a.dx, y: wf.start.y + a.dy } : { x: root.x - 80, y: root.y - 40 };
      extras.push({ key: '__start', label: '', icon: 'start', pos: sp });
    }
    (wf.errorHandlers || []).forEach(function (t) {
      const p = pos[t];
      if (p) extras.push({ key: '__eh_' + t, label: 'Error handler', icon: 'error-handler', pos: { x: p.x - 130, y: p.y }, target: t });
    });

    const edges = [];
    items.forEach(function (it) {
      if (it.next && pos[it.next]) {
        const dec = DECISIONS[it.type];
        edges.push({ from: it.name, to: it.next, color: it.type === 'switch' ? C.switchDefault : dec ? C.green : C.blue, marker: dec || it.type === 'switch' ? 'green' : 'blue' });
      }
      if (it.altNext && pos[it.altNext]) edges.push({ from: it.name, to: it.altNext, color: C.red, marker: 'red', dash: '6,4' });
      if (it.catchName && pos[it.catchName]) edges.push({ from: it.name, to: it.catchName, color: C.red, marker: 'red', dash: '6,4' });
      if (it.type === 'switch') (it.conditionTargets || []).forEach(function (t) { if (pos[t]) edges.push({ from: it.name, to: t, color: C.blue, marker: 'blue' }); });
    });

    const all = Object.keys(pos).map(function (k) { return pos[k]; }).concat(extras.map(function (e) { return e.pos; }));
    const minX = Math.min.apply(null, all.map(function (p) { return p.x; })) - LABEL_W / 2;
    const minY = Math.min.apply(null, all.map(function (p) { return p.y; })) - ICON_DECISION / 2;
    all.forEach(function (p) { p.x += MARGIN - minX; p.y += MARGIN - minY; });
    const width = Math.max.apply(null, all.map(function (p) { return p.x; })) + LABEL_W / 2 + MARGIN;
    const height = Math.max.apply(null, all.map(function (p) { return p.y; })) + ICON / 2 + 3 * 15 + MARGIN;
    return { items: items, pos: pos, extras: extras, edges: edges, width: width, height: height };
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function iconUri(name) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(ICONS[name] || ICONS.workflow || ''); }

  /** Returns SVG markup. selected = item name. interactive adds hit areas/selection. */
  function renderSvg(wf, layout, selected, interactive) {
    const FONT = "'Segoe UI', Arial, sans-serif";
    const byName = {};
    layout.items.forEach(function (i) { byName[i.name] = i; });
    function lrect(name) { const it = byName[name]; return it ? labelRect(labelFor(it), DECISIONS[it.type] ? ICON_DECISION : ICON) : undefined; }

    function node(key, label, icon, p, it) {
      const lines = wrap(label);
      const size = it && DECISIONS[it.type] ? ICON_DECISION : ICON;
      const textTop = size / 2 + 16;
      const boxH = size / 2 + 12 + Math.max(1, lines.length) * 15 + 6;
      const box = { x: -LABEL_W / 2 - 4, y: -size / 2 - 8, w: LABEL_W + 8, h: boxH + size / 2 + 2 };
      let g = '<g transform="translate(' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ')"' + (it ? ' class="wf-node" data-item="' + esc(it.name) + '"' + (interactive ? ' tabindex="0" role="button"' : '') : '') + '>';
      if (it) g += '<title>' + esc((label || it.type) + ' — ' + it.type + (it.module ? ' · ' + it.module : '') + ' (' + it.name + ')') + '</title>';
      if (it && interactive && selected === it.name) g += '<rect data-ui="1" x="' + (box.x - 2) + '" y="' + (box.y - 2) + '" width="' + (box.w + 4) + '" height="' + (box.h + 4) + '" rx="9" fill="' + C.select + '" stroke="' + C.blue + '" stroke-width="1.5"/>';
      if (it && interactive) g += '<rect data-ui="1" class="wf-hit" x="' + box.x + '" y="' + box.y + '" width="' + box.w + '" height="' + box.h + '" rx="8" fill="transparent"/>';
      g += '<image href="' + iconUri(icon) + '" x="' + (-size / 2) + '" y="' + (-size / 2) + '" width="' + size + '" height="' + size + '"/>';
      if (lines.length) {
        g += '<text x="0" y="' + textTop + '" text-anchor="middle" font-size="12" font-weight="500" fill="' + C.text + '" font-family="' + FONT + '">' +
          lines.map(function (l, i) { return '<tspan x="0" dy="' + (i === 0 ? 0 : 15) + '">' + esc(l) + '</tspan>'; }).join('') + '</text>';
      }
      return g + '</g>';
    }

    let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + layout.width.toFixed(0) + '" height="' + layout.height.toFixed(0) + '" viewBox="0 0 ' + layout.width.toFixed(0) + ' ' + layout.height.toFixed(0) + '">';
    s += '<defs><pattern id="wf-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1.2" fill="' + C.dot + '"/></pattern>';
    [['blue', C.blue], ['green', C.green], ['red', C.red]].forEach(function (m) {
      s += '<marker id="wf-arr-' + m[0] + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" markerUnits="userSpaceOnUse" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="' + m[1] + '"/></marker>';
    });
    s += '</defs><rect width="100%" height="100%" fill="' + C.canvas + '"/><rect width="100%" height="100%" fill="url(#wf-dots)"/>';
    layout.edges.forEach(function (e) {
      const a = layout.pos[e.from], b = layout.pos[e.to];
      s += '<path d="' + arrow(a.x, a.y, b.x, b.y, lrect(e.from), lrect(e.to)) + '" stroke="' + e.color + '" stroke-width="1"' + (e.dash ? ' stroke-dasharray="' + e.dash + '"' : '') + ' fill="none" marker-end="url(#wf-arr-' + e.marker + ')"/>';
    });
    layout.extras.forEach(function (x) {
      const target = x.target || wf.rootName;
      const to = target ? layout.pos[target] : undefined;
      if (!to) return;
      s += '<path d="' + arrow(x.pos.x, x.pos.y, to.x, to.y, labelRect(x.label), lrect(target)) + '" stroke="' + C.blue + '" stroke-width="1" fill="none" marker-end="url(#wf-arr-blue)"/>';
    });
    layout.extras.forEach(function (x) { s += node(x.key, x.label, x.icon, x.pos); });
    layout.items.forEach(function (it) { s += node(it.name, labelFor(it), iconFor(it), layout.pos[it.name], it); });
    return s + '</svg>';
  }

  window.PackLensSchema = { computeLayout: computeLayout, renderSvg: renderSvg, iconFor: iconFor, iconUri: iconUri };
})();
