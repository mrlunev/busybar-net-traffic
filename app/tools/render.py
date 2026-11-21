"""
The "Internet Speed" screen (Figma file "Apps for BUSY Bar Catalog", node 85:40269), drawn from its own geometry:
the panel with its gradient and border, the labels, the gauge (the arc, its shadow, the needle) at any needle
position and brightness, and the digits of the speeds. make-anim.py bakes it; check.py compares it with Figma's
own render of the frame (tools/figma-85-40269.png).

Coordinates are the frame's: 72x16, y down. The gauge's SVG (27x19) sits at (-3, 1.853), as Figma exports it; the
app moves the DOWN block 1 px left (SHIFT), so that "180 Mb" fits; the gauge stays at Figma's place. RENDER_FIGMA=1 draws Figma's places.

For the app the frame comes apart in layers: the panel (opaque), the gauge (transparent around the arc and needle), the
labels and the readings (transparent), so that the stars can fly behind all of them.
"""

import math
import os

import numpy as np
from PIL import Image

W, H = 72, 16
SS = 16  # supersampling

# Gauge, in frame coordinates (the SVG's plus its offset).
SHIFT = 0 if os.environ.get("RENDER_FIGMA") else 1
OX, OY = -3.0, 1.85302734375
ARC_C = (14.0 + OX, 8.69231 + OY)
ARC_R0, ARC_R1 = 5.5, 8.5
# The arc's two ends are cut square across the ring: the angle of each cut's middle, y down.
ARC_FROM = math.atan2(12.5 - 8.69231, 8.0603 - 14.0)  # lower left, 147.3 degrees
ARC_TO = math.atan2(12.5 - 8.69231, 20.1765 - 14.0)  # lower right, 31.7 degrees
SWEEP = 2 * math.pi - (ARC_FROM - ARC_TO)

GREEN = (0x7A, 0xFF, 0x78)
TEXT_GREEN = (0x7A, 0xFF, 0x77)
TEXT_BLUE = (0x5A, 0x91, 0xFA)
WHITE = (255, 255, 255)


def _circle(p1, p2, p3):
    (ax, ay), (bx, by), (cx, cy) = p1, p2, p3
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    ux = ((ax**2 + ay**2) * (by - cy) + (bx**2 + by**2) * (cy - ay) + (cx**2 + cy**2) * (ay - by)) / d
    uy = ((ax**2 + ay**2) * (cx - bx) + (bx**2 + by**2) * (ax - cx) + (cx**2 + cy**2) * (bx - ax)) / d
    return ux, uy


# The needle: a thin wedge from its hub to the tip, as the SVG path has it, turned about the hub's centre.
_HUB = _circle((15.1292, 10.0655), (13.1717, 10.883), (12.3543, 8.92544))
NEEDLE_PIVOT = (_HUB[0] + OX, _HUB[1] + OY)
NEEDLE_PATH = [  # the path's corners, the hub's arc in short straight steps
    (13.2364, 8.08317), (16.7408, 1.53824), (14.9919, 8.6662),
]
NEEDLE_GRAD = ((14.3704, 6.12267), (11.5, 15.647))  # white to transparent
DESIGN_ANGLE = math.atan2(1.53824 - _HUB[1], 16.7408 - _HUB[0])


def _grid():
    ys, xs = np.mgrid[0:H * SS, 0:W * SS]
    return (xs + 0.5) / SS, (ys + 0.5) / SS


X, Y = _grid()


def _down(a: np.ndarray) -> np.ndarray:
    """Supersampled to frame pixels, by the mean."""
    return a.reshape(H, SS, W, SS, *a.shape[2:]).mean(axis=(1, 3))


def _over(dst: np.ndarray, rgb, alpha: np.ndarray) -> np.ndarray:
    a = alpha[..., None]
    return dst * (1 - a) + np.asarray(rgb, dtype=float) * a


def _rounded_rect(x0, y0, x1, y1, r) -> np.ndarray:
    cx = np.clip(X, x0 + r, x1 - r)
    cy = np.clip(Y, y0 + r, y1 - r)
    return ((X - cx) ** 2 + (Y - cy) ** 2 <= r * r) & (X >= x0) & (X <= x1) & (Y >= y0) & (Y <= y1)


