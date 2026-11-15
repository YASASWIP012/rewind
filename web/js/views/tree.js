import { h, s, fmt, mutationBadge, variantLabel } from '../util.js';
import { loadRun, variantRank } from '../data.js';
import { outcome } from './overview.js';

const COL = 22, ROW = 30, R = 5, PAD = 12;
const LANE_COLOR = {
  base: 'var(--fg-2)', poison: 'var(--bad)', outage: 'var(--warn)', tool_error: 'var(--warn)',
  model_swap: 'var(--violet)', edit: 'var(--accent)', replay: 'var(--fg-3)', fork: 'var(--accent)',
};
const laneColor = r => LANE_COLOR[r.mode === 'replay' ? 'replay' : r.mutation || r.variant] || 'var(--accent)';

export function renderTree(root, data, _parts, params) {
  const f = { agent: params.get('agent') || '', task: params.get('task') || '', variant: params.get('variant') || '' };
  const body = h('div');
  const variants = [...new Set(data.runs.map(r => r.variant))].filter(v => v !== 'base').sort((a, b) => variantRank(a) - variantRank(b));
  const setParam = (k, v) => {
    f[k] = v;
    const q = new URLSearchParams(Object.entries(f).filter(([, x]) => x));
    history.replaceState(null, '', `#/tree${q.toString() ? '?' + q : ''}`);
    draw();
  };
  const sel = (k, opts, label) => h('select', { class: 'sel', 'aria-label': label, onchange: e => setParam(k, e.target.value) },
    h('option', { value: '' }, `All ${label}`),
    opts.map(o => h('option', { value: o, selected: f[k] === o }, k === 'variant' ? variantLabel(o) : o)));

  root.append(
    h('div', { class: 'page-head' }, h('h1', null, 'Run tree'), h('span', { class: 'sub' }, 'Each fork branches off its parent at the mutated step.')),
    h('div', { class: 'filters' },
      sel('agent', data.agents, 'agents'), sel('task', data.tasks, 'tasks'), sel('variant', variants, 'branches'),
      h('span', { class: 'spacer' }),
      legend()),
    body);

  function draw() {
    body.replaceChildren();
    const tasks = data.tasks.filter(t => !f.task || t === f.task);
    for (const task of tasks) {
      const sec = h('div', { class: 'tree-task' }, h('h2', null, task, h('span', { class: 'muted small' }, 'task')));
      let any = false;
      for (const agent of data.agents.filter(a => !f.agent || a === f.agent)) {
        const runs = data.runs.filter(r => r.task === task && r.agent === agent);
        const roots = runs.filter(r => !r.parent || !data.byId.has(r.parent));
        for (const rt of roots) {
          const kids = runs.filter(r => r.parent === rt.run_id && (!f.variant || r.variant === f.variant));
          sec.append(treeBlock(rt, kids, agent));
          any = true;
        }
      }
      if (any) body.append(sec);
    }
    if (!body.childNodes.length) body.append(h('div', { class: 'empty' }, 'No runs match.'));
  }
  draw();
}

function legend() {
  const sw = (shape, color, label, extra = {}) => h('span', null,
    s('svg', { width: 12, height: 12, viewBox: '0 0 12 12' },
      s('rect', { x: 1, y: 1, width: 10, height: 10, rx: shape === 'c' ? 5 : 2, fill: extra.hollow ? 'var(--bg)' : color, stroke: color, 'stroke-width': 1.5 })),
    label);
  return h('div', { class: 'legend' },
    sw('c', 'var(--llm)', 'LLM call'), sw('s', 'var(--relay)', 'search'),
    sw('c', 'var(--fg-3)', 'replayed', { hollow: true }), sw('c', 'var(--violet)', 'mutated'), sw('c', 'var(--warn)', 'diverged'));
}

