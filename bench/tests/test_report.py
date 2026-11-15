import rewind_bench as rb


def row(agent, task, variant, repeat, success, inj=False, **kw):
    base = {"run_id": f"{agent}__{task}__{variant}__r{repeat}", "agent": agent, "task": task, "variant": variant,
            "repeat": repeat, "success": success, "followed_injection": inj, "steps": 5, "llm_calls": 2,
            "tool_calls": 3, "tokens": 100, "cost_usd": 0.001, "wall_ms": 1000, "replayed_steps": 0,
            "divergences": 0, "parent": None}
    base.update(kw)
    return base


def test_summary_pairs_and_replay():
    rows = []
    for r in range(4):
        rows.append(row("brief_py", "t1", "poison", r, True))
        rows.append(row("brief_ts", "t1", "poison", r, False, inj=True))
    rows.append(row("brief_py", "t1", "base", 0, True, run_id="brief_py__t1__base"))
    rows.append(row("brief_py", "t1", "replay", 0, True, run_id="brief_py__t1__replay", parent="brief_py__t1__base",
                    wall_ms=100, cost_usd=0.0, replayed_steps=5))
    s = rb.summarize(rows)
    p = next(x for x in s["paired"] if x["variant"] == "poison" and x["metric"] == "success")
    assert p["n_pairs"] == 4 and p["diff"] == 1.0
    assert p["mcnemar"]["a_only"] == 4 and abs(p["mcnemar"]["p_value"] - 0.125) < 1e-9
    assert s["replay_savings"]["speedup"] == 10.0 and s["replay_savings"]["replay_cost_usd"] == 0.0


def test_run_metrics_replayed_steps_are_free():
    cas = {"steps": [
        {"kind": "llm", "source": "replayed", "cost_usd": 0.5, "tokens": {"prompt": 10, "completion": 5}},
        {"kind": "relay", "source": "live", "cost_usd": 0.0},
        {"kind": "llm", "source": "live", "cost_usd": 0.25, "tokens": {"prompt": 1, "completion": 1}},
    ]}
    m = rb.run_metrics(cas)
    assert m["cost_usd"] == 0.25 and m["llm_calls"] == 2 and m["tool_calls"] == 1
    assert m["tokens"] == 17 and m["replayed_steps"] == 1


def test_divergence_message_format():
    cas = {"steps": [], "divergences": [{"i": 2, "diff": [
        {"path": "messages[1].content", "expected": "a" * 200 + "X", "got": "a" * 200 + "Y"}]}]}
    msg = rb.divergence_message({"steps": [{}] * 3}, cas, {"exit_code": 1, "stderr_tail": ""})
    assert msg.startswith("diverged at step 2: field messages[1].content expected")
    assert "X" in msg and "Y" in msg


def test_divergence_message_step_count():
    msg = rb.divergence_message({"steps": [{}] * 5}, {"steps": [{}] * 4, "divergences": []},
                                {"exit_code": 0, "stderr_tail": ""})
    assert msg == "diverged at step 4: field <steps> expected 5 requests got 4"