def _blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur of a frame-resolution map, sigma in frame pixels."""
    radius = int(math.ceil(sigma * 3))
    k = np.exp(-0.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.pad(a, radius)
    a = np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 0, pad)
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 1, a)


def _rect_coverage(x0, y0, x1, y1) -> np.ndarray:
    """A sharp rectangle at frame resolution, by area, padded for blurring."""
    m = ((X >= x0) & (X <= x1) & (Y >= y0) & (Y <= y1)).astype(float)
    return _down(m)


def _polygon(points) -> np.ndarray:
    """Inside test for a convex or simple polygon, even-odd, on the supersampled grid."""
    inside = np.zeros(X.shape, dtype=bool)
    n = len(points)
    for i in range(n):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % n]
        cond = (y1 > Y) != (y2 > Y)
        xint = (x2 - x1) * (Y - y1) / ((y2 - y1) if y2 != y1 else 1e-9) + x1
        inside ^= cond & (X < xint)
    return inside


def _linear(p0, p1) -> np.ndarray:
    """Position along the gradient line from p0 (0) to p1 (1), clamped."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    s = ((X - p0[0]) * dx + (Y - p0[1]) * dy) / (dx * dx + dy * dy)
    return np.clip(s, 0, 1)


# ---- the panel: rounded rectangle, CSS linear-gradient(156.64deg), 1 px border of white at 32 % -------------------

def _panel() -> np.ndarray:
    x0, y0, x1, y1 = 1, 0, 71, 16
    a = math.radians(156.64159176330557)
    d = (math.sin(a), -math.cos(a))
    length = abs((x1 - x0) * d[0]) + abs((y1 - y0) * d[1])
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    p = ((X - cx) * d[0] + (Y - cy) * d[1]) / length + 0.5
    s = np.clip((p - 0.13006) / (0.68756 - 0.13006), 0, 1)[..., None]
    fill = np.array((45, 68, 30)) * (1 - s) + np.array((3, 15, 37)) * s
    outer = _rounded_rect(x0, y0, x1, y1, 3)
    inner = _rounded_rect(x0 + 1, y0 + 1, x1 - 1, y1 - 1, 2)
    img = np.zeros((H * SS, W * SS, 3))
    img = np.where(outer[..., None], fill, img)
    # The border is lit from above: measured on Figma's render, row by row (the export's flat 32 % is not what it
    # draws), down to nothing at the bottom.
    light = np.repeat(np.array(BORDER_LIGHT) * BORDER_GAIN, SS)[:, None]
    img = _over(img, WHITE, (outer & ~inner) * light)
    return _down(img)


# The app lights the border a little more than Figma (RENDER_FIGMA=1 keeps Figma's).
BORDER_GAIN = 1.0 if os.environ.get("RENDER_FIGMA") else 1.4
BORDER_LIGHT = [0.15, 0.13, 0.11, 0.108, 0.103, 0.093, 0.082, 0.076, 0.064, 0.057, 0.047, 0.041, 0.03, 0.015, 0.0, 0.0]


PANEL = _panel()

# ---- the shadows under the gauge: Figma's Rectangle 41844 and the SVG's own, both black, blurred ------------------

_SHADOW_PAD = 8


def _shadow(x0, y0, x1, y1, sigma) -> np.ndarray:
    m = np.zeros((H + 2 * _SHADOW_PAD, W + 2 * _SHADOW_PAD))
    cov = _rect_coverage(x0, y0, x1, y1)
    m[_SHADOW_PAD:-_SHADOW_PAD, _SHADOW_PAD:-_SHADOW_PAD] = cov
    # Parts of the rectangles below the frame: y up to 17 for the first, 16.85 for the SVG's.
    for y in range(H, int(math.ceil(y1))):
        m[_SHADOW_PAD + y, _SHADOW_PAD + max(0, int(x0)):_SHADOW_PAD + int(math.ceil(x1))] = min(1.0, y1 - y)
    return _blur(m, sigma)[_SHADOW_PAD:-_SHADOW_PAD, _SHADOW_PAD:-_SHADOW_PAD]


SHADOW_BELOW = _shadow(4 + OX, 12, 23 + OX, 17, 1.0)  # under the labels' layer (Figma blur 2 px: sigma 1)
SHADOW_GAUGE = _shadow(4 + OX, 10 + OY, 23 + OX, 15 + OY, 2.0)  # stdDeviation 2

# ---- the arc: the ring between the two cuts, green fading to transparent white downwards --------------------------


def _arc_mask() -> np.ndarray:
    dx, dy = X - ARC_C[0], Y - ARC_C[1]
    r = np.hypot(dx, dy)
    ang = np.arctan2(dy, dx)
    rel = np.mod(ang - ARC_FROM, 2 * math.pi)
    return (r >= ARC_R0) & (r <= ARC_R1) & (rel <= SWEEP)


ARC = _arc_mask()
_s = _linear((17 + OX, 3 + OY), (15 + OX, 14 + OY))
ARC_RGB = np.array(GREEN) * (1 - _s[..., None]) + np.array(WHITE) * _s[..., None]
ARC_A = (1 - _s) * ARC


