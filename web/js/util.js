// DOM helpers, formatting, and small shared widgets.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const icon = {
  llm: () => svgIcon('M8 1.5l1.6 3.9 3.9 1.6-3.9 1.6L8 12.5 6.4 8.6 2.5 7l3.9-1.6z M12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z'),
  relay: () => svgIcon('M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z M10.3 10.3l3.2 3.2', true),
  err: () => svgIcon('M8 2l6.5 11.5h-13z M8 6.5v3 M8 11.5v.5', true),
};
function svgIcon(d, stroke) {
  const el = s('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
    s('path', stroke
      ? { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
      : { d, fill: 'currentColor' }));
  return el;
}

// ---------- formatting
export const fmt = {
  pct(v) { return v == null || isNaN(v) ? '–' : `${Math.round(v * 100)}%`; },
  num(v, d = 0) { return v == null || isNaN(v) ? '–' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }); },
  int(v) { return v == null || isNaN(v) ? '–' : Math.round(v).toLocaleString('en-US'); },
  usd(v) {
    if (v == null || isNaN(v)) return '–';
    if (v === 0) return '$0.00';
    if (Math.abs(v) < 0.01) return '$' + v.toFixed(4);
    return '$' + v.toFixed(2);
  },
  ms(v) {
    if (v == null || isNaN(v)) return '–';
    if (v < 1000) return `${Math.round(v)} ms`;
    if (v < 60000) return `${(v / 1000).toFixed(1)} s`;
    return `${Math.floor(v / 60000)}m ${Math.round((v % 60000) / 1000)}s`;
  },
  tokens(v) {
    if (v == null || isNaN(v)) return '–';
    if (v >= 10000) return (v / 1000).toFixed(1) + 'k';
    return Math.round(v).toLocaleString('en-US');
  },
  p(v) {
    if (v == null || isNaN(v)) return '–';
    if (v < 0.001) return '< 0.001';
    return v.toFixed(3);
  },
  signed(v) { return v == null || isNaN(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(Math.round(v * 100)) + ' pp'; },
};

export const VARIANT_LABEL = {
  base: 'base', poison: 'poison', outage: 'outage', model_swap: 'model swap',
  tool_error: 'tool error', edit: 'edit', replay: 'replay',
};
export const variantLabel = v => VARIANT_LABEL[v] || v || '–';

export function mutationBadge(type) {
  if (!type) return null;
  return h('span', { class: `badge m-${type}` }, variantLabel(type));
}
export function sourceBadge(src) {
  return h('span', { class: `badge ${src || ''}` }, src || '–');
}

// ---------- canary highlighting
let canary = 'Initech';
export function setCanary(c) { if (c) canary = c; }
export function getCanary() { return canary; }

