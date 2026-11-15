import { h, fmt, icon, sourceBadge, mutationBadge, finalBrief, stepSummary, wordDiff, jsonLineDiff, fieldDiff, fieldsTable, deepEqual, hasCanary, withCanary } from '../util.js';
import { loadRun } from '../data.js';

const VOLATILE = new Set(['id', 'created', 'response_time', 'system_fingerprint', 'ts']);
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) if (!VOLATILE.has(k)) o[k] = stable(v[k]);
    return o;
  }
  return v;
}

function defaultPair(data) {
  const forks = data.runs.filter(r => r.mode === 'fork' && r.parent && data.byId.has(r.parent));
  const pick = forks.find(r => r.mutation === 'poison' && r.followed_injection) || forks.find(r => r.mutation === 'poison') || forks[0];
  if (pick) return [pick.parent, pick.run_id];
  const rs = data.runs;
  return [rs[0]?.run_id, rs[1]?.run_id || rs[0]?.run_id];
}

export async function renderDiff(root, data, _parts, params) {
  let a = params.get('a'), b = params.get('b');
  if (!a || !b) {
    const [da, db] = defaultPair(data);
    a = a || da; b = b || db;
  }
  if (!a || !b) { root.append(h('div', { class: 'empty' }, 'Need at least one run.')); return; }

  const go = (na, nb) => { location.hash = `#/diff?a=${encodeURIComponent(na)}&b=${encodeURIComponent(nb)}`; };
  const selA = runSelect(data, a, v => go(v, b), 'Run A');
  const selB = runSelect(data, b, v => go(a, v), 'Run B');
  root.append(
    h('div', { class: 'page-head' }, h('h1', null, 'Branch diff'), h('span', { class: 'sub' }, 'Steps aligned by index. Volatile ids and timestamps are ignored.')),
    h('div', { class: 'diff-pick' },
      h('label', null, 'A', selA),
      h('button', { class: 'btn', title: 'Swap', 'aria-label': 'Swap A and B', style: { alignSelf: 'end' }, onclick: () => go(b, a) }, '⇄'),
      h('label', null, 'B', selB)));

  let A, B;
  try { [A, B] = await Promise.all([loadRun(a), loadRun(b)]); }
  catch (e) { root.append(h('div', { class: 'error-box' }, `Could not load cassettes: ${e.message}`)); return; }

  const forkAt = B.parent === a ? B.fork_at : A.parent === b ? A.fork_at : (B.fork_at ?? A.fork_at ?? null);
  const forkRun = B.parent === a ? B : A.parent === b ? A : (B.fork_at != null ? B : A);
  const n = Math.max(A.steps.length, B.steps.length);
  const rows = [];
  let firstDiv = null;
  for (let i = 0; i < n; i++) {
    const sa = A.steps[i], sb = B.steps[i];
    let st;
    if (!sa || !sb) st = sa ? 'only A' : 'only B';
    else {
      const reqSame = sa.fingerprint && sb.fingerprint ? sa.fingerprint === sb.fingerprint : deepEqual(stable(sa.request), stable(sb.request));
      const resSame = deepEqual(stable(sa.response), stable(sb.response)) && (sa.status ?? 200) === (sb.status ?? 200);
      st = reqSame && resSame ? 'same' : !reqSame ? 'request differs' : 'response differs';
    }
    const isFork = forkAt != null && i === forkAt;
    if (firstDiv == null && st !== 'same' && !isFork && (forkAt == null || i > forkAt || st === 'request differs')) firstDiv = i;
    rows.push({ i, sa, sb, st, isFork });
  }
  const wanted = params.has('step') ? Number(params.get('step')) : (firstDiv ?? forkAt ?? 0);
  let selected = Math.min(Math.max(0, wanted), Math.max(0, n - 1));

  // summary callout
  const parts = [];
  if (forkAt != null) parts.push(h('span', null, 'Fork point ', h('b', null, `step ${forkAt}`), ' ', mutationBadge(forkRun.mutation?.type)));
  if (firstDiv != null) {
    const r = rows[firstDiv];
    const fields = r.sa && r.sb ? fieldDiff(stable(r.sa.request), stable(r.sb.request)).map(d => d.path) : [];
    parts.push(h('span', null, 'First divergence ', h('b', null, `step ${firstDiv}`), ` (${r.st}${fields.length ? ': ' + fields.slice(0, 3).join(', ') + (fields.length > 3 ? ', …' : '') : ''})`));
  } else parts.push(h('span', null, forkAt != null ? 'Agent behaviour did not diverge after the fork.' : 'No differences.'));
  parts.push(h('span', { class: 'muted' }, `${A.steps.length} vs ${B.steps.length} steps`));
  root.append(h('div', { class: 'callout warn' }, h('div', { class: 'row', style: { gap: '16px' } }, parts)));

  // alignment table
  const tbody = h('tbody');
  const detail = h('div');
  const drawRows = () => tbody.replaceChildren(...rows.map(r => {
    const tr = h('tr', {
      class: [r.i === selected ? 'sel' : '', r.isFork ? 'fork' : '', r.i === firstDiv ? 'first' : ''].join(' '),
      tabindex: 0,
      onclick: () => select(r.i),
      onkeydown: e => { if (e.key === 'Enter') select(r.i); },
    },
      h('td', { class: 'i' }, r.i),
      h('td', null, cell(r.sa)),
      h('td', { class: 'mid' }, statusBadge(r)),
      h('td', null, cell(r.sb)));
    return tr;
  }));
  const select = i => {
    selected = i;
    history.replaceState(null, '', `#/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&step=${i}`);
    drawRows();
    drawDetail();
  };
  const drawDetail = () => detail.replaceChildren(stepDetail(rows[selected], a, b));
  drawRows();
  drawDetail();

  root.append(
    h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', null, 'Steps'), h('span', { class: 'right' }, 'click a row to compare')),
      h('div', { class: 'card-b flush scroll-x' }, h('table', { class: 'align' },
        h('colgroup', null, h('col', { style: { width: '40px' } }), h('col'), h('col', { style: { width: '130px' } }), h('col')),
        h('thead', null, h('tr', null, h('td', { class: 'i muted' }, '#'),
          h('td', { class: 'muted' }, h('a', { href: `#/run/${encodeURIComponent(a)}`, class: 'mono' }, a)),
          h('td', { class: 'mid muted' }, ''),
          h('td', { class: 'muted' }, h('a', { href: `#/run/${encodeURIComponent(b)}`, class: 'mono' }, b)))),
        tbody))),
    h('div', { class: 'section' }, detail));

  // final briefs
  const ba = finalBrief(A), bb = finalBrief(B);
  const [la, lb] = ba != null && bb != null ? wordDiff(ba, bb) : [null, null];
  const ra = data.byId.get(a), rb = data.byId.get(b);
  root.append(h('div', { class: 'section' },
    h('h2', null, 'Final brief'),
    h('div', { class: 'sbs', style: { marginTop: '10px' } },
      briefCard('A', a, ra, ba, la), briefCard('B', b, rb, bb, lb))));
}