def _needle(t: float):
    """The needle's colour and alpha (supersampled) at position t, 0 the left end of the arc, 1 the right."""
    turn = ARC_FROM + SWEEP * t - DESIGN_ANGLE
    c, s = math.cos(turn), math.sin(turn)
    px, py = _HUB

    def rot(p):
        x, y = p[0] - px, p[1] - py
        return (px + x * c - y * s + OX, py + x * s + y * c + OY)

    hub_r = math.hypot(15.1292 - px, 10.0655 - py)
    tip = [rot(p) for p in NEEDLE_PATH]
    wedge = _polygon(tip)
    hub = (X - NEEDLE_PIVOT[0]) ** 2 + (Y - NEEDLE_PIVOT[1]) ** 2 <= hub_r * hub_r
    g0, g1 = rot(NEEDLE_GRAD[0]), rot(NEEDLE_GRAD[1])
    alpha = (1 - _linear(g0, g1)) * (wedge | hub)
    return alpha


# ---- text: the labels as Figma draws them, pixel art in exact colours, each with a black copy 1 px below ------------

def _bits(rows, x, y, colour, out):
    for dy, row in enumerate(rows):
        for dx, ch in enumerate(row):
            if ch == "#":
                out.append((x + dx, y + dy, colour))


LABELS = []
_bits([
    "..#...###..###.#...#.#..#",
    "#.#.#.#..#.#.#.#.#.#.##.#",
    ".###..#..#.#.#.#.#.#.#.##",
    "..#...####.###.#####.#..#",
], 22 - SHIFT, 2, TEXT_GREEN, LABELS)
# UP sits 1 px left of Figma's place; the app puts the UP reading at the same x.
UP_X = 50 if os.environ.get("RENDER_FIGMA") else 49
_bits([
    "..#...#.#.###",
    ".###..#.#.#.#",
    "#.#.#.#.#.###",
    "..#...###.#..",
], UP_X, 2, TEXT_BLUE, LABELS)

DIGITS = {
    "0": [".##.", "#..#", "#..#", "#..#", "#..#", ".##."],
    "1": ["##", ".#", ".#", ".#", ".#", ".#"],
    "2": [".##.", "#..#", "...#", "..#.", ".#..", "####"],
    "3": ["###.", "...#", ".##.", "...#", "...#", "###."],
    "4": ["#..#", "#..#", "#..#", "####", "...#", "...#"],
    "5": ["####", "#...", "###.", "...#", "...#", "###."],
    "6": [".##.", "#...", "###.", "#..#", "#..#", ".##."],
    "7": ["####", "...#", "...#", "..#.", ".#..", ".#.."],
    "8": [".##.", "#..#", ".##.", "#..#", "#..#", ".##."],
    "9": [".##.", "#..#", "#..#", ".###", "...#", ".##."],
    ".": [".", ".", ".", ".", ".", "#"],
    "M": ["#...#", "##.##", "#.#.#", "#...#", "#...#"],  # 5 rows, from row 1
    "b": ["#...", "###.", "#..#", "#..#", "###."],
    "G": [".##.", "#...", "#.##", "#..#", ".##."],
    # Capitals for the state messages, drawn to match M and G: 5 rows from row 1, 4 px wide (T, Y, I 3).
    "A": [".##.", "#..#", "####", "#..#", "#..#"],
    "C": [".###", "#...", "#...", "#...", ".###"],
    "D": ["###.", "#..#", "#..#", "#..#", "###."],
    "E": ["####", "#...", "###.", "#...", "####"],
    "I": ["###", ".#.", ".#.", ".#.", "###"],
    "L": ["#...", "#...", "#...", "#...", "####"],
    "N": ["#..#", "##.#", "#.##", "#..#", "#..#"],
    "O": [".##.", "#..#", "#..#", "#..#", ".##."],
    "P": ["###.", "#..#", "###.", "#...", "#..."],
    "R": ["###.", "#..#", "###.", "#.#.", "#..#"],
    "S": [".###", "#...", ".##.", "...#", "###."],
    "T": ["###", ".#.", ".#.", ".#.", ".#."],
    "U": ["#..#", "#..#", "#..#", "#..#", ".##."],
    "Y": ["#.#", "#.#", ".#.", ".#.", ".#."],
    "?": ["##.", "..#", ".#.", "...", ".#."],
}
GLYPH_TOP = {"M": 1, "b": 1, "G": 1, **{c: 1 for c in "ACDEILNOPRSTUY?"}}


def glyph_width(ch: str) -> int:
    return len(DIGITS[ch][0])


