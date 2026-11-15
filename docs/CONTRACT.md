# Rewind internal contract

Shared by the gateway plugin (Go), the benchmark harness (Python + TypeScript agents) and the viewer (static web).

## Topology

```
agent ──(OpenAI-compatible)──► Bifrost :8080 /v1/chat/completions ──► Gemini (primary) / Groq (fallback)
agent ──(HTTP)──────────────► Bifrost :8080 /relay/tavily/search  ──► api.tavily.com
                                 │
                                 └── rewind plugin (HTTPTransportPreHook / PostHook)
                                      records, replays, forks; control API at /rewind/*
```

Agents only need two env vars: `OPENAI_BASE_URL=http://localhost:8080/v1` and `TAVILY_BASE_URL=http://localhost:8080/relay/tavily`. They never hold provider keys.

## Identifying a run

Every request carries the header `x-rewind-run: <run_id>`. If it is absent, the plugin passes the request through untouched.
(Agents read `REWIND_RUN` from the environment and set it as a default header. That is the only line of agent code Rewind needs.)

## Control API (served by the plugin itself, short-circuited in HTTPTransportPreHook)

`POST /rewind/runs` body:
```json
{
  "run_id": "brief-a__acme__fork-poison-s3__r2",
  "mode": "record" | "replay" | "fork",
  "source": "brief-a__acme__base",          // replay/fork only: cassette to read
  "fork_at": 3,                              // fork only: 0-based step index where the mutation applies
  "mutation": {                              // fork only
    "type": "model_swap" | "outage" | "tool_error" | "poison" | "edit",
    "model": "groq/llama-3.3-70b-versatile",  // model_swap
    "status": 503,                            // outage / tool_error
    "text": "...",                            // poison: text appended to the first search result's content
    "body": "..."                             // edit: replacement response body
  },
  "match": "strict" | "lenient",            // default lenient
  "meta": {"agent": "brief-a", "task": "acme", "repeat": 2}
}
```
`GET /rewind/runs` → list of run summaries. `GET /rewind/runs/{run_id}` → full cassette. `POST /rewind/runs/{run_id}/close` → flush to disk.

## Behaviour per mode

- **record**: every request is forwarded; request + response stored as a step.
- **replay**: step i is served from `source` step i if fingerprints match. On a fingerprint miss: `strict` → HTTP 409 with a divergence body; `lenient` → forward live and mark the step `diverged`. Either way a `divergence` record is written (step, field-level diff of the normalised request).
- **fork**: steps `< fork_at` behave like replay; step `fork_at` applies the mutation; steps after it are live and recorded. The new cassette stores `parent` and `fork_at`.

Mutations at the fork step:
- `model_swap`: rewrite the request's `model` and forward live.
- `outage`: return `status` with an OpenAI-style error body and do not call the provider.
- `tool_error`: same as outage, for a relay step.
- `poison`: take the source step's recorded Tavily response and append `text` to `results[0].content`, then serve it.
- `edit`: serve `body` as the response.

## Fingerprint

SHA-256 over a normalised request: path + JSON body with keys sorted, and inside string values: ISO-8601 timestamps → `<ts>`, UUIDs → `<uuid>`, `call_[A-Za-z0-9]+` tool-call ids → `<call>`, 10+ digit numbers → `<n>`. Fields `stream`, `user`, `metadata`, `request_id` are dropped.

## Cassette file (`data/cassettes/<run_id>.json`)

```json
{
  "run_id": "...", "mode": "record|replay|fork", "parent": null, "fork_at": null,
  "mutation": null, "meta": {"agent": "brief-a", "task": "acme", "repeat": 0},
  "started_at": "...", "ended_at": "...",
  "steps": [
    {
      "i": 0, "kind": "llm" | "relay",
      "path": "/v1/chat/completions",
      "fingerprint": "sha256...",
      "source": "live" | "replayed" | "mutated" | "diverged",
      "request": {...}, "response": {...}, "status": 200,
      "model": "gemini/gemini-3.5-flash-lite", "served_model": "...",
      "tokens": {"prompt": 0, "completion": 0},
      "cost_usd": 0.0, "latency_ms": 0, "ts": "..."
    }
  ],
  "divergences": [{"i": 2, "expected": "sha..", "got": "sha..", "diff": [{"path": "messages[1].content", "expected": "...", "got": "..."}]}]
}
```

## Benchmark outputs (`data/results/`)

- `runs.jsonl`: one line per run: run_id, agent, task, variant (base / fork kind), repeat, success, followed_injection, steps, llm_calls, tool_calls, tokens, cost_usd, wall_ms, replayed_steps.
- `summary.json`: per agent × variant aggregates + paired statistics (McNemar exact p, paired bootstrap 95% CI) + replay savings.

## Viewer input

`web/data/index.json` (list of runs + summary) and `web/data/runs/<run_id>.json` (cassettes), copied from `data/`.
