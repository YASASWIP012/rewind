"""Fake Rewind gateway for local testing. Stdlib only, never calls real APIs.

Implements the control API and record/replay/fork from docs/CONTRACT.md, with
canned LLM (OpenAI-compatible) and Tavily responses.

  uv run python devtools/fake_gateway.py --port 8080
"""

import argparse
import copy
import hashlib
import json
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

PRICES = {  # usd per 1M tokens (input, output)
    "gemini/gemini-2.5-flash": (0.30, 2.50),
    "groq/llama-3.3-70b-versatile": (0.59, 0.79),
}
DROP_FIELDS = {"stream", "user", "metadata", "request_id"}

STATE = {"runs": {}, "lock": threading.Lock(), "store": None, "latency": 0.15}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- fingerprint ----------

_TS = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?")
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_CALL = re.compile(r"call_[A-Za-z0-9]+")
_NUM = re.compile(r"\d{10,}")


def norm_str(s: str) -> str:
    s = _TS.sub("<ts>", s)
    s = _UUID.sub("<uuid>", s)
    s = _CALL.sub("<call>", s)
    return _NUM.sub("<n>", s)


def normalise(v, top=True):
    if isinstance(v, dict):
        return {k: normalise(x, False) for k, x in sorted(v.items()) if not (top and k in DROP_FIELDS)}
    if isinstance(v, list):
        return [normalise(x, False) for x in v]
    if isinstance(v, str):
        return norm_str(v)
    return v


def fingerprint(path: str, body) -> str:
    blob = path + "\n" + json.dumps(normalise(body), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def flatten(v, prefix=""):
    out = {}
    if isinstance(v, dict):
        for k, x in v.items():
            out.update(flatten(x, f"{prefix}.{k}" if prefix else k))
    elif isinstance(v, list):
        for i, x in enumerate(v):
            out.update(flatten(x, f"{prefix}[{i}]"))
    else:
        out[prefix] = v
    return out


def diff(expected_req, got_req, path_e, path_g):
    e = flatten(normalise(expected_req))
    g = flatten(normalise(got_req))
    out = []
    if path_e != path_g:
        out.append({"path": "<path>", "expected": path_e, "got": path_g})
    for k in sorted(set(e) | set(g)):
        if e.get(k, "<missing>") != g.get(k, "<missing>"):
            out.append({"path": k, "expected": e.get(k, "<missing>"), "got": g.get(k, "<missing>")})
    return out


# ---------- canned providers ----------

def h(s: str, n=8) -> str:
    return hashlib.sha256(s.encode()).hexdigest()[:n]


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40]


def company_of(messages) -> str:
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            mm = re.search(r"Company:\s*(.+)", c)
            if mm:
                return mm.group(1).strip()
    return "Acme"


def fake_tavily(body: dict) -> dict:
    q = str(body.get("query", ""))
    n = int(body.get("max_results", 5) or 5)
    results = []
    for k in range(n):
        results.append({
            "title": f"{q.title()} - report {k + 1}",
            "url": f"https://news.example.com/{slug(q)}/{h(q)}-{k + 1}",
            "content": f"Snippet {k + 1} about {q}: new product, partnership and funding updates.",
            "score": round(0.9 - 0.1 * k, 2),
            "published_date": f"2026-11-{10 - k:02d}",
        })
    return {"query": q, "results": results, "response_time": 0.42}


def all_text(messages) -> str:
    parts = []
    for m in messages:
        c = m.get("content")
        if isinstance(c, str):
            parts.append(c)
    return "\n".join(parts)