/** Text node(s) with the canary word wrapped in a red mark. */
export function withCanary(text) {
  text = String(text ?? '');
  if (!canary) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  const re = new RegExp(escapeRe(canary), 'gi');
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(h('mark', { class: 'canary', title: 'Poison canary' }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}
export function hasCanary(text) {
  return !!canary && typeof text === 'string' && text.toLowerCase().includes(canary.toLowerCase());
}
const escapeRe = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- step helpers
export function finalBrief(cassette) {
  const b = cassette?.bench?.brief ?? cassette?.brief;
  if (typeof b === 'string' && b.trim()) return b;
  const steps = cassette?.steps || [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const st = steps[i];
    if (st.kind !== 'llm') continue;
    const msg = st.response?.choices?.[0]?.message;
    if (msg && typeof msg.content === 'string' && msg.content.trim()) return msg.content;
  }
  return null;
}

export function stepSummary(st) {
  if (!st) return '';
  if ((st.status ?? 200) >= 400) {
    const m = st.response?.error?.message || st.response?.message || '';
    return `HTTP ${st.status}${m ? ' · ' + m : ''}`;
  }
  if (st.kind === 'relay') {
    const q = st.request?.query ?? '';
    const n = st.response?.results?.length;
    return `search "${q}"${n != null ? ` → ${n} results` : ''}`;
  }
  const msg = st.response?.choices?.[0]?.message;
  if (msg?.tool_calls?.length) {
    return msg.tool_calls.map(tc => {
      let args = tc.function?.arguments ?? '';
      try { const a = JSON.parse(args); args = a.query ? `"${a.query}"` : JSON.stringify(a); } catch { /* raw */ }
      return `${tc.function?.name || 'tool'}(${args})`;
    }).join(', ');
  }
  if (typeof msg?.content === 'string') return msg.content.replace(/\s+/g, ' ');
  return '';
}

export function stepTokens(st) {
  const t = st?.tokens || {};
  return (t.prompt || 0) + (t.completion || 0);
}

export function shortModel(m) {
  if (!m) return '';
  return m.includes('/') ? m.split('/').slice(1).join('/') : m;
}

export function shortFp(fp) {
  if (!fp) return '–';
  const x = String(fp).replace(/^sha256:/, '');
  return x.slice(0, 10);
}

// ---------- JSON viewer
const TRUNC = 180;

export function jsonView(value, { openDepth = 3 } = {}) {
  return h('div', { class: 'json' }, node(value, null, 0, openDepth, true));
}

function node(v, key, depth, openDepth, last) {
  const keyEl = key != null ? [h('span', { class: 'k' }, typeof key === 'number' ? '' : JSON.stringify(key)), typeof key === 'number' ? null : h('span', { class: 'p' }, ': ')] : [];
  const comma = last ? '' : ',';
  if (v && typeof v === 'object') {
    const isArr = Array.isArray(v);
    const entries = isArr ? v.map((x, i) => [i, x]) : Object.entries(v);
    const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return h('div', { class: 'kv' }, keyEl, h('span', { class: 'p' }, o + c + comma));
    const det = h('details', depth < openDepth ? { open: true } : null);
    det.appendChild(h('summary', null, keyEl, h('span', { class: 'p' }, o),
      h('span', { class: 'count' }, isArr ? `${entries.length} items` : `${entries.length} keys`)));
    // render children lazily on first open to keep large cassettes fast
    const fill = () => {
      if (det.dataset.filled) return;
      det.dataset.filled = '1';
      entries.forEach(([k, x], idx) => det.appendChild(node(x, k, depth + 1, openDepth, idx === entries.length - 1)));
      det.appendChild(h('div', { class: 'p', style: { marginLeft: '-14px' } }, '  ' + c + comma));
    };
    if (det.open) fill(); else det.addEventListener('toggle', fill, { once: true });
    return det;
  }
  return h('div', { class: 'kv' }, keyEl, scalar(v), h('span', { class: 'p' }, comma));
}

function scalar(v) {
  if (typeof v === 'string') {
    // JSON strings that contain JSON (tool args, tool results) are shown as is but truncated
    if (v.length <= TRUNC) return h('span', { class: 's' }, '"', withCanary(v), '"');
    const span = h('span', { class: 's' });
    const short = () => {
      span.replaceChildren('"', withCanary(v.slice(0, TRUNC)), '…"',
        h('button', { class: 'more', onclick: e => { e.stopPropagation(); full(); } }, `+${(v.length - TRUNC).toLocaleString()} chars`));
    };
    const full = () => {
      span.replaceChildren('"', withCanary(v), '"',
        h('button', { class: 'more', onclick: e => { e.stopPropagation(); short(); } }, 'less'));
    };
    short();
    return span;
  }
  if (typeof v === 'number') return h('span', { class: 'num' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'b' }, String(v));
  return h('span', { class: 'nl' }, 'null');
}

// ---------- diffs
/** LCS-based diff of two token arrays. Returns [{op:'eq'|'del'|'add', a?, b?}] */
export function lcsDiff(A, B) {
  const n = A.length, m = B.length;
  // trim common prefix/suffix to keep the table small
  let pre = 0;
  while (pre < n && pre < m && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && A[n - 1 - suf] === B[m - 1 - suf]) suf++;
  const a = A.slice(pre, n - suf), b = B.slice(pre, m - suf);
  const out = [];
  for (let i = 0; i < pre; i++) out.push({ op: 'eq', a: A[i], b: B[i] });
  if (a.length * b.length > 4_000_000) {
    a.forEach(x => out.push({ op: 'del', a: x }));
    b.forEach(x => out.push({ op: 'add', b: x }));
  } else {
    const W = b.length + 1;
    const dp = new Uint32Array((a.length + 1) * W);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { out.push({ op: 'eq', a: a[i], b: b[j] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) out.push({ op: 'del', a: a[i++] });
      else out.push({ op: 'add', b: b[j++] });
    }
    while (i < a.length) out.push({ op: 'del', a: a[i++] });
    while (j < b.length) out.push({ op: 'add', b: b[j++] });
  }
  for (let i = n - suf; i < n; i++) out.push({ op: 'eq', a: A[i], b: B[i - n + m] });
  return out;
}

/** Word-level diff rendered as two fragments (left with deletions, right with additions). */
export function wordDiff(a, b) {
  const tok = t => String(t ?? '').match(/\s+|[^\s]+/g) || [];
  const ops = lcsDiff(tok(a), tok(b));
  const L = document.createDocumentFragment(), R = document.createDocumentFragment();
  for (const o of ops) {
    if (o.op === 'eq') { L.appendChild(withCanary(o.a)); R.appendChild(withCanary(o.b)); }
    else if (o.op === 'del') L.appendChild(/\S/.test(o.a) ? h('span', { class: 'wd-del' }, withCanary(o.a)) : document.createTextNode(o.a));
    else R.appendChild(/\S/.test(o.b) ? h('span', { class: 'wd-add' }, withCanary(o.b)) : document.createTextNode(o.b));
  }
  return [L, R];
}

/** Side-by-side line diff of two JSON values (pretty-printed). */
export function jsonLineDiff(a, b, { context = 3 } = {}) {
  const pa = a === undefined ? [] : prettyLines(a);
  const pb = b === undefined ? [] : prettyLines(b);
  const ops = lcsDiff(pa, pb);
  // pair up adjacent del/add runs into rows
  const rows = [];
  let la = 0, lb = 0;
  for (let k = 0; k < ops.length;) {
    if (ops[k].op === 'eq') { rows.push({ t: 'eq', a: ops[k].a, b: ops[k].b, na: ++la, nb: ++lb }); k++; continue; }
    const dels = [], adds = [];
    while (k < ops.length && ops[k].op !== 'eq') { (ops[k].op === 'del' ? dels : adds).push(ops[k]); k++; }
    const n = Math.max(dels.length, adds.length);
    for (let x = 0; x < n; x++) {
      rows.push({ t: 'ch', a: dels[x]?.a, b: adds[x]?.b, na: dels[x] ? ++la : null, nb: adds[x] ? ++lb : null });
    }
  }
  const changed = rows.map(r => r.t !== 'eq');
  const near = rows.map((_, i) => {
    for (let d = -context; d <= context; d++) if (changed[i + d]) return true;
    return false;
  });
  const tbody = h('tbody');
  let i = 0;
  while (i < rows.length) {
    if (!near[i]) {
      let j = i;
      while (j < rows.length && !near[j]) j++;
      const hidden = rows.slice(i, j);
      const fold = h('tr', { class: 'fold' }, h('td', { colspan: 4 }, `${hidden.length} unchanged lines`));
      fold.addEventListener('click', () => {
        const frag = document.createDocumentFragment();
        hidden.forEach(r => frag.appendChild(diffRow(r)));
        fold.replaceWith(frag);
      });
      tbody.appendChild(fold);
      i = j;
      continue;
    }
    tbody.appendChild(diffRow(rows[i]));
    i++;
  }
  if (!rows.length) tbody.appendChild(h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'empty')));
  const nChanged = changed.filter(Boolean).length;
  const el = h('div', { class: 'ldiff' }, h('table', null,
    h('colgroup', null, h('col', { style: { width: '40px' } }), h('col'), h('col', { style: { width: '40px' } }), h('col')),
    tbody));
  return { el, changed: nChanged };
}

function diffRow(r) {
  if (r.t === 'eq') {
    return h('tr', null, h('td', { class: 'ln' }, r.na), h('td', null, withCanary(r.a)), h('td', { class: 'ln' }, r.nb), h('td', null, withCanary(r.b)));
  }
  let left = r.a, right = r.b;
  let lf = null, rf = null;
  if (left != null && right != null) [lf, rf] = wordDiff(left, right);
  return h('tr', null,
    h('td', { class: 'ln' }, r.na ?? ''),
    left == null ? h('td', { class: 'gap' }) : h('td', { class: 'del' }, lf || withCanary(left)),
    h('td', { class: 'ln' }, r.nb ?? ''),
    right == null ? h('td', { class: 'gap' }) : h('td', { class: 'add' }, rf || withCanary(right)));
}

function prettyLines(v) {
  return JSON.stringify(v, null, 2).split('\n');
}

/** Field-level diff of two JSON values: [{path, expected, got}] */
export function fieldDiff(a, b, path = '', out = []) {
  if (out.length > 200) return out;
  if (a === b) return out;
  const ta = kind(a), tb = kind(b);
  if (ta !== tb || (ta !== 'obj' && ta !== 'arr')) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: path || '(root)', expected: a, got: b });
    return out;
  }
  if (ta === 'arr') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) fieldDiff(a[i], b[i], `${path}[${i}]`, out);
  } else {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) fieldDiff(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}
const kind = v => Array.isArray(v) ? 'arr' : v && typeof v === 'object' ? 'obj' : typeof v;

export function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function fieldValue(v) {
  if (v === undefined) return h('span', { class: 'muted' }, '(absent)');
  if (typeof v === 'string') return withCanary(v);
  return document.createTextNode(JSON.stringify(v, null, 2));
}

export function fieldsTable(diffs, { labels = ['Expected', 'Got'] } = {}) {
  if (!diffs.length) return h('div', { class: 'muted small', style: { padding: '10px' } }, 'No field differences.');
  return h('div', { class: 'scroll-x' }, h('table', { class: 'fields' },
    h('thead', null, h('tr', null, h('th', { style: { width: '24%' } }, 'Field'), h('th', null, labels[0]), h('th', null, labels[1]))),
    h('tbody', null, diffs.map(d => {
      let e, g;
      if (typeof d.expected === 'string' && typeof d.got === 'string') [e, g] = wordDiff(d.expected, d.got);
      return h('tr', null, h('td', { class: 'path' }, d.path),
        h('td', { class: 'exp' }, e || fieldValue(d.expected)),
        h('td', { class: 'got' }, g || fieldValue(d.got)));
    }))));
}