function briefCard(label, id, row, text, frag) {
  return h('div', { class: 'card' },
    h('div', { class: 'card-h' }, h('span', { class: 'badge' }, label),
      h('span', { class: 'mono small', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, id),
      h('span', { class: 'right' }, hasCanary(text) ? h('span', { class: 'badge bad' }, 'canary') : null,
        row?.success === true ? h('span', { class: 'badge ok' }, 'pass') : row?.success === false ? h('span', { class: 'badge bad' }, 'fail') : null)),
    text == null ? h('div', { class: 'card-b muted' }, 'No brief.') : h('div', { class: 'brief' }, frag || withCanary(text)));
}

function runSelect(data, value, onchange, label) {
  const groups = new Map();
  for (const r of data.runs) {
    const k = `${r.task} / ${r.agent}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const sel = h('select', { class: 'sel', 'aria-label': label, onchange: e => onchange(e.target.value) },
    [...groups.entries()].map(([k, rs]) => h('optgroup', { label: k },
      rs.map(r => h('option', { value: r.run_id, selected: r.run_id === value }, r.run_id)))));
  if (!data.byId.has(value)) sel.prepend(h('option', { value, selected: true }, value));
  return sel;
}

function cell(st) {
  if (!st) return h('span', { class: 'missing' }, 'no step');
  const err = (st.status ?? 200) >= 400;
  const txt = stepSummary(st);
  return h('div', { class: 'cell' },
    h('span', { style: { color: err ? 'var(--bad)' : st.kind === 'llm' ? 'var(--llm)' : 'var(--relay)', display: 'inline-flex' } }, err ? icon.err() : st.kind === 'llm' ? icon.llm() : icon.relay()),
    sourceBadge(st.source),
    h('span', { class: 'txt', title: txt }, withCanary(txt)));
}

function statusBadge(r) {
  if (r.isFork) return h('span', { class: 'badge mutated' }, 'fork point');
  const cls = { same: '', 'request differs': 'warn', 'response differs': 'accent', 'only A': 'bad', 'only B': 'bad' }[r.st] ?? '';
  return h('span', { class: `badge ${cls}` }, r.st === 'same' ? '=' : r.st);
}

function stepDetail(r, a, b) {
  if (!r) return h('div', { class: 'empty' }, 'No step.');
  const { sa, sb } = r;
  const req = jsonLineDiff(sa ? stable(sa.request) : undefined, sb ? stable(sb.request) : undefined);
  const res = jsonLineDiff(sa ? stable(sa.response) : undefined, sb ? stable(sb.response) : undefined);
  const fields = sa && sb ? fieldDiff(stable(sa.request), stable(sb.request)) : [];
  const meta = st => st ? h('span', { class: 'small muted' },
    `${st.kind === 'llm' ? 'LLM' : 'search'} · HTTP ${st.status ?? 200} · ${fmt.int((st.tokens?.prompt || 0) + (st.tokens?.completion || 0))} tok · ${fmt.usd(st.cost_usd)} · ${fmt.ms(st.latency_ms)}`) : h('span', { class: 'small muted' }, 'no step');
  return h('div', null,
    h('div', { class: 'row', style: { marginBottom: '10px' } },
      h('h2', null, `Step ${r.i}`), statusBadge(r),
      h('span', { class: 'spacer' }),
      sa ? h('a', { class: 'btn', href: `#/run/${encodeURIComponent(a)}?step=${r.i}` }, 'Open in A') : null,
      sb ? h('a', { class: 'btn', href: `#/run/${encodeURIComponent(b)}?step=${r.i}` }, 'Open in B') : null),
    h('div', { class: 'sbs', style: { marginBottom: '6px' } }, h('div', null, h('span', { class: 'badge' }, 'A'), ' ', meta(sa)), h('div', null, h('span', { class: 'badge' }, 'B'), ' ', meta(sb))),
    h('div', { class: 'pane-h', style: { marginTop: '12px' } }, 'Request', h('span', { class: 'right' }, req.changed ? `${req.changed} lines differ` : 'identical')),
    req.el,
    fields.length ? h('details', { style: { marginTop: '8px' } },
      h('summary', { class: 'small', style: { cursor: 'pointer', color: 'var(--fg-2)' } }, `${fields.length} changed request fields`),
      h('div', { class: 'card', style: { marginTop: '6px' } }, fieldsTable(fields, { labels: ['A', 'B'] }))) : null,
    h('div', { class: 'pane-h', style: { marginTop: '16px' } }, 'Response', h('span', { class: 'right' }, res.changed ? `${res.changed} lines differ` : 'identical')),
    res.el);
}
