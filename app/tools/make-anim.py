"""
Bakes Net Traffic's screen (Figma "Apps for BUSY Bar Catalog", node 85:40269, drawn by render.py) into the app,
in layers from the back:

- src/images/base.png: the panel alone and grey (under everything, for the moment before the first frame);
- src/animations/stars.anim, the whole frame: the panel with stars streaking from right to left through it, faster
  and brighter with the speed, on the DOWN half only, the panel lit a little brighter with them: sections s_0 (none) to s_4 (warp),
  each a seamless 1 s loop; off, the panel grey (the cable is out), and fade_on, fade_off between the two;
- src/animations/gauge.anim, columns 0..21, transparent around the gauge, the needle at 21 positions, k = 0..20 for
  0..180 Mbit/s, and its sections, all played in a loop by the app (a section that ends stops the firmware's player
  for good, so none may end):
  - off: at rest, dim and grey (the cable is out);
  - wake: takes its colour back and lights up while the needle sweeps to the end of the arc and back, as a car's dial does at ignition;
  - h_<k>: the needle at k, trembling: a little low on the dial, more near the top, and at k = 20 knocking on the end;
  - m_<j>_<k>: the needle from j to k, eased, then still at k for DWELL frames, while the app queues h_<k>;
  - drop_<k>: from k down to rest, going dim and grey (the cable is pulled), then still;
- src/images/labels.png, labels_off.png: DOWN and UP, with their black copies 1 px below, in colour and grey;
- src/images/msg_<state>.png: the state messages in place of the labels and readings (MESSAGES), none.png: nothing;
- src/images/v_off.png: 0 Mb in grey, both readings with the cable out;
- src/images/v_<n>_Mb.png, v_<a>_<b>_Gb.png: each reading the app shows (see readings()).

  python tools/make-anim.py [--no-gauge]

Needs Pillow, numpy and a clone of busybar-firmware (its scripts/seq2anim.py packs the frames): BUSYBAR_FIRMWARE=<path>,
or next to this repository.
"""

import json
import math
import os
import random
import sys
import tempfile
import types
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
# The firmware's .anim encoder, scripts/seq2anim.py of https://github.com/busy-app/busybar-firmware: a clone named by
# BUSYBAR_FIRMWARE, or one next to this repository.
FIRMWARE = Path(os.environ.get("BUSYBAR_FIRMWARE", ROOT.parent / "busybar-firmware"))
sys.path.insert(0, str(FIRMWARE / "scripts"))
try:
    import colorlog  # noqa: F401  # the firmware's command-line wrapper wants it; the encoder does not
except ImportError:
    sys.modules["colorlog"] = types.SimpleNamespace(ColoredFormatter=object, StreamHandler=object)
from seq2anim import BSBAnimConverter  # noqa: E402

import render as r  # noqa: E402

FPS = 25
K = 21  # needle positions along the arc
GAUGE_W = 23  # the gauge's columns, 0..22
DIM_GLOW, DIM_NEEDLE = 0.25, 0.45
GREY_LIGHT = 0.8  # how bright the grey panel and labels are against their colours (the cable is out)
GREY_TEXT = (0x80, 0x80, 0x80)  # the readings with the cable out
FADE_ON, FADE_OFF = 10, 8  # frames of the panel going from grey to colour and back
DWELL = 4  # still frames after a move: time for the app's queued hold to arrive
READINGS = 200
# The states the app shows in place of the labels and readings (src/main.ts `Message`): a title, and what to do in grey.
# Two spaces between words: one space is 2 px in this font, too little to part words in a sentence.
AMBER = (0xF5, 0xA6, 0x23)
MESSAGES = {
    "setup": ("SET  UP", "ON  YOUR  PC", AMBER),  # nothing set up: run the install command on the computer
    "nopc": ("NO  PC", "ASLEEP?", (0xFF, 0xFF, 0xFF)),  # the computer does not answer
    "nonet": ("NO  NET", "ON  YOUR  PC", (0xFF, 0xFF, 0xFF)),  # the computer answers, and has no internet
    "update": ("UPDATE", "ON  YOUR  PC", AMBER),  # the computer's part is of another version
}
MSG_X = 21

