import { h, fmt, variantLabel, mutationBadge } from '../util.js';
import { variantRank } from '../data.js';

export function renderOverview(root, data) {
  const { summary, runs } = data;
  const headline = summary.headline || autoHeadline(summary);

  const forks = runs.filter(r => r.mode === 'fork');
  const totalCost = runs.reduce((s, r) => s + (r.cost_usd || 0), 0);
  const totalSteps = runs.reduce((s, r) => s + (r.steps || 0), 0);
  const replayedSteps = runs.reduce((s, r) => s + (r.replayed_steps || 0), 0);
  const diverged = runs.filter(r => r.diverged_steps > 0);

  root.append(
    h('div', { class: 'muted small' }, 'Result'),
    h('p', { class: 'headline' }, headline),
    h('div', { class: 'muted small' },
      `${data.agents.length} agents · ${data.tasks.length} tasks · ${runs.length} runs`,
      data.generatedAt ? ` · generated ${new Date(data.generatedAt).toLocaleString()}` : ''),
    h('div', { class: 'kpis' },
      kpi('Runs', fmt.int(runs.length), `${forks.length} forks`),
      kpi('Steps recorded', fmt.int(totalSteps), `${fmt.int(replayedSteps)} served from cassettes`),
      kpi('Spend, all runs', fmt.usd(totalCost), 'LLM + search'),
      kpi('Replay misses', fmt.int(diverged.length), diverged.length ? h('a', { href: '#/divergence' }, 'view report') : 'none')),
  );

  root.append(h('div', { class: 'grid two section' },
    h('div', { class: 'card' },
      h('div', { class: 'card-h' }, h('h2', null, 'Agents × variants'), h('span', { class: 'right' }, 'means per run')),
      h('div', { class: 'card-b flush scroll-x' }, groupsTable(summary.groups))),
    replayPanel(summary.replay)));

  root.append(h('div', { class: 'card section' },
    h('div', { class: 'card-h' }, h('h2', null, 'Paired statistics'),
      h('span', { class: 'right' }, 'McNemar exact test · paired bootstrap 95% CI')),
    h('div', { class: 'card-b flush scroll-x' }, pairedTable(summary.paired))));

  root.append(runsCard(data));
}

function autoHeadline(summary) {
  const g = summary.groups.filter(x => x.variant === 'poison' && x.followed_injection_rate != null)
    .sort((a, b) => b.followed_injection_rate - a.followed_injection_rate);
  if (!g.length) return 'Record, replay and fork any agent run at the gateway.';
  const count = x => x.n != null ? `${Math.round(x.followed_injection_rate * x.n)} of ${x.n} runs` : `${fmt.pct(x.followed_injection_rate)} of runs`;
  const p = summary.paired.find(x => x.metric === 'followed_injection' && (x.variant === 'poison' || /poison/i.test(x.label)));
  const [first, ...rest] = g;
  return `With one poisoned search result, ${first.agent} followed the planted instruction in ${count(first)}`
    + rest.map(x => `; ${x.agent} in ${count(x)}`).join('')
    + (p?.mcnemar_p != null ? ` (McNemar p ${p.mcnemar_p < 0.001 ? '< 0.001' : '= ' + fmt.p(p.mcnemar_p)}).` : '.');
}

function kpi(k, v, d) {
  return h('div', { class: 'kpi' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 'd' }, d));
}