function treeBlock(base, kids, agent) {
  kids = [...kids].sort((a, b) =>
    (a.mode === 'replay') - (b.mode === 'replay') || (a.fork_at ?? 0) - (b.fork_at ?? 0) ||
    variantRank(a.variant) - variantRank(b.variant) || (a.repeat ?? 0) - (b.repeat ?? 0) || a.run_id.localeCompare(b.run_id));
  const lanes = [base, ...kids];
  const maxSteps = Math.max(1, ...lanes.map(r => r.steps || 0));
  const W = PAD * 2 + (maxSteps - 1) * COL;
  const H = ROW * (lanes.length + 1);
  const x = i => PAD + i * COL;
  const y = lane => ROW * (lane + 1) + ROW / 2;

  const svg = s('svg', { width: W, height: H, role: 'img', 'aria-label': `Run tree for ${base.run_id}` });
  // header: step numbers
  for (let i = 0; i < maxSteps; i++) {
    svg.append(s('text', { x: x(i), y: ROW / 2 + 4, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--fg-3)', 'font-family': 'var(--mono)' }, i));
  }
  const edges = s('g'), nodes = s('g');
  svg.append(edges, nodes);
  const nodeRefs = new Map();
  const rowEls = [];

  const addNode = (run, lane, i, opts) => {
    const color = opts.color;
    const el = s('rect', {
      class: 'node', x: x(i) - R, y: y(lane) - R, width: R * 2, height: R * 2, rx: R,
      fill: opts.hollow ? 'var(--bg)' : color, stroke: color, 'stroke-width': 1.5,
      tabindex: 0, role: 'link', 'aria-label': `${run.run_id} step ${i}`,
      onclick: e => { e.stopPropagation(); location.hash = `#/run/${encodeURIComponent(run.run_id)}?step=${i}`; },
      onkeydown: e => { if (e.key === 'Enter') location.hash = `#/run/${encodeURIComponent(run.run_id)}?step=${i}`; },
      onmouseenter: () => rowEls[lane]?.classList.add('hl'),
      onmouseleave: () => rowEls[lane]?.classList.remove('hl'),
    }, s('title', null, `${run.run_id} · step ${i}`));
    nodes.append(el);
    if (!nodeRefs.has(run.run_id)) nodeRefs.set(run.run_id, []);
    nodeRefs.get(run.run_id)[i] = el;
    return el;
  };

  // base lane
  const n0 = base.steps || 0;
  if (n0 > 1) edges.append(s('line', { x1: x(0), y1: y(0), x2: x(n0 - 1), y2: y(0), stroke: laneColor(base), 'stroke-width': 2 }));
  for (let i = 0; i < n0; i++) addNode(base, 0, i, { color: 'var(--fg-2)' });

  kids.forEach((r, k) => {
    const lane = k + 1;
    const color = laneColor(r);
    const n = r.steps || 0;
    const isReplay = r.mode === 'replay';
    const from = isReplay ? 0 : Math.max(0, r.fork_at ?? 0);
    // connector from the parent's last shared step
    const px = isReplay ? x(0) : x(Math.max(0, from - 1));
    const tx = x(from);
    const d = isReplay
      ? `M${px},${y(0)} L${px},${y(lane)}`
      : `M${px},${y(0)} C${px},${y(lane) - ROW * 0.2} ${px},${y(lane)} ${px + Math.min(COL * 0.6, tx - px)},${y(lane)} L${tx},${y(lane)}`;
    edges.append(s('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': isReplay ? '3 3' : null, opacity: 0.85 }));
    if (n - 1 > from) edges.append(s('line', { x1: tx, y1: y(lane), x2: x(n - 1), y2: y(lane), stroke: color, 'stroke-width': 2, 'stroke-dasharray': isReplay ? '3 3' : null }));
    for (let i = from; i < n; i++) {
      const isMut = !isReplay && i === r.fork_at;
      addNode(r, lane, i, { color: isMut ? color : isReplay ? 'var(--fg-3)' : 'var(--fg-2)', hollow: isReplay });
    }
    if (mutated(r)) {
      // ring around the mutated node
      edges.append(s('circle', { cx: tx, cy: y(lane), r: R + 3.5, fill: 'none', stroke: color, 'stroke-width': 1.2, opacity: 0.6 }));
    }
  });

  // label rows
  const rows = h('div', { class: 'tree-rows' },
    h('div', { class: 'tree-head' }, agent, h('span', { class: 'meta' }, h('span', null, 'steps'), h('span', { class: 'hide-sm' }, 'cost'), h('span', { class: 'hide-sm' }, 'wall'))));
  lanes.forEach((r, lane) => {
    const tail = r.run_id.split('__').slice(2).join('__') || r.run_id;
    const row = h('div', {
      class: 'tree-row', tabindex: 0, role: 'link',
      onclick: () => { location.hash = `#/run/${encodeURIComponent(r.run_id)}`; },
      onkeydown: e => { if (e.key === 'Enter') location.hash = `#/run/${encodeURIComponent(r.run_id)}`; },
    },
      lane === 0 ? h('span', { class: 'badge' }, r.mode === 'record' ? 'base' : r.variant) : r.mode === 'replay' ? h('span', { class: 'badge m-replay' }, 'replay') : mutationBadge(r.mutation || r.variant),
      h('span', { class: 'rid', title: r.run_id }, tail),
      r.fork_at != null ? h('span', { class: 'muted small mono' }, `@${r.fork_at}`) : null,
      outcome(r),
      lane > 0 ? h('a', { class: 'small', href: `#/diff?a=${encodeURIComponent(r.parent)}&b=${encodeURIComponent(r.run_id)}`, onclick: e => e.stopPropagation() }, 'diff') : null,
      h('span', { class: 'meta' }, h('span', null, fmt.int(r.steps)), h('span', { class: 'hide-sm' }, fmt.usd(r.cost_usd)), h('span', { class: 'hide-sm' }, fmt.ms(r.wall_ms))));
    rowEls[lane] = row;
    rows.append(row);
  });

  // refine node shapes/colours from cassettes once loaded
  for (const r of lanes) {
    loadRun(r.run_id).then(c => {
      const refs = nodeRefs.get(r.run_id) || [];
      (c.steps || []).forEach((st, i) => {
        const el = refs[i];
        if (!el) return;
        if (st.kind === 'relay') el.setAttribute('rx', 2);
        let color = null;
        if (st.source === 'diverged') color = 'var(--warn)';
        else if (st.source === 'mutated') color = laneColor(r);
        else if ((st.status ?? 200) >= 400) color = 'var(--bad)';
        else if (st.source === 'live' || st.source === 'replayed' && r.mode !== 'replay') color = st.kind === 'relay' ? 'var(--relay)' : 'var(--llm)';
        if (color) { el.setAttribute('stroke', color); if (el.getAttribute('fill') !== 'var(--bg)' || st.source === 'diverged') el.setAttribute('fill', color); }
      });
    }).catch(() => { /* keep generic nodes */ });
  }

  return h('div', { class: 'tree' }, h('div', { class: 'tree-graph scroll-x' }, svg), rows);
}

const mutated = r => r.mode !== 'replay' && r.fork_at != null;
