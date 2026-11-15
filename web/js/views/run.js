import { h, fmt, icon, jsonView, sourceBadge, mutationBadge, withCanary, hasCanary, finalBrief, stepSummary, stepTokens, shortModel } from '../util.js';
import { loadRun } from '../data.js';
import { outcome } from './overview.js';

export async function renderRun(root, data, parts, params) {
  const id = parts[0];
  if (!id) { root.append(h('div', { class: 'empty' }, 'No run selected.')); return; }
  const row = data.byId.get(id) || { run_id: id };
  let c;
  try { c = await loadRun(id); }
  catch (e) {
    root.append(h('div', { class: 'error-box' }, `Cassette for ${id} not found (${e.message}).`));
    return;
  }
  const steps = c.steps || [];
  const target = params.has('step') ? Number(params.get('step')) : null;
  const mut = c.mutation || null;
  const mType = mut?.type || row.mutation;
  const brief = finalBrief(c);
  const tokens = steps.reduce((s, st) => s + stepTokens(st), 0);
  const cost = steps.reduce((s, st) => s + (st.cost_usd || 0), 0);
  const latency = steps.reduce((s, st) => s + (st.latency_ms || 0), 0);
  const divs = c.divergences || [];
  const children = (row.children || []).map(k => data.byId.get(k)).filter(Boolean);

  root.append(
    h('div', { class: 'small', style: { marginBottom: '8px' } }, h('a', { href: '#/tree' + (row.task ? `?task=${encodeURIComponent(row.task)}` : '') }, '← Run tree')),
    h('div', { class: 'inspector-head' },
      h('h1', null, id),
      c.mode === 'replay' ? h('span', { class: 'badge m-replay' }, 'replay') : c.mode === 'fork' ? mutationBadge(mType) : h('span', { class: 'badge' }, 'base'),
      outcome(row),
      h('span', { class: 'spacer' }),
      c.parent ? h('a', { class: 'btn', href: `#/diff?a=${encodeURIComponent(c.parent)}&b=${encodeURIComponent(id)}` }, 'Diff vs parent') : null,
      children.length ? h('a', { class: 'btn', href: `#/diff?a=${encodeURIComponent(id)}&b=${encodeURIComponent(children[0].run_id)}` }, 'Diff vs a fork') : null,
      divs.length ? h('a', { class: 'btn', href: `#/divergence/${encodeURIComponent(id)}` }, `Divergences (${divs.length})`) : null),
    h('div', { class: 'meta-row' },
      chip('agent', c.meta?.agent ?? row.agent),
      chip('task', c.meta?.task ?? row.task),
      chip('mode', c.mode),
      c.meta?.repeat != null ? chip('repeat', c.meta.repeat) : null,
      c.parent ? h('span', { class: 'chip' }, 'parent ', h('a', { href: `#/run/${encodeURIComponent(c.parent)}`, class: 'mono' }, c.parent)) : null,
      c.fork_at != null ? chip('fork at', `step ${c.fork_at}`) : null,
      c.match ? chip('match', c.match) : null,
      c.started_at ? chip('started', new Date(c.started_at).toLocaleString()) : null),
    mut ? mutationCallout(mut) : null,
    h('div', { class: 'kpis', style: { marginBottom: '16px', gridTemplateColumns: 'repeat(5, minmax(0,1fr))' } },
      kpi('Steps', `${steps.length}`, `${steps.filter(s => s.kind === 'llm').length} LLM · ${steps.filter(s => s.kind === 'relay').length} search`),
      kpi('Tokens', fmt.tokens(tokens), `${fmt.int(steps.reduce((s, st) => s + (st.tokens?.prompt || 0), 0))} in`),
      kpi('Cost', fmt.usd(cost), `${steps.filter(s => s.source === 'replayed').length} steps replayed`),
      kpi('Latency', fmt.ms(latency), row.wall_ms ? `${fmt.ms(row.wall_ms)} wall` : 'sum of steps'),
      kpi('Brief', brief ? `${brief.split(/\s+/).length} words` : 'none', hasCanary(brief) ? h('span', { style: { color: 'var(--bad)' } }, 'mentions canary') : 'no canary')),
  );

  root.append(h('div', { class: 'card', style: { marginBottom: '20px' } },
    h('div', { class: 'card-h' }, h('h2', null, 'Final brief'), h('span', { class: 'right' }, brief ? 'last LLM message' : '')),
    brief ? h('div', { class: 'brief' }, withCanary(brief)) : h('div', { class: 'card-b muted' }, 'The run ended without a brief.')));

  root.append(h('div', { class: 'row', style: { marginBottom: '8px' } },
    h('h2', null, 'Timeline'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => tl.querySelectorAll('.step').forEach(e => e.__open?.(true)) }, 'Expand all'),
    h('button', { class: 'btn', onclick: () => tl.querySelectorAll('.step').forEach(e => e.__open?.(false)) }, 'Collapse all')));
  const tl = h('div', { class: 'timeline' }, steps.map(st => stepEl(st, c, st.i === target)));
  root.append(tl);
}

