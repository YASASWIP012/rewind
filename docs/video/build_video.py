"""Builds docs/video/rewind_demo.mp4 from the narration and viewer screenshots.

Run: uv run --with pillow python docs/video/build_video.py path/to/narration.mp3
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
W, H = 1920, 1080
BG, FG, MUTED, ACCENT, RED = (14, 17, 22), (232, 234, 237), (154, 163, 174), (91, 156, 255), (255, 107, 107)


def font(size, bold=False):
    for name in (["/System/Library/Fonts/SFNS.ttf", "/System/Library/Fonts/Helvetica.ttc"]):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def card(path, title, lines, title_color=FG):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    d.text((140, 260), title, font=font(92), fill=title_color)
    y = 430
    for line in lines:
        d.text((140, y), line, font=font(44), fill=MUTED)
        y += 74
    im.save(path)


def shot(src, dst, caption):
    im = Image.new("RGB", (W, H), BG)
    s = Image.open(src).convert("RGB")
    s.thumbnail((W - 120, H - 190))
    im.paste(s, ((W - s.width) // 2, 40))
    d = ImageDraw.Draw(im)
    d.text((80, H - 120), caption, font=font(46), fill=FG)
    im.save(dst)


frames = HERE / "frames"
frames.mkdir(exist_ok=True)
card(frames / "01.png", "Same agent, two runs, two answers.",
     ["Different searches, different calls, a different brief.",
      "Change something and you can't tell your change from luck."])
card(frames / "02.png", "Rewind",
     ["A Bifrost plugin that records every model call and Tavily search,",
      "replays the run for free, and forks it at any step.",
      "",
      "agent  →  Bifrost + rewind.so  →  Gemini · Tavily (Relay)"], title_color=ACCENT)
shot(HERE / "02_overview.jpg", frames / "03.png", "88 real runs · replay: 0 misses, $0.11 → $0, 5.5x faster")
shot(HERE / "03_tree.jpg", frames / "04.png", "Forks branch off the recorded run at the changed step")
shot(HERE / "05_brief.jpg", frames / "05.png", "Planted claim in one search result → it becomes the headline")
card(frames / "06.png", "Same model. Different agent design.",
     ["False claim repeated:  brief_py 12/12  ·  brief_ts 3/12   (McNemar p = 0.004)",
      "Hidden instruction:     brief_py 7/12   ·  brief_ts 0/12   (p = 0.016)",
      "Provider outage:        both recovered 12/12"])
card(frames / "07.png", "Built to be merged",
     ["Stock Bifrost v2.5.1 · public plugin hooks only",
      "36 Go tests + 22 Python tests · CI green",
      "Recorded runs double as $0 regression tests",
      "Upstream: maximhq/bifrost pull request #10048"])
card(frames / "08.png", "Rewind", ["Record, replay and fork any agent run at the gateway.", "",
                                   "yasaswip012.github.io/rewind", "github.com/YASASWIP012/rewind"], title_color=ACCENT)

# Seconds per frame, matched to the narration (about 126 s).
timing = [("01", 13), ("02", 15), ("03", 20), ("04", 15), ("05", 16), ("06", 26), ("07", 16), ("08", 10)]
audio = Path(sys.argv[1]).resolve()
dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                     "-of", "default=nw=1:nk=1", str(audio)]).decode().strip())
scale = dur / sum(t for _, t in timing)
lst = HERE / "frames.txt"
with lst.open("w") as f:
    for name, t in timing:
        f.write(f"file 'frames/{name}.png'\nduration {t * scale:.3f}\n")
    f.write(f"file 'frames/{timing[-1][0]}.png'\n")
out = HERE / "rewind_demo.mp4"
subprocess.run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-i", str(audio),
                "-c:v", "libx264", "-r", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
                "-shortest", str(out)], check=True, cwd=HERE)
print("wrote", out, f"({dur:.1f}s)")
