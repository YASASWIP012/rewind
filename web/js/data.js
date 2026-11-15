// Static data loading. Reads data/index.json, falls back to data-sample/.

// ?data=sample (in the page URL, before the #) forces the bundled fixtures.
const forced = new URLSearchParams(location.search).get('data');
const BASES = forced === 'sample' ? ['data-sample/'] : ['data/', 'data-sample/'];
let state = null;
const cassettes = new Map();

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

export async function loadIndex() {
  if (state) return state;
  let lastErr;
  for (const base of BASES) {
    try {
      const raw = await getJSON(base + 'index.json');
      state = { base, isSample: base !== 'data/' || !!raw.sample, ...normalize(raw) };
      return state;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Could not load index.json from ${BASES.join(' or ')} (${lastErr?.message || 'unknown error'})`);
}

export async function loadRun(id) {
  if (cassettes.has(id)) return cassettes.get(id);
  const { base } = await loadIndex();
  const p = getJSON(`${base}runs/${encodeURIComponent(id)}.json`).catch(e => { cassettes.delete(id); throw e; });
  cassettes.set(id, p);
  return p;
}

export function getState() { return state; }

// ---------- normalisation (tolerant of small format drift)

function normalize(raw) {
  const runsIn = Array.isArray(raw) ? raw : (raw.runs || []);
  const runs = runsIn.map(normRun);
  const byId = new Map(runs.map(r => [r.run_id, r]));
  for (const r of runs) r.children = [];
  for (const r of runs) if (r.parent && byId.has(r.parent)) byId.get(r.parent).children.push(r.run_id);
  const summaryIn = raw.summary || {};
  const summary = {
    headline: summaryIn.headline || null,
    canary: summaryIn.canary || raw.canary || 'Initech',
    groups: normGroups(summaryIn.groups ?? summaryIn.by_agent_variant ?? summaryIn.aggregates, runs),
    paired: normPaired(summaryIn.paired ?? summaryIn.stats ?? summaryIn.paired_stats),
    replay: normReplay(summaryIn.replay ?? summaryIn.replay_savings, runs, byId),
    raw: summaryIn,
  };
  const agents = [...new Set(runs.map(r => r.agent).filter(Boolean))].sort();
  const tasks = [...new Set(runs.map(r => r.task).filter(Boolean))].sort();
  return { runs, byId, summary, agents, tasks, generatedAt: raw.generated_at || null };
}

function parseId(id) {
  // agent__task__variant[__rN]
  const parts = String(id).split('__');
  return { agent: parts[0], task: parts[1], tail: parts.slice(2).join('__') };
}

function normRun(r) {
  const p = parseId(r.run_id);
  const meta = r.meta || {};
  let variant = r.variant;
  const mutation = typeof r.mutation === 'object' && r.mutation ? r.mutation.type : r.mutation;
  if (!variant) {
    if (r.mode === 'replay') variant = 'replay';
    else if (r.mode === 'fork') variant = mutation || 'fork';
    else variant = 'base';
  }
  const mode = r.mode || (variant === 'base' ? 'record' : variant === 'replay' ? 'replay' : 'fork');
  return {
    ...r,
    agent: r.agent || meta.agent || p.agent,
    task: r.task || meta.task || p.task,
    repeat: r.repeat ?? meta.repeat ?? 0,
    variant,
    mode,
    mutation: mutation || (mode === 'fork' ? variant : null),
    parent: r.parent ?? r.source ?? null,
    fork_at: r.fork_at ?? null,
    success: r.success ?? null,
    followed_injection: r.followed_injection ?? null,
    diverged_steps: r.diverged_steps ?? r.divergences ?? 0,
  };
}

const VARIANT_ORDER = ['base', 'poison', 'outage', 'tool_error', 'model_swap', 'edit', 'fork'];
export const variantRank = v => { const i = VARIANT_ORDER.indexOf(v); return i < 0 ? 99 : i; };

function normGroups(g, runs) {
  let list = [];
  if (Array.isArray(g)) list = g;
  else if (g && typeof g === 'object') {
    for (const [k, v] of Object.entries(g)) {
      if (v && typeof v === 'object' && ('success_rate' in v || 'n' in v)) {
        const [agent, variant] = k.split(/[|/:]/);
        list.push({ agent, variant, ...v });
      } else if (v && typeof v === 'object') {
        for (const [vk, vv] of Object.entries(v)) list.push({ agent: k, variant: vk, ...vv });
      }
    }
  }
  if (!list.length) list = deriveGroups(runs);
  return list.map(x => ({
    agent: x.agent, variant: x.variant, n: x.n ?? x.runs ?? null,
    success_rate: x.success_rate ?? x.success ?? null,
    followed_injection_rate: x.followed_injection_rate ?? x.injection_follow_rate ?? x.followed_injection ?? x.injection_rate ?? null,
    avg_steps: x.avg_steps ?? x.steps_mean ?? x.steps ?? null,
    avg_tool_calls: x.avg_tool_calls ?? x.tool_calls_mean ?? x.tool_calls ?? null,
    avg_tokens: x.avg_tokens ?? x.tokens_mean ?? x.tokens ?? null,
    avg_cost_usd: x.avg_cost_usd ?? x.cost_usd_mean ?? x.cost_usd ?? null,
    avg_wall_ms: x.avg_wall_ms ?? x.wall_ms_mean ?? x.wall_ms ?? null,
  })).sort((a, b) => (a.agent || '').localeCompare(b.agent || '') || variantRank(a.variant) - variantRank(b.variant));
}

function deriveGroups(runs) {
  const m = new Map();
  for (const r of runs) {
    if (r.variant === 'replay') continue;
    const k = r.agent + '|' + r.variant;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  const avg = (rs, f) => rs.length ? rs.reduce((s, r) => s + (Number(f(r)) || 0), 0) / rs.length : null;
  return [...m.entries()].map(([k, rs]) => {
    const [agent, variant] = k.split('|');
    return {
      agent, variant, n: rs.length,
      success_rate: avg(rs, r => r.success ? 1 : 0),
      followed_injection_rate: avg(rs, r => r.followed_injection ? 1 : 0),
      avg_steps: avg(rs, r => r.steps), avg_tool_calls: avg(rs, r => r.tool_calls),
      avg_tokens: avg(rs, r => r.tokens), avg_cost_usd: avg(rs, r => r.cost_usd), avg_wall_ms: avg(rs, r => r.wall_ms),
    };
  });
}

function normPaired(p) {
  if (!p) return [];
  const list = Array.isArray(p) ? p : Object.entries(p).map(([label, v]) => ({ label, ...v }));
  return list.map(x => {
    const mc = x.mcnemar && typeof x.mcnemar === 'object' ? x.mcnemar : {};
    const label = x.label
      || (x.variant ? `${variantName(x.variant)}: ${x.a} vs ${x.b}` : null)
      || [x.agent, x.variant].filter(Boolean).join(' · ') || `${x.a} vs ${x.b}`;
    return {
      label, variant: x.variant ?? null,
      metric: x.metric || 'success',
      a: x.a, b: x.b,
      n_pairs: x.n_pairs ?? x.n ?? null,
      a_only: x.a_only ?? mc.a_only ?? x.b01 ?? null,
      b_only: x.b_only ?? mc.b_only ?? x.b10 ?? null,
      a_rate: x.a_rate ?? null, b_rate: x.b_rate ?? null,
      delta: x.delta ?? x.diff ?? null,
      ci95: x.ci95 ?? x.bootstrap_ci ?? x.ci ?? null,
      mcnemar_p: x.mcnemar_p ?? mc.p_value ?? mc.p ?? (typeof x.mcnemar === 'number' ? x.mcnemar : null) ?? x.p ?? x.p_value ?? null,
    };
  });
}

const variantName = v => ({ model_swap: 'Model swap', poison: 'Poison', outage: 'Outage', base: 'Base', replay: 'Replay', tool_error: 'Tool error' }[v] || v);

function normReplay(r, runs, byId) {
  const reps = runs.filter(x => x.mode === 'replay');
  if (r && typeof r === 'object') {
    const sum = f => reps.reduce((s, x) => s + (Number(f(x)) || 0), 0);
    const steps = r.steps ?? (reps.length ? sum(x => x.steps) : null);
    const stepsReplayed = r.steps_replayed ?? (reps.length ? sum(x => x.replayed_steps) : null);
    const diverged = r.steps_diverged ?? (reps.length ? sum(x => x.diverged_steps) : null);
    const divergentRuns = r.divergent_runs ?? reps.filter(x => x.diverged_steps > 0).length;
    const runsN = r.runs ?? reps.length;
    return {
      ...r,
      runs: runsN,
      steps, steps_replayed: stepsReplayed, steps_diverged: diverged,
      live_cost_usd: r.live_cost_usd ?? r.original_cost_usd ?? null,
      replay_cost_usd: r.replay_cost_usd ?? 0,
      live_wall_ms: r.live_wall_ms ?? r.original_wall_ms ?? null,
      replay_wall_ms: r.replay_wall_ms ?? null,
      clean_runs: r.clean_runs ?? (runsN != null ? runsN - divergentRuns : null),
    };
  }
  if (!reps.length) return null;
  const parentOf = x => byId.get(x.parent) || {};
  return {
    runs: reps.length,
    steps: reps.reduce((s, x) => s + (x.steps || 0), 0),
    steps_replayed: reps.reduce((s, x) => s + (x.replayed_steps || 0), 0),
    steps_diverged: reps.reduce((s, x) => s + (x.diverged_steps || 0), 0),
    live_cost_usd: reps.reduce((s, x) => s + (parentOf(x).cost_usd || 0), 0),
    replay_cost_usd: reps.reduce((s, x) => s + (x.cost_usd || 0), 0),
    live_wall_ms: reps.reduce((s, x) => s + (parentOf(x).wall_ms || 0), 0),
    replay_wall_ms: reps.reduce((s, x) => s + (x.wall_ms || 0), 0),
  };
}
