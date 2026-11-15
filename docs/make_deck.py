"""Builds docs/Rewind.pptx from the benchmark results.

Run: uv run --with python-pptx python docs/make_deck.py
"""
import json
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN
from pptx.util import Emu, Pt

ROOT = Path(__file__).resolve().parent.parent
SUMMARY = json.loads((ROOT / "bench/results/summary.json").read_text())
RUNS = [json.loads(l) for l in (ROOT / "bench/results/runs.jsonl").read_text().splitlines() if l.strip()]
EXTRA = json.loads((ROOT / "docs/deck_extra.json").read_text())

BG = RGBColor(0x0E, 0x11, 0x16)
FG = RGBColor(0xE8, 0xEA, 0xED)
MUTED = RGBColor(0x9A, 0xA3, 0xAE)
ACCENT = RGBColor(0x5B, 0x9C, 0xFF)
RED = RGBColor(0xFF, 0x6B, 0x6B)
GREEN = RGBColor(0x4A, 0xD6, 0x8B)
PANEL = RGBColor(0x18, 0x1C, 0x24)

prs = Presentation()
prs.slide_width, prs.slide_height = Emu(12192000), Emu(6858000)
W, H = prs.slide_width, prs.slide_height
IN = 914400


def slide():
    s = prs.slides.add_slide(prs.slide_layouts[6])
    bg = s.background.fill
    bg.solid()
    bg.fore_color.rgb = BG
    return s


def text(s, x, y, w, h, body, size=20, color=FG, bold=False, align=PP_ALIGN.LEFT, font="Inter"):
    tb = s.shapes.add_textbox(int(x * IN), int(y * IN), int(w * IN), int(h * IN))
    tf = tb.text_frame
    tf.word_wrap = True
    lines = body if isinstance(body, list) else [body]
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = line
        r.font.size = Pt(size)
        r.font.color.rgb = color
        r.font.bold = bold
        r.font.name = font
        p.space_after = Pt(size * 0.45)
    return tb


def box(s, x, y, w, h, fill=PANEL, line=None):
    shp = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, int(x * IN), int(y * IN), int(w * IN), int(h * IN))
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill
    if line:
        shp.line.color.rgb = line
    else:
        shp.line.fill.background()
    shp.adjustments[0] = 0.08
    return shp


def title(s, t, sub=None):
    text(s, 0.6, 0.4, 12, 0.8, t, size=32, bold=True)
    if sub:
        text(s, 0.6, 1.1, 12, 0.6, sub, size=16, color=MUTED)


def group(agent, variant):
    for g in SUMMARY["groups"]:
        if g["agent"] == agent and g["variant"] == variant:
            return g
    return None


def pct(x):
    return "n/a" if x is None else f"{round(x * 100)}%"


# 1. Title
s = slide()
text(s, 0.8, 2.0, 11, 1.2, "Rewind", size=60, bold=True)
text(s, 0.8, 3.1, 11, 1, "Record, replay and fork any AI agent run at the Bifrost gateway", size=26, color=MUTED)
text(s, 0.8, 4.6, 11, 1.2, [
    "Geek Room Global AI Hackathon 2026",
    "Problem statement 02 (agent benchmarking) · Tavily integration: 05 (pre-meeting briefing agent)",
    "github.com/YASASWIP012/rewind · yasaswip012.github.io/rewind",
], size=16, color=MUTED)

# 2. Problem
s = slide()
title(s, "Agent runs can't be compared fairly")
text(s, 0.6, 1.6, 6.2, 4.8, [
    "Run the same agent twice and it takes a different path: other searches, other tool calls, another answer.",
    "So when you change a prompt, swap a model, or ask how the agent copes with a bad search result, you can't tell your change apart from chance.",
    "Benchmarks rerun everything many times. That costs money, and every source of randomness stays mixed in.",
    "Framework tracers only see their own framework. None of them sees the web searches.",
], size=19)
box(s, 7.2, 1.7, 5.4, 4.3)
text(s, 7.5, 1.9, 4.9, 4, [
    "The gateway sees all of it.",
    "Every model call and every Tavily search an agent makes already passes through Bifrost, whatever language the agent is written in.",
], size=20, color=FG)

# 3. What it does
s = slide()
title(s, "What Rewind does", "A Go plugin for a stock Bifrost v2.5.1, loaded from config.json")
items = [
    ("Record", "Every chat completion and Tavily search, step by step. The agent only changes its base URL and sends one header."),
    ("Replay", "The gateway answers from the recording. No provider is called: free and identical every time."),
    ("Fork", "Replay steps 1..k-1, change step k, run the rest live. Poison a search result, plant a false claim, cause an outage, swap the model."),
    ("Compare", "Branches share their history exactly, so results are paired: exact McNemar test and paired bootstrap."),
    ("Catch drift", "A replayed request that doesn't match the recording returns a field-level diff. A recorded run becomes a $0 regression test."),
]
for i, (k, v) in enumerate(items):
    y = 1.8 + i * 0.95
    box(s, 0.6, y, 12.1, 0.8)
    text(s, 0.85, y + 0.17, 2.2, 0.5, k, size=20, bold=True, color=ACCENT)
    text(s, 3.0, y + 0.13, 9.5, 0.7, v, size=16)