# Stars by level: how many at once, how fast (px a frame), tail length (px), how bright.
STARS = {1: (4, 1.0, 3, 0.17), 2: (7, 1.8, 5, 0.26), 3: (10, 2.8, 8, 0.36), 4: (14, 4.2, 11, 0.46)}
# The stars fly from right to left across the DOWN half: they come out of nothing at STAR_TO, before UP,
# and grow brighter towards the gauge (falloff(x)), along rows STAR_ROWS.
STAR_FROM, STAR_TO = 2, 46
STAR_ROWS = range(1, 15)
STAR_COLOUR = np.array(r.GREEN, dtype=float)  # the arc's green
# The glow around each streak: its share of the streak's light 1 and 2 px above and below, and ahead of its head.
GLOW_SIDE = (0.3, 0.1)
GLOW_HEAD = 0.25
# The panel lights up with the speed: its brightness gain by level, and a touch of the arc's green with it.
PANEL_GAIN = {0: 0.0, 1: 0.08, 2: 0.16, 3: 0.26, 4: 0.38}
PANEL_TINT = 0.12
LOOP = 25  # frames in a stars loop


def ease(u: float) -> float:
    return 4 * u**3 if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2


def ease_out(u: float) -> float:
    return 1 - (1 - u) ** 3


def pos(k: int) -> float:
    return k / (K - 1)


def move_frames(j: int, k: int) -> int:
    """Frames of the move itself, before the dwell; main.ts counts the same."""
    return 4 + round(abs(k - j) * 0.35)