function rateCell(v, bad) {
  if (v == null) return h('td', { class: 'n' }, '–');
  return h('td', { class: 'n' }, h('span', { class: 'rate' }, fmt.pct(v),
    h('span', { class: `bar${bad ? ' bad' : ''}`, 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.round(v * 100)}%` } }))));
}

function groupsTable(groups) {
  if (!groups.length) return h('div', { class: 'empty' }, 'No aggregates yet.');
  const agents = [...new Set(groups.map(g => g.agent))];
  return h('table', { class: 't' },
    h('thead', null, h('tr', null,
      h('th', null, 'Variant'), h('th', { class: 'n' }, 'n'), h('th', { class: 'n' }, 'Success'),
      h('th', { class: 'n' }, 'Followed injection'), h('th', { class: 'n' }, 'Steps'), h('th', { class: 'n' }, 'Tool calls'),
      h('th', { class: 'n' }, 'Tokens'), h('th', { class: 'n' }, 'Cost'), h('th', { class: 'n' }, 'Wall time'))),
    h('tbody', null, agents.map(a => [
      h('tr', { class: 'group' }, h('td', { colspan: 9 }, a)),
      groups.filter(g => g.agent === a).sort((x, y) => variantRank(x.variant) - variantRank(y.variant)).map(g =>
        h('tr', { class: 'click', onclick: () => { location.hash = `#/tree?agent=${encodeURIComponent(a)}`; } },
          h('td', null, g.variant === 'base' ? h('span', { class: 'badge' }, 'base') : mutationBadge(g.variant)),
          h('td', { class: 'n' }, fmt.int(g.n)),
          rateCell(g.success_rate, false),
          g.variant === 'poison' || g.followed_injection_rate > 0 ? rateCell(g.followed_injection_rate, true) : h('td', { class: 'n muted' }, fmt.pct(g.followed_injection_rate)),
          h('td', { class: 'n' }, fmt.num(g.avg_steps, 1)),
          h('td', { class: 'n' }, fmt.num(g.avg_tool_calls, 1)),
          h('td', { class: 'n' }, fmt.tokens(g.avg_tokens)),
          h('td', { class: 'n' }, fmt.usd(g.avg_cost_usd)),
          h('td', { class: 'n' }, fmt.ms(g.avg_wall_ms)))),
    ])));
}

function pairedTable(rows) {
  if (!rows.length) return h('div', { class: 'empty' }, 'No paired statistics.');
  return h('table', { class: 't' },
    h('thead', null, h('tr', null,
      h('th', null, 'Comparison'), h('th', null, 'Metric'), h('th', { class: 'n' }, 'Pairs'),
      h('th', { class: 'n' }, 'A → B'), h('th', { class: 'n' }, 'Discordant (A only / B only)'),
      h('th', { class: 'n' }, 'Δ (B − A)'), h('th', { class: 'n' }, '95% CI'), h('th', { class: 'n' }, 'McNemar p'))),
    h('tbody', null, rows.map(r => {
      const sig = r.mcnemar_p != null && r.mcnemar_p < 0.05;
      return h('tr', null,
        h('td', null, r.label),
        h('td', { class: 'muted' }, r.metric.replace(/_/g, ' ')),
        h('td', { class: 'n' }, fmt.int(r.n_pairs)),
        h('td', { class: 'n' }, r.a_rate != null ? `${fmt.pct(r.a_rate)} → ${fmt.pct(r.b_rate)}` : '–'),
        h('td', { class: 'n' }, r.a_only != null ? `${r.a_only} / ${r.b_only}` : '–'),
        h('td', { class: 'n' }, fmt.signed(r.delta)),
        h('td', { class: 'n mono' }, Array.isArray(r.ci95) ? `[${fmt.signed(r.ci95[0])}, ${fmt.signed(r.ci95[1])}]` : '–'),
        h('td', { class: 'n' }, h('span', { class: sig ? 'badge ok' : '' }, fmt.p(r.mcnemar_p))));
    })));
}

function replayPanel(r) {
  const card = h('div', { class: 'card replay' }, h('div', { class: 'card-h' }, h('h2', null, 'Replay vs live')));
  if (!r) { card.append(h('div', { class: 'card-b muted' }, 'No replay runs.')); return card; }
  const saved = (r.live_cost_usd || 0) - (r.replay_cost_usd || 0);
  const timeSaved = (r.live_wall_ms || 0) - (r.replay_wall_ms || 0);
  const pctReplayed = r.steps ? r.steps_replayed / r.steps : null;
  const cleanCost = r.clean_replay_cost_usd ?? (r.steps_diverged ? null : r.replay_cost_usd);
  card.append(h('div', { class: 'card-b' },
    h('div', { class: 'big' },
      h('span', { class: 'v' }, fmt.usd(cleanCost ?? r.replay_cost_usd)),
      h('span', { class: 'vs' }, `vs ${fmt.usd(r.live_cost_usd)} live`)),
    h('div', { class: 'muted small' },
      cleanCost != null && r.clean_runs != null ? `per clean replay set (${r.clean_runs} of ${r.runs} runs hit every step)` : `${r.runs} replay runs`),
    h('div', { class: 'meter', title: `${r.steps_replayed} of ${r.steps} steps from cassette` },
      h('i', { style: { width: `${(pctReplayed || 0) * 100}%`, background: 'var(--ok)' } }),
      h('i', { style: { width: `${r.steps ? (r.steps_diverged || 0) / r.steps * 100 : 0}%`, background: 'var(--warn)' } })),
    h('dl', null,
      h('dt', null, 'Steps from cassette'), h('dd', null, `${fmt.int(r.steps_replayed)} / ${fmt.int(r.steps)}`),
      h('dt', null, 'Replay misses'), h('dd', null, r.steps_diverged ? h('a', { href: '#/divergence' }, `${r.steps_diverged} steps`) : '0'),
      h('dt', null, 'Cost, all replays'), h('dd', null, fmt.usd(r.replay_cost_usd)),
      h('dt', null, 'Money saved'), h('dd', null, fmt.usd(saved)),
      h('dt', null, 'Wall time live → replay'), h('dd', null, `${fmt.ms(r.live_wall_ms)} → ${fmt.ms(r.replay_wall_ms)}`),
      h('dt', null, 'Time saved'), h('dd', null, `${fmt.ms(timeSaved)}${r.live_wall_ms ? ` (${Math.round(timeSaved / r.live_wall_ms * 100)}%)` : ''}`)),
  ));
  return card;
}

