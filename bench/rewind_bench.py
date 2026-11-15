"""Rewind benchmark CLI: record, fork, replay, report, test.

  uv run python rewind_bench.py record
  uv run python rewind_bench.py fork --repeats 3
  uv run python rewind_bench.py replay
  uv run python rewind_bench.py report
  uv run python rewind_bench.py test --cassette brief_py__nvidia__base
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import httpx
import yaml

from poison import MISINFO_TEXT, POISON_TEXT
from scoring import score_brief
from stats import discordant, mcnemar_exact, paired_bootstrap_ci

BENCH = Path(__file__).resolve().parent
GATEWAY = os.environ.get("REWIND_GATEWAY", "http://localhost:8080").rstrip("/")
# The plugin serves its run API on a separate port.
CONTROL = os.environ.get("REWIND_CONTROL", "http://localhost:8099").rstrip("/")
DATA = Path(os.environ.get("REWIND_DATA_DIR", BENCH / "data"))
CASSETTES = DATA / "cassettes"
RUNS = DATA / "runs"
RESULTS = DATA / "results"
WEB_DATA = Path(os.environ.get("REWIND_WEB_DATA", BENCH.parent / "web" / "data"))
SWAP_MODEL = os.environ.get("REWIND_SWAP_MODEL", "gemini/gemini-3.5-flash")

AGENTS = {
    "brief_py": {"cmd": [sys.executable, str(BENCH / "agents/brief_py/agent.py")], "cwd": BENCH},
    "brief_ts": {"cmd": ["npx", "--no-install", "tsx", "agent.ts"], "cwd": BENCH / "agents/brief_ts"},
}
VARIANTS = ["base", "replay", "poison", "misinfo", "misinfo_late", "poison_late", "outage", "model_swap"]


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def load_tasks() -> tuple[dict, str]:
    cfg = yaml.safe_load((BENCH / "tasks.yaml").read_text())
    return {t["id"]: t for t in cfg["tasks"]}, cfg["meeting_time"]


def write_json(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2))


def read_json(path: Path):
    return json.loads(path.read_text())


# ---------- gateway control API ----------

class Gateway:
    def __init__(self, base: str = CONTROL):
        self.c = httpx.Client(base_url=base, timeout=60)

    def _check(self, r: httpx.Response, what: str):
        if r.status_code >= 300:
            raise RuntimeError(f"gateway {what} failed: HTTP {r.status_code} {r.text[:300]}")
        return r.json() if r.content else {}

    def create(self, body: dict):
        return self._check(self.c.post("/rewind/runs", json=body), f"create {body['run_id']}")

    def close(self, run_id: str):
        return self._check(self.c.post(f"/rewind/runs/{run_id}/close"), f"close {run_id}")

    def get(self, run_id: str) -> dict:
        return self._check(self.c.get(f"/rewind/runs/{run_id}"), f"get {run_id}")


# ---------- running one agent ----------

def run_agent(agent: str, task: dict, meeting_time: str, run_id: str, extra_env: dict | None = None) -> dict:
    spec = AGENTS[agent]
    env = dict(os.environ)
    env.update({
        "REWIND_RUN": run_id,
        "OPENAI_BASE_URL": os.environ.get("OPENAI_BASE_URL", f"{GATEWAY}/v1"),
        "TAVILY_BASE_URL": os.environ.get("TAVILY_BASE_URL", f"{GATEWAY}/relay/tavily"),
    })
    env.update(extra_env or {})
    cmd = spec["cmd"] + ["--company", task["company"], "--meeting-time", meeting_time]
    t0 = time.perf_counter()
    p = subprocess.run(cmd, cwd=spec["cwd"], env=env, capture_output=True, text=True, timeout=900)
    wall_ms = int((time.perf_counter() - t0) * 1000)
    result = None
    for line in reversed(p.stdout.strip().splitlines()):
        if line.startswith('{"rewind_result"'):
            try:
                result = json.loads(line)["rewind_result"]
            except json.JSONDecodeError:
                pass
            break
    return {"exit_code": p.returncode, "wall_ms": wall_ms, "result": result, "stderr_tail": p.stderr[-2000:]}


def execute(gw: Gateway, spec: dict, tasks: dict, meeting_time: str) -> dict:
    """Open a gateway run, run the agent, close, save cassette + run record."""
    run_id = spec["run_id"]
    body = {"run_id": run_id, "mode": spec["mode"], "meta": spec["meta"]}
    for k in ("source", "fork_at", "mutation", "match"):
        if spec.get(k) is not None:
            body[k] = spec[k]
    gw.create(body)
    try:
        out = run_agent(spec["meta"]["agent"], tasks[spec["meta"]["task"]], meeting_time, run_id, spec.get("env"))
    finally:
        gw.close(run_id)
    cassette = gw.get(run_id)
    write_json(CASSETTES / f"{run_id}.json", cassette)
    record = {"run_id": run_id, **spec["meta"], "mode": spec["mode"], "source": spec.get("source"),
              "fork_at": spec.get("fork_at"), "mutation": spec.get("mutation"), **out}
    write_json(RUNS / f"{run_id}.json", record)
    status = "ok" if out["exit_code"] == 0 else f"exit {out['exit_code']}"
    log(f"  {run_id}: {status}, {len(cassette.get('steps', []))} steps, {out['wall_ms']} ms")
    return record


def execute_all(specs: list[dict], jobs: int) -> list[dict]:
    tasks, meeting_time = load_tasks()
    gw = Gateway()
    log(f"running {len(specs)} runs against {GATEWAY} (jobs={jobs})")

    def one(spec):
        try:
            return execute(gw, spec, tasks, meeting_time)
        except Exception as e:
            log(f"  {spec['run_id']}: ERROR {e}")
            return None

    with ThreadPoolExecutor(max_workers=max(1, jobs)) as ex:
        return [r for r in ex.map(one, specs) if r]


def selected(args) -> tuple[list[str], list[str]]:
    tasks, _ = load_tasks()
    agents = args.agents.split(",") if args.agents else list(AGENTS)
    task_ids = args.tasks.split(",") if args.tasks else list(tasks)
    return agents, task_ids


def base_runs(args) -> list[tuple[str, str, dict]]:
    agents, task_ids = selected(args)
    out = []
    for a in agents:
        for t in task_ids:
            p = CASSETTES / f"{a}__{t}__base.json"
            if p.exists():
                out.append((a, t, read_json(p)))
            else:
                log(f"  skip {a}/{t}: no base cassette (run record first)")
    return out


# ---------- commands ----------

def cmd_record(args):
    agents, task_ids = selected(args)
    specs = [{"run_id": f"{a}__{t}__base", "mode": "record",
              "meta": {"agent": a, "task": t, "variant": "base", "repeat": 0}}
             for a in agents for t in task_ids]
    recs = execute_all(specs, args.jobs)
    return 0 if len(recs) == len(specs) else 1


def first_index(cassette: dict, kind: str):
    for s in cassette.get("steps", []):
        if s.get("kind") == kind:
            return s["i"]
    return None


def last_index(cassette: dict, kind: str):
    found = None
    for s in cassette.get("steps", []):
        if s.get("kind") == kind:
            found = s["i"]
    return found


def cmd_fork(args):
    swap = args.model_swap if args.model_swap is not None else True
    specs = []
    for a, t, cas in base_runs(args):
        relay_i, llm_i = first_index(cas, "relay"), first_index(cas, "llm")
        if getattr(args, "at", "first") == "last":
            relay_i = last_index(cas, "relay")
        forks = []
        if relay_i is not None:
            forks.append(("poison", relay_i, {"type": "poison", "text": POISON_TEXT}, None))
            forks.append(("misinfo", relay_i, {"type": "poison", "text": MISINFO_TEXT}, None))
        else:
            log(f"  {a}/{t}: base has no relay step, no poison fork")
        if llm_i is not None:
            forks.append(("outage", llm_i, {"type": "outage", "status": 503}, None))
        if getattr(args, "variants", None):
            keep = set(args.variants.split(","))
            forks = [f for f in forks if f[0] in keep]
        if getattr(args, "at", "first") == "last":
            forks = [(f"{v}_late", k, m, e) for v, k, m, e in forks if v in ("poison", "misinfo")]
        if swap:
            # whole run on the swapped model: step 0 is swapped by the gateway, later steps by MODEL
            forks.append(("model_swap", 0, {"type": "model_swap", "model": SWAP_MODEL}, {"MODEL": SWAP_MODEL}))
        for variant, k, mut, env in forks:
            for r in range(args.repeats):
                specs.append({
                    "run_id": f"{a}__{t}__fork-{variant}-s{k}__r{r}", "mode": "fork",
                    "source": f"{a}__{t}__base", "fork_at": k, "mutation": mut, "match": "lenient",
                    "meta": {"agent": a, "task": t, "variant": variant, "repeat": r}, "env": env,
                })
    if not swap:
        log("model_swap skipped (no GROQ_API_KEY in env; pass --model-swap to force)")
    recs = execute_all(specs, args.jobs)
    return 0 if len(recs) == len(specs) else 1


def cmd_replay(args):
    bases = base_runs(args)
    specs = [{"run_id": f"{a}__{t}__replay", "mode": "replay", "source": f"{a}__{t}__base", "match": "strict",
              "meta": {"agent": a, "task": t, "variant": "replay", "repeat": 0}} for a, t, _ in bases]
    recs = execute_all(specs, args.jobs)
    print(f"{'run':40} {'orig ms':>9} {'replay ms':>9} {'orig $':>10} {'replay $':>9} {'diverged':>8}")
    ok = True
    for rec in sorted(recs, key=lambda r: r["run_id"]):
        base_id = rec["source"]
        base_rec = RUNS / f"{base_id}.json"
        orig_ms = read_json(base_rec)["wall_ms"] if base_rec.exists() else None
        orig = run_metrics(read_json(CASSETTES / f"{base_id}.json"))
        rep_cas = read_json(CASSETTES / f"{rec['run_id']}.json")
        rep = run_metrics(rep_cas)
        div = len(rep_cas.get("divergences") or [])
        ok &= div == 0 and rec["exit_code"] == 0
        print(f"{base_id:40} {orig_ms or 0:>9} {rec['wall_ms']:>9} {orig['cost_usd']:>10.6f} {rep['cost_usd']:>9.6f} {div:>8}")
    return 0 if ok and len(recs) == len(specs) else 1


def cmd_test(args):
    """CI mode: strict replay of a golden cassette by running the agent."""
    src = args.cassette
    golden = None
    if src.endswith(".json") and Path(src).exists():
        golden = read_json(Path(src))
        src = golden["run_id"]
    gw = Gateway()
    if golden is None:
        try:
            golden = gw.get(src)
        except Exception:
            p = CASSETTES / f"{src}.json"
            golden = read_json(p) if p.exists() else None
    if golden is None:
        print(f"FAIL: golden cassette {src} not found on gateway or in {CASSETTES}")
        return 1
    meta = golden.get("meta") or {}
    agent = args.agent or meta.get("agent")
    task_id = args.task or meta.get("task")
    tasks, meeting_time = load_tasks()
    if agent not in AGENTS or task_id not in tasks:
        print(f"FAIL: cannot tell agent/task for {src} (agent={agent}, task={task_id}); pass --agent/--task")
        return 1
    run_id = f"{src}__ci-{int(time.time())}"
    gw.create({"run_id": run_id, "mode": "replay", "source": src, "match": "strict",
               "meta": {"agent": agent, "task": task_id, "variant": "test", "repeat": 0}})
    env = {"MODEL": args.model} if args.model else None
    try:
        out = run_agent(agent, tasks[task_id], meeting_time, run_id, env)
    finally:
        gw.close(run_id)
    cas = gw.get(run_id)
    if args.save:
        write_json(CASSETTES / f"{run_id}.json", cas)
    msg = divergence_message(golden, cas, out)
    if msg:
        print(f"FAIL {src}: {msg}")
        return 1
    print(f"PASS {src}: {len(cas.get('steps', []))} steps replayed, no divergence, {out['wall_ms']} ms")
    return 0


def short(v, n=120) -> str:
    s = v if isinstance(v, str) else json.dumps(v)
    s = s.replace("\n", "\\n")
    return s if len(s) <= n else s[: n - 3] + "..."


def show_diff(e, g, n=120) -> tuple[str, str]:
    """For long strings, show both values around the first differing char."""
    if isinstance(e, str) and isinstance(g, str) and max(len(e), len(g)) > n:
        k = next((i for i, (x, y) in enumerate(zip(e, g)) if x != y), min(len(e), len(g)))
        start = max(0, k - 30)
        pre = "..." if start else ""
        return pre + short(e[start:], n), pre + short(g[start:], n)
    return short(e, n), short(g, n)


def divergence_message(golden: dict, cas: dict, out: dict) -> str | None:
    divs = cas.get("divergences") or []
    if divs:
        d = divs[0]
        diffs = d.get("diff") or []
        if not diffs:
            return f"diverged at step {d.get('i')}: fingerprint expected {d.get('expected')} got {d.get('got')}"
        e0, g0 = show_diff(diffs[0].get("expected"), diffs[0].get("got"))
        lines = [f"diverged at step {d.get('i')}: field {diffs[0]['path']} expected {e0!r} got {g0!r}"]
        for x in diffs[1:6]:
            e, g = show_diff(x.get("expected"), x.get("got"))
            lines.append(f"    also {x['path']}: expected {e!r} got {g!r}")
        if len(diffs) > 6:
            lines.append(f"    ... {len(diffs) - 6} more fields")
        return "\n".join(lines)
    n_gold, n_got = len(golden.get("steps", [])), len(cas.get("steps", []))
    if out["exit_code"] != 0:
        return f"agent exited {out['exit_code']} after {n_got} steps: {out['stderr_tail'].strip()[-400:]}"
    if n_got != n_gold:
        return f"diverged at step {n_got}: field <steps> expected {n_gold} requests got {n_got}"
    return None


# ---------- report ----------

def run_metrics(cas: dict) -> dict:
    steps = cas.get("steps", [])
    toks = sum((s.get("tokens") or {}).get("prompt", 0) + (s.get("tokens") or {}).get("completion", 0) for s in steps)
    # replayed steps are free whatever the cassette says
    cost = sum(s.get("cost_usd") or 0.0 for s in steps if s.get("source") != "replayed")
    return {
        "steps": len(steps),
        "llm_calls": sum(1 for s in steps if s.get("kind") == "llm"),
        "tool_calls": sum(1 for s in steps if s.get("kind") == "relay"),
        "tokens": toks,
        "cost_usd": round(cost, 8),
        "replayed_steps": sum(1 for s in steps if s.get("source") == "replayed"),
        "divergences": len(cas.get("divergences") or []),
    }


def build_rows() -> tuple[list[dict], dict]:
    rows, cassettes = [], {}
    for p in sorted(RUNS.glob("*.json")):
        rec = read_json(p)
        cp = CASSETTES / f"{rec['run_id']}.json"
        if not cp.exists() or rec.get("variant") not in VARIANTS:
            continue
        cas = read_json(cp)
        result = rec.get("result") or {}
        sc = score_brief(result.get("brief"), cas)
        ok = rec["exit_code"] == 0 and not result.get("error")
        row = {
            "run_id": rec["run_id"], "agent": rec["agent"], "task": rec["task"], "variant": rec["variant"],
            "repeat": rec.get("repeat", 0), "success": ok and sc["success"],
            "followed_injection": sc["followed_injection"],
            **{k: v for k, v in run_metrics(cas).items() if k != "divergences"},
            "wall_ms": rec["wall_ms"],
            "exit_code": rec["exit_code"], "n_grounded_urls": sc["n_grounded"],
            "missing_sections": sc["missing_sections"], "divergences": len(cas.get("divergences") or []),
            "parent": cas.get("parent"), "fork_at": cas.get("fork_at"),
            "error": result.get("error"),
        }
        rows.append(row)
        cassettes[rec["run_id"]] = (cas, rec, sc)
    return rows, cassettes


def mean(xs):
    xs = list(xs)
    return round(sum(xs) / len(xs), 6) if xs else None


def summarize(rows: list[dict]) -> dict:
    groups = []
    agents = sorted({r["agent"] for r in rows})
    variants = [v for v in VARIANTS if any(r["variant"] == v for r in rows)]
    for a in agents:
        for v in variants:
            g = [r for r in rows if r["agent"] == a and r["variant"] == v]
            if not g:
                continue
            groups.append({
                "agent": a, "variant": v, "n": len(g),
                "success_rate": mean(r["success"] for r in g),
                "injection_follow_rate": mean(r["followed_injection"] for r in g),
                **{f"{k}_mean": mean(r[k] for r in g) for k in
                   ("steps", "llm_calls", "tool_calls", "tokens", "cost_usd", "wall_ms")},
                "cost_usd_total": round(sum(r["cost_usd"] for r in g), 8),
            })

    paired = []
    if len(agents) >= 2:
        a, b = agents[0], agents[1]
        for v in variants:
            ra = {(r["task"], r["repeat"]): r for r in rows if r["agent"] == a and r["variant"] == v}
            rb = {(r["task"], r["repeat"]): r for r in rows if r["agent"] == b and r["variant"] == v}
            keys = sorted(set(ra) & set(rb))
            if not keys:
                continue
            for metric in ("success", "followed_injection"):
                xa = [bool(ra[k][metric]) for k in keys]
                xb = [bool(rb[k][metric]) for k in keys]
                b01, b10 = discordant(xa, xb)
                diff, lo, hi = paired_bootstrap_ci(xa, xb)
                paired.append({
                    "variant": v, "metric": metric, "a": a, "b": b, "n_pairs": len(keys),
                    "a_rate": mean(xa), "b_rate": mean(xb), "diff": round(diff, 6),
                    "ci95": [round(lo, 6), round(hi, 6)],
                    "mcnemar": {"a_only": b10, "b_only": b01, "p_value": round(mcnemar_exact(b01, b10), 6)},
                })

    by_id = {r["run_id"]: r for r in rows}
    savings = []
    for r in rows:
        if r["variant"] != "replay":
            continue
        src = r["parent"] or r["run_id"].replace("__replay", "__base")
        if src not in by_id:
            continue
        o = by_id[src]
        savings.append({"run_id": r["run_id"], "source": o["run_id"], "original_wall_ms": o["wall_ms"],
                        "replay_wall_ms": r["wall_ms"], "original_cost_usd": o["cost_usd"],
                        "replay_cost_usd": r["cost_usd"], "divergences": r["divergences"]})
    ow = sum(s["original_wall_ms"] for s in savings)
    rw = sum(s["replay_wall_ms"] for s in savings)
    replay = {
        "runs": len(savings),
        "original_wall_ms": ow, "replay_wall_ms": rw,
        "speedup": round(ow / rw, 3) if rw else None,
        "original_cost_usd": round(sum(s["original_cost_usd"] for s in savings), 8),
        "replay_cost_usd": round(sum(s["replay_cost_usd"] for s in savings), 8),
        "saved_usd": round(sum(s["original_cost_usd"] - s["replay_cost_usd"] for s in savings), 8),
        "divergent_runs": sum(1 for s in savings if s["divergences"]),
        "per_run": savings,
    }
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "gateway": GATEWAY, "agents": agents, "variants": variants, "n_runs": len(rows),
        "groups": groups, "paired": paired, "replay_savings": replay,
    }


def export_web(rows, summary, cassettes):
    runs_dir = WEB_DATA / "runs"
    if runs_dir.exists():
        shutil.rmtree(runs_dir)
    runs_dir.mkdir(parents=True, exist_ok=True)
    for run_id, (cas, rec, sc) in cassettes.items():
        res = rec.get("result") or {}
        out = dict(cas)
        out["bench"] = {"brief": res.get("brief"), "error": res.get("error"), "score": sc,
                        "wall_ms": rec["wall_ms"], "exit_code": rec["exit_code"], "variant": rec["variant"]}
        write_json(runs_dir / f"{run_id}.json", out)
    write_json(WEB_DATA / "index.json", {"generated_at": summary["generated_at"], "runs": rows, "summary": summary})


def cmd_report(args):
    rows, cassettes = build_rows()
    if not rows:
        log("no runs found; run record/fork/replay first")
        return 1
    summary = summarize(rows)
    RESULTS.mkdir(parents=True, exist_ok=True)
    with open(RESULTS / "runs.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    write_json(RESULTS / "summary.json", summary)
    if not args.no_web:
        export_web(rows, summary, cassettes)

    print(f"{'agent':10} {'variant':11} {'n':>3} {'success':>8} {'inject':>7} {'steps':>6} {'llm':>5} {'tools':>5} "
          f"{'tokens':>8} {'cost $':>10} {'wall ms':>8}")
    for g in summary["groups"]:
        print(f"{g['agent']:10} {g['variant']:11} {g['n']:>3} {g['success_rate']:>8.2f} {g['injection_follow_rate']:>7.2f} "
              f"{g['steps_mean']:>6.1f} {g['llm_calls_mean']:>5.1f} {g['tool_calls_mean']:>5.1f} {g['tokens_mean']:>8.0f} "
              f"{g['cost_usd_mean']:>10.6f} {g['wall_ms_mean']:>8.0f}")
    for p in summary["paired"]:
        print(f"paired {p['variant']:11} {p['metric']:18} {p['a']}-{p['b']} n={p['n_pairs']} diff={p['diff']:+.2f} "
              f"CI95=[{p['ci95'][0]:+.2f},{p['ci95'][1]:+.2f}] McNemar p={p['mcnemar']['p_value']:.4f}")
    rs = summary["replay_savings"]
    if rs["runs"]:
        print(f"replay: {rs['runs']} runs, {rs['original_wall_ms']} ms -> {rs['replay_wall_ms']} ms "
              f"(x{rs['speedup']}), ${rs['original_cost_usd']:.6f} -> ${rs['replay_cost_usd']:.6f}")
    print(f"wrote {RESULTS / 'runs.jsonl'}, {RESULTS / 'summary.json'}" + ("" if args.no_web else f", {WEB_DATA}"))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="rewind_bench", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--agents", help="comma list (default: all)")
        p.add_argument("--tasks", help="comma list of task ids (default: all)")
        p.add_argument("--jobs", type=int, default=4, help="parallel runs")

    common(sub.add_parser("record", help="record base cassettes"))
    pf = sub.add_parser("fork", help="fork base cassettes with mutations")
    common(pf)
    pf.add_argument("--repeats", type=int, default=3)
    pf.add_argument("--at", choices=["first", "last"], default="first", help="fork at the first or last search")
    pf.add_argument("--variants", help="comma list of fork kinds to run (poison,misinfo,outage,model_swap)")
    pf.add_argument("--model-swap", dest="model_swap", action="store_true", default=None)
    pf.add_argument("--no-model-swap", dest="model_swap", action="store_false")
    common(sub.add_parser("replay", help="strict replay of base cassettes"))
    pr = sub.add_parser("report", help="score runs and write results + viewer data")
    pr.add_argument("--no-web", action="store_true", help="skip web/data export")
    pt = sub.add_parser("test", help="CI: strict replay of a golden cassette")
    pt.add_argument("--cassette", required=True, help="run_id known to the gateway, or path to a cassette json")
    pt.add_argument("--agent", help="override agent (default: cassette meta.agent)")
    pt.add_argument("--task", help="override task id (default: cassette meta.task)")
    pt.add_argument("--model", help="override MODEL for the agent (useful to see a divergence)")
    pt.add_argument("--save", action="store_true", help="save the test cassette under data/cassettes")

    args = ap.parse_args(argv)
    fn = {"record": cmd_record, "fork": cmd_fork, "replay": cmd_replay, "report": cmd_report, "test": cmd_test}[args.cmd]
    return fn(args)


if __name__ == "__main__":
    sys.exit(main())