def bake(frames: list[Image.Image], sections: list[dict], mode: str, out: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        for i, f in enumerate(frames):
            f.save(d / f"{i:05d}.png")
        (d / "meta.json").write_text(json.dumps({"fps": FPS, "color_mode": mode, "sections": sections}))
        BSBAnimConverter().convert_dir(d, out)
    print(f"{out.name}: {len(frames)} frames, {len(sections)} sections, {out.stat().st_size // 1024} KiB")


class Builder:
    def __init__(self):
        self.frames: list[Image.Image] = []
        self.sections: list[dict] = []

    def section(self, name: str, imgs: list[Image.Image]) -> None:
        start = len(self.frames)
        self.frames.extend(imgs)
        self.sections.append({"name": name, "start": start, "end": len(self.frames) - 1})


# ---- the gauge ----------------------------------------------------------------------------------------------------

_cache: dict = {}


def gauge(t: float, glow: float = 1.0, needle: float = 1.0, grey: float = 0.0) -> Image.Image:
    key = (round(t, 5), round(glow, 4), round(needle, 4), round(grey, 4))
    if key not in _cache:
        _cache[key] = r.gauge_rgba(min(1.0, max(0.0, t)), glow, needle, GAUGE_W, grey)
    return _cache[key]


def hold(k: int) -> list[Image.Image]:
    if k == 0:
        return [gauge(0)]
    if k == K - 1:  # against the end of the arc: knocks on it and rebounds
        return [gauge(1 - d) for d in (0, 0.012, 0, 0.007, 0, 0, 0.015, 0.004)]
    if k >= 15:  # near the top the needle shivers
        return [gauge(pos(k) + 0.013 * v) for v in (0, 0.6, 1, 0.3, -0.4, -1, -0.5, 0.2)]
    return [gauge(pos(k) + 0.005 * math.sin(2 * math.pi * i / 8)) for i in range(8)]


def bake_gauge(out: Path) -> None:
    b = Builder()
    b.section("off", [gauge(0, DIM_GLOW, DIM_NEEDLE, 1)])
    up, top, down = 8, 2, 8  # a quick blip to the end and back: 0.72 s; main.ts counts the same
    wake = []
    for i in range(up):
        u = (i + 1) / up
        g = DIM_GLOW + (1 - DIM_GLOW) * ease_out(min(1, u * 1.2))
        wake.append(gauge(ease_out(u), g, DIM_NEEDLE + (1 - DIM_NEEDLE) * u, max(0.0, 1 - u * 1.4)))
    wake += [gauge(1)] * top
    wake += [gauge(1 - ease((i + 1) / down)) for i in range(down)]
    wake += [gauge(0)] * DWELL
    b.section("wake", wake)
    for k in range(K):
        b.section(f"h_{k}", hold(k))
    for j in range(K):
        for k in range(K):
            if j != k:
                n = move_frames(j, k)
                b.section(f"m_{j}_{k}", [gauge(pos(j) + (pos(k) - pos(j)) * ease((i + 1) / n)) for i in range(n)]
                          + [gauge(pos(k))] * DWELL)
    for k in range(K):
        n = 6 + round(k * 0.3)
        b.section(f"drop_{k}", [gauge(pos(k) * (1 - ease((i + 1) / n)),
                                      1 - (1 - DIM_GLOW) * ((i + 1) / n),
                                      1 - (1 - DIM_NEEDLE) * ((i + 1) / n), (i + 1) / n) for i in range(n)]
                  + [gauge(0, DIM_GLOW, DIM_NEEDLE, 1)] * DWELL)
    bake(b.frames, b.sections, "argb8888", out)


# ---- the stars ----------------------------------------------------------------------------------------------------

def panel(level: int) -> np.ndarray:
    """The panel, lit for a level: brighter and a little greener inside its edge as the speed grows."""
    g = PANEL_GAIN[level]
    lit = r.PANEL * (1 + g) + STAR_COLOUR * g * PANEL_TINT
    inside = r.INSIDE[..., None]
    return np.clip(r.PANEL * (1 - inside) + lit * inside, 0, 255)


def falloff(x: int) -> float:
    """How likely and how bright a star is in column x: 1 by the gauge, down to nothing at STAR_TO."""
    if not STAR_FROM <= x <= STAR_TO:
        return 0.0
    return (1 - (x - STAR_FROM) / (STAR_TO - STAR_FROM + 1)) ** 1.3


FADE = np.array([falloff(x) for x in range(r.W)])[None, :]


def stars_loop(level: int, seed: int) -> list[Image.Image]:
    """LOOP frames of stars streaking from right to left, seamless: each makes a whole number of passes in the loop."""
    count, speed, tail, light = STARS[level]
    rnd = random.Random(seed)
    rows = rnd.sample(list(STAR_ROWS), min(count, len(STAR_ROWS)))
    streaks = []
    for y in rows:
        span = (STAR_TO - STAR_FROM + 1) + tail
        passes = max(1, round(speed * rnd.uniform(0.8, 1.25) * LOOP / span))
        streaks.append((y, passes * span / LOOP, span, rnd.uniform(0, span), rnd.uniform(0.55, 1.0)))
    xs = np.arange(r.W) + 0.5
    lit = panel(level)
    frames = []
    for f in range(LOOP):
        a = np.zeros((r.H, r.W))
        for y, v, span, phase, depth in streaks:
            # The head's x, moving left from just past STAR_TO; the tail trails to its right.
            head = STAR_TO + 1 + tail - (phase + v * f) % span
            d = xs - head
            # Bright at the head, fading along the tail; the head's own pixel by how far into it the head is.
            inten = np.where((d >= 0) & (d <= tail), np.clip(1 - d / tail, 0, 1) ** 1.6, 0)
            inten = np.where((d < 0) & (d > -1), 1 + d, inten)
            core = inten * light * depth
            # The glow: a little light just ahead of the head (to its left), a soft halo above and below.
            halo = np.zeros(r.W)
            halo[:-1] = core[1:] * GLOW_HEAD
            a[y, :] = np.maximum(a[y, :], np.maximum(core, halo))
            for dy, share in enumerate(GLOW_SIDE, start=1):
                for side in (y - dy, y + dy):
                    if 0 <= side < r.H:
                        a[side, :] = np.maximum(a[side, :], core * share)
        a = np.clip(a * FADE * r.INSIDE, 0, 1)[..., None]
        img = lit * (1 - a) + STAR_COLOUR * a
        frames.append(Image.fromarray(np.clip(np.rint(img), 0, 255).astype(np.uint8), "RGB"))
    return frames


def to_image(rgb: np.ndarray) -> Image.Image:
    return Image.fromarray(np.clip(np.rint(rgb), 0, 255).astype(np.uint8), "RGB")


def bake_stars(out: Path) -> None:
    b = Builder()
    b.section("s_0", [r.panel_rgb()])
    b.section("off", [to_image(r.greyed(r.PANEL, 1, GREY_LIGHT))])
    b.section("fade_on", [to_image(r.greyed(r.PANEL, 1 - ease((i + 1) / FADE_ON), GREY_LIGHT)) for i in range(FADE_ON)])
    b.section("fade_off", [to_image(r.greyed(r.PANEL, ease((i + 1) / FADE_OFF), GREY_LIGHT)) for i in range(FADE_OFF)])
    for level in STARS:
        b.section(f"s_{level}", stars_loop(level, seed=level * 7))
    bake(b.frames, b.sections, "rgb888", out)


# ---- the rest -----------------------------------------------------------------------------------------------------

def bake_images(images: Path) -> None:
    for old in images.glob("v_*.png"):
        old.unlink()
    to_image(r.greyed(r.PANEL, 1, GREY_LIGHT)).save(images / "base.png")
    r.text_rgba(r.LABELS).save(images / "labels.png", optimize=True)
    grey = [(x, y, tuple(int(v) for v in r.greyed(np.array(c, dtype=float), 1, GREY_LIGHT))) for x, y, c in r.LABELS]
    r.text_rgba(grey).save(images / "labels_off.png", optimize=True)
    zero = r.place("0 Mb", 0, 0, GREY_TEXT)
    r.text_rgba(zero, (max(x for x, _, _ in zero) + 1, 7)).save(images / "v_off.png", optimize=True)
    for name, (title, hint, colour) in MESSAGES.items():
        px = r.place(title, MSG_X, 1, colour) + r.place(hint, MSG_X, 8, GREY_TEXT)
        r.text_rgba(px).save(images / f"msg_{name}.png", optimize=True)
    Image.new("RGBA", (1, 1), (0, 0, 0, 0)).save(images / "none.png")
    names = readings()
    for name, text in names:
        px = r.place(text, 0, 0)
        w = max(x for x, _, _ in px) + 1
        r.text_rgba(px, (w, 7)).save(images / f"{name}.png", optimize=True)
    print(f"images: base, labels, {len(names)} readings")


def readings() -> list[tuple[str, str]]:
    """The readings the app can show (src/main.ts `reading`): Mbit/s exact to 299, by tens to 990, then Gbit/s by tenths."""
    out = [(f"v_{n}_Mb", f"{n} Mb") for n in range(300)]
    out += [(f"v_{n}_Mb", f"{n} Mb") for n in range(300, 1000, 10)]
    out += [(f"v_{t // 10}_{t % 10}_Gb", f"{t // 10}.{t % 10} Gb") for t in range(1, 100)]
    return out


def main() -> None:
    images = ROOT / "src" / "images"
    animations = ROOT / "src" / "animations"
    images.mkdir(parents=True, exist_ok=True)
    animations.mkdir(parents=True, exist_ok=True)
    bake_images(images)
    bake_stars(animations / "stars.anim")
    if "--no-gauge" not in sys.argv:
        bake_gauge(animations / "gauge.anim")


if __name__ == "__main__":
    main()
