# Rewind

Rewind is a Bifrost plugin for people who build AI agents. It records every model call and web search an agent makes, replays the run for free, and forks it at any step so you can change one thing and see what the agent does next.

**[Open the demo](https://yasaswip012.github.io/rewind/)** (no login, no keys; it reads recorded runs) · [Run it locally](#run-it-locally) · [How it works](#how-it-works) · [Results](#results)

Built for the Geek Room Global AI Hackathon 2026. Primary problem statement: **02, a benchmarking platform for AI agents** (Bifrost track), with the Tavily integration box ticked for **05, the pre-meeting briefing agent**. The plugin is also written to the standard asked for in **04** (public extension points, stock Bifrost, tests, docs).

## The problem

Agent runs are hard to compare. Ask the same agent the same question twice and you get two different paths: different searches, different tool calls, different answers. So when you change a prompt, swap a model, or want to know how the agent copes when a search result is wrong, you can't tell whether the difference came from your change or from chance.

Benchmarks deal with this by running everything many times, which costs money and still mixes every source of randomness together. And no framework-level tool sees everything: a LangGraph tracer doesn't see your TypeScript agent, and neither sees the web searches.

The gateway does. Every model call and every Tavily call already passes through Bifrost.

## What Rewind does

| | |
|---|---|
| **Record** | Any agent that points at Bifrost is recorded step by step: chat completions and Tavily searches (through Bifrost Relays). Nothing in the agent changes except its base URL and one header. |
| **Replay** | Run the agent again and the gateway answers from the recording. No provider is called, so it's free and it's the same run every time. |
| **Fork** | Replay steps 1 to k−1, change step k, and let the rest run live. Mutations: plant a misleading instruction or a false claim in a search result, simulate a provider outage, swap the model, or edit a response. Every branch shares the exact same history, so the only difference is the one you made. |
| **Compare** | Branches of the same run are paired, so Rewind uses paired statistics (exact McNemar, paired bootstrap) instead of comparing two noisy averages. |
| **Catch drift** | If a replayed agent sends a request the recording doesn't have, Rewind says which step and which field changed. That makes a recorded run a regression test you can run in CI for $0. |

## Results

{{RESULTS}}

## How it works

```
agent (Python or TypeScript)
   │  OPENAI_BASE_URL = http://localhost:8080/v1
   │  TAVILY_BASE_URL = http://localhost:8080/relay/tavily
   │  header x-rewind-run: <run id>
   ▼
Bifrost v2.5.1 ── rewind.so (HTTPTransportPreHook / PostHook)
   │                 record · replay · fork · divergence report
   │                 run API on :8099
   ├──► Gemini (chat completions, retries and backoff handled by Bifrost)
   └──► Tavily (Relay: key held by the gateway, priced and logged)
```

**Why Bifrost.** Rewind needs one place that sees an agent's model calls and its web searches, whatever language the agent is written in, and that can answer a request itself instead of forwarding it. Bifrost's transport hooks can short-circuit any route, and Relays put Tavily behind the same gateway as the models. That's why one plugin covers both, and why the two benchmark agents (one in Python, one in TypeScript, with different strategies) needed no Rewind-specific code.

Bifrost features used: Go plugin hooks (`HTTPTransportPreHook`, `HTTPTransportPostHook`), Relays with routes and a stored Tavily credential, virtual keys with per-provider model allowlists and relay grants, and provider retries with backoff.

**Why Tavily.** The benchmark agents write one-page meeting briefs from the last 30 days of news, so Tavily search is the agents' whole view of the world. That makes it the right place to test them: Rewind records each search, replays it exactly, and in a fork rewrites one result to see whether the agent believes it.

**Matching.** Each step is fingerprinted with SHA-256 over the request after removing values that change between identical runs (timestamps, UUIDs, tool-call ids, long numbers). In strict mode a miss returns HTTP 409 with a field-level diff; in lenient mode the request goes live and the step is marked as diverged.

**Limits of replay.** Rewind replays what passes through the gateway. If an agent reads files, a database or the clock outside the gateway, those reads aren't recorded, so a fork only isolates one variable for agents whose world is model calls and web searches (as with these research agents). Streaming responses are recorded but not yet replayed as streams.

## Run it locally

Needs Go 1.27+, a C compiler, Node 24, Python 3.15 with `uv`, a Gemini API key and a Tavily API key (free tiers work).

```bash
git clone https://github.com/YASASWIP012/rewind && cd rewind
printf 'GEMINI_API_KEY=...\nTAVILY_API_KEY=...\n' > ../.env
make run                      # builds Bifrost v2.5.1 + rewind.so, starts the gateway on :8080
```

In another terminal:

```bash
cd bench
uv run python rewind_bench.py record --tasks nvidia      # record both agents
uv run python rewind_bench.py replay --tasks nvidia      # free, exact replay
uv run python rewind_bench.py fork --tasks nvidia        # poison, misinfo, outage, model swap
uv run python rewind_bench.py report                     # tables, stats, viewer data
uv run python rewind_bench.py test --cassette brief_py__nvidia__base   # CI check
cd ../web && python3 -m http.server 4173                 # the viewer
```

Run API (served by the plugin on :8099):

```bash
curl -X POST localhost:8099/rewind/runs -d '{"run_id":"demo-fork","mode":"fork","source":"brief_py__nvidia__base","fork_at":1,"mutation":{"type":"poison","text":"..."}}'
```

## Repository

| Path | What |
|---|---|
| `plugin/` | The Bifrost plugin (Go): hooks, cassette store, fingerprinting, mutations, run API, tests |
| `gateway/config.json` | Bifrost config: Gemini provider, Tavily relay, virtual key, the plugin |
| `bench/agents/brief_py` | Briefing agent in Python: plans queries, searches, writes once |
| `bench/agents/brief_ts` | Briefing agent in TypeScript: tool-calling loop |
| `bench/rewind_bench.py` | Benchmark harness: record, replay, fork, report, test |
| `web/` | Static viewer (overview, run tree, step inspector, branch diff, divergences) |
| `docs/CONTRACT.md` | Run API, cassette format and matching rules |

## AI disclosure

The agents under test use Gemini 3.5 Flash-Lite (and Gemini 3.5 Flash for the model-swap forks) through Bifrost, with Tavily for search. AI coding assistants were used while building this project.

## License

Apache-2.0, the same as Bifrost.
