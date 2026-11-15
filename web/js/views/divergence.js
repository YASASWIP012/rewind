import { h, fmt, shortFp, fieldsTable, sourceBadge, stepSummary } from '../util.js';
import { loadRun } from '../data.js';

export async function renderDivergence(root, data, parts) {
  const id = parts[0];
  root.append(h('div', { class: 'page-head' },
    h('h1', null, 'Divergence report'),
    h('span', { class: 'sub' }, 'Replay steps whose request fingerprint did not match the cassette.')));

  let ids;
  if (id) ids = [id];
  else ids = data.runs.filter(r => r.diverged_steps > 0).map(r => r.run_id);

  if (!ids.length) {
    root.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, 'No replay misses. Every replayed step matched its cassette.')));
    return;
  }
  if (id) root.append(h('div', { class: 'small', style: { marginBottom: '12px' } }, h('a', { href: '#/divergence' }, '← All divergences')));

  const results = await Promise.allSettled(ids.map(loadRun));
  results.forEach((res, k) => {
    if (res.status !== 'fulfilled') {
      root.append(h('div', { class: 'error-box', style: { marginBottom: '12px' } }, `${ids[k]}: ${res.reason?.message || 'failed to load'}`));
      return;
    }
    root.append(runReport(res.value, data));
  });
}

function runReport(c, data) {
  const divs = c.divergences || [];
  const row = data.byId.get(c.run_id) || {};
  const steps = c.steps || [];
  const replayed = steps.filter(s => s.source === 'replayed').length;
  const extraCost = steps.filter(s => s.source === 'diverged').reduce((s, st) => s + (st.cost_usd || 0), 0);
  return h('div', { class: 'card', style: { marginBottom: '18px' } },
    h('div', { class: 'card-h' },
      h('a', { class: 'mono', href: `#/run/${encodeURIComponent(c.run_id)}` }, c.run_id),
      h('span', { class: 'badge warn' }, `${divs.length} miss${divs.length === 1 ? '' : 'es'}`),
      c.match ? h('span', { class: 'chip' }, 'match ', h('b', null, c.match)) : null,
      h('span', { class: 'right' }, `${replayed}/${steps.length} steps replayed · ${fmt.usd(extraCost)} spent live`)),
    h('div', { class: 'card-b' },
      c.parent ? h('div', { class: 'small muted', style: { marginBottom: '10px' } }, 'Cassette ', h('a', { class: 'mono', href: `#/run/${encodeURIComponent(c.parent)}` }, c.parent),
        ' · ', h('a', { href: `#/diff?a=${encodeURIComponent(c.parent)}&b=${encodeURIComponent(c.run_id)}${divs[0] ? `&step=${divs[0].i}` : ''}` }, 'open diff')) : null,
      divs.length ? divs.map(d => divBlock(d, steps[d.i], c.run_id, row)) : h('div', { class: 'muted' }, 'No divergence records in this cassette.')));
}

function divBlock(d, st, runId) {
  return h('div', { style: { marginBottom: '14px' } },
    h('div', { class: 'row', style: { marginBottom: '6px' } },
      h('b', null, `Step ${d.i}`),
      st ? h('span', { class: 'small muted' }, st.kind === 'llm' ? 'LLM' : 'search', ' · ', st.path || '') : null,
      st ? sourceBadge(st.source) : null,
      h('span', { class: 'fp' }, `expected ${shortFp(d.expected)} · got ${shortFp(d.got)}`),
      h('span', { class: 'spacer' }),
      h('a', { class: 'small', href: `#/run/${encodeURIComponent(runId)}?step=${d.i}` }, 'open step')),
    st ? h('div', { class: 'small muted', style: { marginBottom: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, stepSummary(st)) : null,
    h('div', { class: 'card' }, fieldsTable(d.diff || [])));
}