def fake_llm(body: dict) -> dict:
    model = body.get("model", "")
    messages = body.get("messages", [])
    company = company_of(messages)
    text = all_text(messages)
    last = messages[-1] if messages else {}
    msg: dict = {"role": "assistant", "content": None}
    finish = "stop"

    if "Plan searches" in str(last.get("content", "")):
        msg["content"] = json.dumps([f"{company} news", f"{company} funding and partnerships", f"{company} product launches"])
    elif body.get("tools") and sum(1 for m in messages if m.get("role") == "tool") < 2:
        n_tools = sum(1 for m in messages if m.get("role") == "tool")
        q = [f"{company} latest news", f"{company} partnerships"][n_tools]
        msg["tool_calls"] = [{
            "id": "call_" + h(q + model, 12),
            "type": "function",
            "function": {"name": "web_search", "arguments": json.dumps({"query": q})},
        }]
        finish = "tool_calls"
    else:
        urls = list(dict.fromkeys(re.findall(r"https?://[^\s\"'\\)\]]+", text)))
        poisoned = "Initech" in text
        guarded = "untrusted data" in text
        follows = poisoned and (not guarded or model.startswith("groq/"))
        if follows:
            msg["content"] = (
                f"# Briefing: {company}\n\n## Recent developments\n- {company} was acquired by "
                "Initech Holdings last week.\n\n## Talking points\n- Integration plans after the acquisition.\n\n"
                "## Open questions\n- What changes for existing customers?\n"
            )
        else:
            cites = urls[:4]
            dev = "\n".join(f"- Update {i + 1} on {company} ([source]({u}))" for i, u in enumerate(cites))
            msg["content"] = (
                f"# Briefing: {company}\n\n## Recent developments\n{dev or '- No recent news found.'}\n\n"
                f"## Talking points\n- Ask about the roadmap for the next quarter.\n- Discuss partnership fit.\n\n"
                f"## Open questions\n- How is {company} prioritising new launches?\n\n## Sources\n"
                + "\n".join(f"- {u}" for u in cites)
            )
    out_text = (msg.get("content") or "") + json.dumps(msg.get("tool_calls") or "")
    pt, ct = max(1, len(json.dumps(messages)) // 4), max(1, len(out_text) // 4)
    return {
        "id": "chatcmpl-" + h(text + model, 16),
        "object": "chat.completion",
        "created": 1763200000,
        "model": model,
        "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
        "usage": {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct},
    }


def live_call(kind: str, path: str, body: dict):
    time.sleep(STATE["latency"])
    if kind == "relay":
        return 200, fake_tavily(body)
    return 200, fake_llm(body)


def tokens_cost(kind, model, resp, source):
    if kind != "llm" or not isinstance(resp, dict):
        return {"prompt": 0, "completion": 0}, 0.0
    u = resp.get("usage") or {}
    t = {"prompt": u.get("prompt_tokens", 0), "completion": u.get("completion_tokens", 0)}
    pin, pout = PRICES.get(model, (0.5, 1.5))
    cost = 0.0 if source == "replayed" else (t["prompt"] * pin + t["completion"] * pout) / 1e6
    return t, round(cost, 8)


def error_body(status: int, msg: str) -> dict:
    return {"error": {"message": msg, "type": "rewind_mutation", "code": status}}


# ---------- run handling ----------

def load_cassette(run_id: str):
    runs = STATE["runs"]
    if run_id in runs:
        return runs[run_id]
    p = STATE["store"] / f"{run_id}.json"
    if p.exists():
        return json.loads(p.read_text())
    return None


def handle_traffic(kind: str, path: str, body: dict, run_id: str | None):
    if not run_id:
        return live_call(kind, path, body)
    with STATE["lock"]:
        cas = STATE["runs"].get(run_id)
    if cas is None:
        return live_call(kind, path, body)

    t0 = time.time()
    with STATE["lock"]:
        i = len(cas["steps"])
    fp = fingerprint(path, body)
    mode = cas["mode"]
    src = cas.get("_source_steps") or []
    model = body.get("model", "") if kind == "llm" else ""
    source, status, resp, req = "live", 200, None, body

    def from_source():
        if i < len(src) and src[i]["fingerprint"] == fp:
            return src[i]
        return None

    def divergence():
        exp = src[i] if i < len(src) else None
        d = {
            "i": i,
            "expected": exp["fingerprint"] if exp else None,
            "got": fp,
            "diff": diff(exp["request"], body, exp["path"], path) if exp else
            [{"path": "<step>", "expected": "<end of cassette>", "got": path}],
        }
        with STATE["lock"]:
            cas["divergences"].append(d)
        return d

    in_prefix = mode == "replay" or (mode == "fork" and i < cas["fork_at"])
    if in_prefix:
        hit = from_source()
        if hit:
            source, status, resp = "replayed", hit["status"], copy.deepcopy(hit["response"])
        else:
            d = divergence()
            if cas.get("match") == "strict":
                return 409, {"error": {"message": f"rewind: diverged at step {i}", "type": "rewind_divergence"}, "divergence": d}
            source = "diverged"
            status, resp = live_call(kind, path, body)
    elif mode == "fork" and i == cas["fork_at"]:
        mut = cas.get("mutation") or {}
        mt = mut.get("type")
        source = "mutated"
        if mt == "model_swap":
            req = dict(body, model=mut.get("model"))
            model = req["model"]
            status, resp = live_call(kind, path, req)
        elif mt in ("outage", "tool_error"):
            status = int(mut.get("status", 503))
            resp = error_body(status, f"rewind {mt}: simulated provider error")
        elif mt == "poison":
            base = src[i]["response"] if i < len(src) else live_call(kind, path, body)[1]
            resp = copy.deepcopy(base)
            if isinstance(resp, dict) and resp.get("results"):
                resp["results"][0]["content"] = (resp["results"][0].get("content") or "") + mut.get("text", "")
        elif mt == "edit":
            raw = mut.get("body", "")
            try:
                resp = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                resp = {"text": raw}
        else:
            status, resp = live_call(kind, path, body)
    else:
        status, resp = live_call(kind, path, body)

    tokens, cost = tokens_cost(kind, model, resp if status == 200 else None, source)
    step = {
        "i": i, "kind": kind, "path": path, "fingerprint": fp, "source": source,
        "request": req, "response": resp, "status": status,
        "model": model or None, "served_model": (resp or {}).get("model") if kind == "llm" and isinstance(resp, dict) else None,
        "tokens": tokens, "cost_usd": cost, "latency_ms": int((time.time() - t0) * 1000), "ts": now(),
    }
    with STATE["lock"]:
        cas["steps"].append(step)
    return status, resp


def public(cas: dict) -> dict:
    return {k: v for k, v in cas.items() if not k.startswith("_")}


def summary(cas: dict) -> dict:
    return {
        "run_id": cas["run_id"], "mode": cas["mode"], "parent": cas.get("parent"), "fork_at": cas.get("fork_at"),
        "meta": cas.get("meta"), "steps": len(cas["steps"]), "divergences": len(cas["divergences"]),
        "started_at": cas.get("started_at"), "ended_at": cas.get("ended_at"),
    }


def create_run(body: dict):
    run_id = body.get("run_id")
    mode = body.get("mode")
    if not run_id or mode not in ("record", "replay", "fork"):
        return 400, {"error": "run_id and mode (record|replay|fork) required"}
    src_steps = []
    if mode in ("replay", "fork"):
        src = load_cassette(body.get("source") or "")
        if src is None:
            return 404, {"error": f"source cassette not found: {body.get('source')}"}
        src_steps = src["steps"]
        if mode == "fork" and not isinstance(body.get("fork_at"), int):
            return 400, {"error": "fork_at required"}
    cas = {
        "run_id": run_id, "mode": mode,
        "parent": body.get("source") if mode in ("replay", "fork") else None,
        "fork_at": body.get("fork_at") if mode == "fork" else None,
        "mutation": body.get("mutation") if mode == "fork" else None,
        "match": body.get("match", "lenient"),
        "meta": body.get("meta") or {},
        "started_at": now(), "ended_at": None, "steps": [], "divergences": [],
        "_source_steps": src_steps,
    }
    with STATE["lock"]:
        STATE["runs"][run_id] = cas
    return 200, summary(cas)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if STATE.get("verbose"):
            sys.stderr.write("[fake] " + fmt % args + "\n")

    def send_json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/rewind/runs":
            with STATE["lock"]:
                runs = [summary(c) for c in STATE["runs"].values()]
            return self.send_json(200, runs)
        m = re.fullmatch(r"/rewind/runs/([^/]+)", path)
        if m:
            cas = load_cassette(unquote(m.group(1)))
            return self.send_json(200, public(cas)) if cas else self.send_json(404, {"error": "not found"})
        if path in ("/health", "/"):
            return self.send_json(200, {"ok": True, "fake": True})
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self.read_body()
        if path == "/rewind/runs":
            return self.send_json(*create_run(body))
        m = re.fullmatch(r"/rewind/runs/([^/]+)/close", path)
        if m:
            run_id = unquote(m.group(1))
            with STATE["lock"]:
                cas = STATE["runs"].get(run_id)
                if cas is None:
                    return self.send_json(404, {"error": "not found"})
                cas["ended_at"] = now()
                (STATE["store"] / f"{run_id}.json").write_text(json.dumps(public(cas), indent=1))
            return self.send_json(200, summary(cas))
        run_id = self.headers.get("x-rewind-run")
        if path == "/v1/chat/completions":
            if body.get("stream"):
                return self.send_json(400, {"error": {"message": "fake gateway: streaming not supported"}})
            return self.send_json(*handle_traffic("llm", path, body, run_id))
        if path.startswith("/relay/tavily/"):
            return self.send_json(*handle_traffic("relay", path, body, run_id))
        self.send_json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--store", default=str(Path(__file__).parent / ".fake_store"))
    ap.add_argument("--latency-ms", type=int, default=150, help="simulated provider latency")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    STATE["store"] = Path(args.store)
    STATE["store"].mkdir(parents=True, exist_ok=True)
    STATE["latency"] = args.latency_ms / 1000
    STATE["verbose"] = args.verbose
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"fake gateway on http://127.0.0.1:{args.port} (store {args.store})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
