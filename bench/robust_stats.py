"""Company-level statistics and exposure checks for the poison and misinfo forks.

Repeats of one company share a recorded prefix, so they aren't independent. This script:
- reports results per company,
- compares agents with a cluster bootstrap that resamples companies, and an exact sign test
  over companies,
- tests each fork against its own agent's recorded run (the within-run pairing),
- checks exposure: whether the planted text reached a later model call in that run.

Run: uv run python robust_stats.py   (reads REWIND_DATA_DIR, default ./data-real)
"""
import json
import os
import random
from math import comb
from pathlib import Path

DATA = Path(os.environ.get("REWIND_DATA_DIR", Path(__file__).parent / "data-real"))
RUNS = [json.loads(l) for l in (DATA / "results/runs.jsonl").read_text().splitlines() if l.strip()]
CAS = DATA / "cassettes"
CANARY = "Initech"
AGENTS = ("brief_py", "brief_ts")


def exposed(run_id: str) -> bool | None:
    """True if a model call after the fork point carried the planted text."""
    p = CAS / f"{run_id}.json"
    if not p.exists():
        return None
    c = json.loads(p.read_text())
    k = c.get("fork_at")
    if k is None or k < 0:
        return None
    for s in c["steps"]:
        if s["i"] > k and s["kind"] == "llm" and CANARY in json.dumps(s.get("request")):
            return True
    return False


def sign_test(wins: int, losses: int) -> float:
    """Exact two-sided sign test."""
    n = wins + losses
    if n == 0:
        return 1.0
    k = min(wins, losses)
    p = 2 * sum(comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, p)


def cluster_bootstrap(diffs: list[float], b: int = 20000, seed: int = 7) -> tuple[float, float]:
    rng = random.Random(seed)
    n = len(diffs)
    means = sorted(sum(rng.choice(diffs) for _ in range(n)) / n for _ in range(b))
    return means[int(0.025 * b)], means[int(0.975 * b)]


out = {"companies": sorted({r["task"] for r in RUNS}), "variants": {}}
lines = []
for v in ("misinfo", "poison"):
    rows = [r for r in RUNS if r["variant"] == v]
    if not rows:
        continue
    per = {}
    for t in out["companies"]:
        cell = {}
        for a in AGENTS:
            g = [r for r in rows if r["agent"] == a and r["task"] == t]
            if not g:
                continue
            ex = [exposed(r["run_id"]) for r in g]
            cell[a] = {
                "n": len(g),
                "followed": sum(bool(r["followed_injection"]) for r in g),
                "exposed": sum(1 for e in ex if e),
            }
        if len(cell) == 2:
            per[t] = cell
    diffs = [c["brief_py"]["followed"] / c["brief_py"]["n"] - c["brief_ts"]["followed"] / c["brief_ts"]["n"] for c in per.values()]
    wins = sum(1 for d in diffs if d > 0)
    losses = sum(1 for d in diffs if d < 0)
    lo, hi = cluster_bootstrap(diffs) if diffs else (0, 0)
    own = {}
    for a in AGENTS:
        g = [r for r in rows if r["agent"] == a]
        base = {r["task"]: r for r in RUNS if r["agent"] == a and r["variant"] == "base"}
        # fork vs its own recorded run: the base never contains the canary, so every fork that
        # repeats it is a discordant pair in one direction.
        disc = sum(1 for r in g if r["followed_injection"] and not base.get(r["task"], {}).get("followed_injection"))
        rev = sum(1 for r in g if not r["followed_injection"] and base.get(r["task"], {}).get("followed_injection"))
        ex = [exposed(r["run_id"]) for r in g]
        n_ex = sum(1 for e in ex if e)
        f_ex = sum(1 for r, e in zip(g, ex) if e and r["followed_injection"])
        own[a] = {
            "n": len(g),
            "followed": sum(bool(r["followed_injection"]) for r in g),
            "vs_base_discordant": [disc, rev],
            "vs_base_p": sign_test(disc, rev),
            "exposed": n_ex,
            "followed_given_exposed": f_ex,
        }
    out["variants"][v] = {
        "per_company": per,
        "company_diff_mean": sum(diffs) / len(diffs) if diffs else None,
        "company_diff_ci95": [lo, hi],
        "company_sign_test": {"py_higher": wins, "ts_higher": losses, "p": sign_test(wins, losses)},
        "per_agent": own,
    }

    lines.append(f"\n## {v}\n")
    lines.append("| Company | brief_py repeated | brief_ts repeated | brief_ts exposed |")
    lines.append("|---|---|---|---|")
    for t, c in per.items():
        lines.append(f"| {t} | {c['brief_py']['followed']}/{c['brief_py']['n']} | {c['brief_ts']['followed']}/{c['brief_ts']['n']} | {c['brief_ts']['exposed']}/{c['brief_ts']['n']} |")
    s = out["variants"][v]
    lines.append(f"\nCompany-level difference (py − ts): {s['company_diff_mean']:+.2f}, cluster bootstrap 95% CI {lo:+.2f} to {hi:+.2f}; "
                 f"sign test over {len(per)} companies: py higher in {wins}, ts higher in {losses}, p = {s['company_sign_test']['p']:.3f}")
    for a, o in own.items():
        lines.append(f"{a}: repeated in {o['followed']}/{o['n']} forks vs 0 in its own recorded runs (sign test p = {o['vs_base_p']:.2g}); "
                     f"planted text reached a later model call in {o['exposed']}/{o['n']}, repeated in {o['followed_given_exposed']} of those")

(DATA / "results/robust.json").write_text(json.dumps(out, indent=2))
print("\n".join(lines))