def place(s: str, x: int, y: int, colour=WHITE):
    """Pixels of a string; glyphs 1 px apart, a space 2 px."""
    out = []
    for ch in s:
        if ch == " ":
            x += 1
            continue
        _bits(DIGITS[ch], x, y + GLYPH_TOP.get(ch, 0), colour, out)
        x += glyph_width(ch) + 1
    return out


def width(s: str) -> int:
    px = place(s, 0, 0)
    return max(x for x, _, _ in px) + 1 if px else 0


TEXT_SHADOW = 0.5


# ---- the whole frame ----------------------------------------------------------------------------------------------

def compose(t: float, glow: float = 1.0, needle: float = 1.0, texts=(), labels=True) -> Image.Image:
    """The frame with the needle at t; glow scales the arc, needle the needle's light; texts are lists of pixels."""
    img = PANEL.copy()
    text_px = (LABELS if labels else []) + [p for pixels in texts for p in pixels]
    for x, y, _ in text_px:  # the black copy, 1 px below, at half strength (as Figma draws it)
        if 0 <= y + 1 < H:
            img[y + 1, x] = PANEL[y + 1, x] * (1 - TEXT_SHADOW)
    img = img * (1 - SHADOW_BELOW[..., None])
    for x, y, colour in text_px:
        img[y, x] = colour
    big = np.repeat(np.repeat(img, SS, axis=0), SS, axis=1)
    big = _over(big, (0, 0, 0), np.zeros(X.shape))  # (float copy)
    arc_a = ARC_A * glow
    big = _over(big, (0, 0, 0), 0 * arc_a)
    big = big * (1 - arc_a[..., None]) + ARC_RGB * arc_a[..., None]
    out = _down(big)
    out = out * (1 - SHADOW_GAUGE[..., None])
    big = np.repeat(np.repeat(out, SS, axis=0), SS, axis=1)
    na = _needle(t) * needle
    big = _over(big, WHITE, na)
    out = _down(big)
    return Image.fromarray(np.clip(np.rint(out), 0, 255).astype(np.uint8), "RGB")


# ---- layers for the app ------------------------------------------------------------------------------------------

def _rgba(premult: np.ndarray, alpha: np.ndarray) -> Image.Image:
    a = np.clip(alpha, 0, 1)
    rgb = np.where(a[..., None] > 1e-6, premult / np.maximum(a[..., None], 1e-6), 0)
    out = np.dstack([np.clip(np.rint(rgb), 0, 255), np.clip(np.rint(a * 255), 0, 255)]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def gauge_rgba(t: float, glow: float = 1.0, needle: float = 1.0, width: int = 22, grey: float = 0.0) -> Image.Image:
    """The gauge alone over nothing: its shadows, the arc and the needle, as Figma stacks them; columns 0..width-1;
    grey drains its colour (1: all grey)."""
    up = lambda a: np.repeat(np.repeat(a, SS, axis=0), SS, axis=1)
    c = np.zeros(X.shape + (3,))
    a = np.zeros(X.shape)

    def over(rgb, alpha):
        nonlocal c, a
        c = np.asarray(rgb, dtype=float) * alpha[..., None] + c * (1 - alpha[..., None])
        a = alpha + a * (1 - alpha)

    over((0, 0, 0), up(SHADOW_BELOW))
    arc_a = ARC_A * glow
    c = ARC_RGB * arc_a[..., None] + c * (1 - arc_a[..., None])
    a = arc_a + a * (1 - arc_a)
    over((0, 0, 0), up(SHADOW_GAUGE))
    over(WHITE, _needle(t) * needle)
    c = _down(c)
    c = c * (1 - grey) + _luma(c)[..., None] * grey
    return _rgba(c, _down(a)).crop((0, 0, width, H))


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def greyed(rgb: np.ndarray, amount: float = 1.0, light: float = 1.0) -> np.ndarray:
    """rgb drained of its colour by amount, and dimmed to light."""
    return (rgb * (1 - amount) + _luma(rgb)[..., None] * amount) * (1 - amount + amount * light)


def text_rgba(pixels, size=(W, H)) -> Image.Image:
    """Pixel-art text over nothing, each pixel with its black copy 1 px below at half strength."""
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    for x, y, _ in pixels:
        if 0 <= y + 1 < size[1]:
            img.putpixel((x, y + 1), (0, 0, 0, round(255 * TEXT_SHADOW)))
    for x, y, colour in pixels:
        img.putpixel((x, y), (*colour, 255))
    return img


def panel_rgb() -> Image.Image:
    return Image.fromarray(np.clip(np.rint(PANEL), 0, 255).astype(np.uint8), "RGB")


# Where the stars may fly: inside the panel's border.
INSIDE = _down(_rounded_rect(2, 1, 70, 15, 2).astype(float))