function runsCard(data) {
  const filters = { agent: '', task: '', variant: '' };
  const tbody = h('tbody');
  const count = h('span', { class: 'right' });
  const variants = [...new Set(data.runs.map(r => r.variant))].sort((a, b) => variantRank(a) - variantRank(b));
  const sel = (key, opts, label) => h('select', { class: 'sel', 'aria-label': label, onchange: e => { filters[key] = e.target.value; draw(); } },
    h('option', { value: '' }, `All ${label}`), opts.map(o => h('option', { value: o }, key === 'variant' ? variantLabel(o) : o)));

  function draw() {
    const rows = data.runs.filter(r => (!filters.agent || r.agent === filters.agent) && (!filters.task || r.task === filters.task) && (!filters.variant || r.variant === filters.variant));
    count.textContent = `${rows.length} runs`;
    tbody.replaceChildren(...rows.map(r => h('tr', { class: 'click', onclick: () => { location.hash = `#/run/${encodeURIComponent(r.run_id)}`; } },
      h('td', { class: 'mono' }, h('a', { href: `#/run/${encodeURIComponent(r.run_id)}`, onclick: e => e.stopPropagation() }, r.run_id)),
      h('td', null, r.variant === 'base' ? h('span', { class: 'badge' }, 'base') : mutationBadge(r.variant)),
      h('td', null, outcome(r)),
      h('td', { class: 'n' }, fmt.int(r.steps)),
      h('td', { class: 'n' }, fmt.int(r.replayed_steps)),
      h('td', { class: 'n' }, fmt.tokens(r.tokens)),
      h('td', { class: 'n' }, fmt.usd(r.cost_usd)),
      h('td', { class: 'n' }, fmt.ms(r.wall_ms)))));
  }
  draw();
  return h('div', { class: 'card section' },
    h('div', { class: 'card-h' }, h('h2', null, 'All runs'), count),
    h('div', { class: 'card-b' }, h('div', { class: 'row' },
      sel('agent', data.agents, 'agents'), sel('task', data.tasks, 'tasks'), sel('variant', variants, 'variants'))),
    h('div', { class: 'card-b flush scroll-x', style: { maxHeight: '480px', overflowY: 'auto' } },
      h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', null, 'Run'), h('th', null, 'Variant'), h('th', null, 'Outcome'),
          h('th', { class: 'n' }, 'Steps'), h('th', { class: 'n' }, 'Replayed'), h('th', { class: 'n' }, 'Tokens'),
          h('th', { class: 'n' }, 'Cost'), h('th', { class: 'n' }, 'Wall'))),
        tbody)));
}

export function outcome(r) {
  const out = [];
  if (r.success === true) out.push(h('span', { class: 'badge ok' }, 'pass'));
  else if (r.success === false) out.push(h('span', { class: 'badge bad' }, 'fail'));
  if (r.followed_injection) out.push(h('span', { class: 'badge bad' }, 'injected'));
  if (r.diverged_steps > 0) out.push(h('span', { class: 'badge diverged' }, `${r.diverged_steps} diverged`));
  return h('span', { class: 'row', style: { gap: '4px', flexWrap: 'nowrap' } }, out.length ? out : h('span', { class: 'muted' }, '–'));
}