# 4. Architecture
s = slide()
title(s, "How it works")
box(s, 0.6, 2.0, 3.2, 2.6)
text(s, 0.8, 2.15, 2.9, 2.4, ["Agents", "brief_py (Python)", "brief_ts (TypeScript)", "or yours: base URL + x-rewind-run"], size=16)
box(s, 4.5, 1.6, 4.2, 3.6, line=ACCENT)
text(s, 4.7, 1.75, 3.9, 3.4, ["Bifrost v2.5.1", "rewind.so", "HTTPTransportPreHook: replay, fork, mutate", "HTTPTransportPostHook: record", "fingerprint + divergence diff", "run API on :8099"], size=16)
box(s, 9.4, 1.6, 3.3, 1.6)
text(s, 9.6, 1.75, 3.0, 1.4, ["Gemini", "via provider keys,", "retries + backoff"], size=16)
box(s, 9.4, 3.6, 3.3, 1.6)
text(s, 9.6, 3.75, 3.0, 1.4, ["Tavily", "via a Bifrost Relay,", "key held by gateway"], size=16)
text(s, 0.6, 5.5, 12, 1.2, [
    "Bifrost features used: Go plugin transport hooks (short-circuit), Relays with routes, virtual keys with model allowlists and relay grants, provider retries.",
], size=15, color=MUTED)

# 5. Results
s = slide()
title(s, "Results on real runs", EXTRA["results_sub"])
rows = [("Variant", "brief_py success", "brief_py repeated false claim", "brief_ts success", "brief_ts repeated false claim")]
for v in ("base", "misinfo", "poison", "outage", "model_swap"):
    a, b = group("brief_py", v), group("brief_ts", v)
    if not a and not b:
        continue
    rows.append((EXTRA["variant_names"].get(v, v),
                 pct(a and a["success_rate"]), pct(a and a["injection_follow_rate"]),
                 pct(b and b["success_rate"]), pct(b and b["injection_follow_rate"])))
tbl = s.shapes.add_table(len(rows), 5, int(0.6 * IN), int(1.8 * IN), int(12.1 * IN), int(0.45 * IN * len(rows))).table
for r, row in enumerate(rows):
    for c, val in enumerate(row):
        cell = tbl.cell(r, c)
        cell.text = val
        cell.fill.solid()
        cell.fill.fore_color.rgb = PANEL if r else RGBColor(0x22, 0x28, 0x33)
        p = cell.text_frame.paragraphs[0]
        p.runs[0].font.size = Pt(15)
        p.runs[0].font.color.rgb = FG
        p.runs[0].font.bold = r == 0
text(s, 0.6, 1.9 + 0.45 * len(rows) + 0.3, 12, 2, EXTRA["results_notes"], size=16, color=FG)

# 6. Replay and forks
s = slide()
title(s, "Replay and forks cost almost nothing")
rp = SUMMARY["replay_savings"]
stats = [
    (f"{rp['runs']}", "recorded runs replayed"),
    (f"{rp['divergent_runs']}", "replays that diverged"),
    (f"${rp['original_cost_usd']:.4f} → ${rp['replay_cost_usd']:.0f}", "cost, original vs replay"),
    (f"{rp['speedup']:.1f}x", "faster than the live run"),
]
for i, (big, small) in enumerate(stats):
    x = 0.6 + i * 3.05
    box(s, x, 1.8, 2.85, 2.0)
    text(s, x + 0.2, 2.0, 2.5, 0.9, big, size=30, bold=True, color=GREEN)
    text(s, x + 0.2, 2.95, 2.5, 0.8, small, size=15, color=MUTED)
text(s, 0.6, 4.2, 12, 2.2, EXTRA["fork_notes"], size=17)

# 7. Engineering
s = slide()
title(s, "Built to be merged")
text(s, 0.6, 1.6, 12, 4.8, EXTRA["engineering"], size=18)

# 8. Limits and next
s = slide()
title(s, "Limits and next steps")
text(s, 0.6, 1.6, 6, 4.8, ["Limits"] + EXTRA["limits"], size=17)
text(s, 6.8, 1.6, 6, 4.8, ["Next"] + EXTRA["next"], size=17)

# 9. Demo
s = slide()
title(s, "Try it")
text(s, 0.6, 1.8, 12, 4, [
    "Demo (no login, no keys): yasaswip012.github.io/rewind",
    "Code: github.com/YASASWIP012/rewind",
    "Run locally: make run, then bench/rewind_bench.py record | replay | fork | report | test",
    EXTRA.get("upstream", ""),
], size=20)

out = ROOT / "docs/Rewind.pptx"
prs.save(out)
print("wrote", out)