const chip = (k, v) => h('span', { class: 'chip' }, k, ' ', h('b', null, String(v ?? '–')));
const kpi = (k, v, d) => h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 'd' }, d));

function mutationCallout(m) {
  const rest = { ...m }; delete rest.type;
  let detail;
  if (m.type === 'poison') detail = h('span', null, 'Appended to the first search result: ', h('q', null, withCanary(m.text || '')));
  else if (m.type === 'model_swap') detail = h('span', null, 'Request model rewritten to ', h('code', null, m.model));
  else if (m.type === 'outage' || m.type === 'tool_error') detail = h('span', null, `Returned HTTP ${m.status ?? '5xx'} without calling the provider.`);
  else detail = h('code', null, JSON.stringify(rest));
  return h('div', { class: 'callout violet' }, mutationBadge(m.type), h('div', { class: 'small' }, detail));
}

function stepEl(st, c, isTarget) {
  const status = st.status ?? 200;
  const err = status >= 400;
  const isFork = c.fork_at != null && st.i === c.fork_at;
  const detail = h('div', { class: 'detail' });
  const el = h('div', { class: `step${isTarget ? ' target' : ''}`, id: `step-${st.i}`, 'data-scroll-target': isTarget ? '' : null });
  let open = false;
  const setOpen = v => {
    open = v;
    el.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    if (open && !detail.childNodes.length) {
      detail.append(
        h('div', null, h('div', { class: 'pane-h' }, 'Request', h('span', { class: 'right mono' }, st.path || '')), jsonView(st.request)),
        h('div', null, h('div', { class: 'pane-h' }, 'Response', h('span', { class: `right ${err ? 'status-bad' : ''}` }, `HTTP ${status}`)), jsonView(st.response)),
        h('div', { class: 'fp', style: { gridColumn: '1 / -1' } }, `fingerprint ${st.fingerprint || '–'}`, st.ts ? ` · ${st.ts}` : ''));
    }
    detail.style.display = open ? '' : 'none';
  };
  el.__open = setOpen;
  const model = st.kind === 'llm' ? (st.served_model && st.served_model !== st.model
    ? `${shortModel(st.model)} → ${shortModel(st.served_model)}` : shortModel(st.model || st.served_model)) : null;
  const head = h('div', {
    class: 'step-h', role: 'button', tabindex: 0, 'aria-expanded': 'false',
    onclick: () => setOpen(!open),
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(!open); } },
  },
    h('span', { class: 'idx' }, st.i),
    h('span', { class: 'kind' }, st.kind === 'llm' ? 'LLM' : 'Search'),
    sourceBadge(st.source),
    isFork ? h('span', { class: 'badge accent' }, 'fork point') : null,
    model ? h('span', { class: 'mono small' }, model) : h('span', { class: 'path' }, st.path),
    err ? h('span', { class: 'status-bad small' }, `HTTP ${status}`) : null,
    h('span', { class: 'nums' },
      st.kind === 'llm' ? h('span', { title: 'prompt / completion tokens' }, `${fmt.int(st.tokens?.prompt)} / ${fmt.int(st.tokens?.completion)} tok`) : null,
      h('span', null, fmt.usd(st.cost_usd)),
      h('span', null, fmt.ms(st.latency_ms))));
  const sum = stepSummary(st);
  el.append(
    h('div', { class: 'rail' }, h('div', { class: `icon ${st.kind} src-${st.source}${err ? ' err' : ''}`, title: st.kind === 'llm' ? 'LLM call' : 'Search call' }, err ? icon.err() : st.kind === 'llm' ? icon.llm() : icon.relay())),
    h('div', { class: 'body' }, head, sum ? h('div', { class: 'preview', title: sum }, withCanary(sum)) : null, detail));
  setOpen(isTarget);
  return el;
}
