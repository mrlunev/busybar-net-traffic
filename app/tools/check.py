"""Compares render.py's frame with Figma's own render of node 85:40269 (tools/figma-85-40269.png)."""
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import render as r  # noqa: E402

t = ((r.DESIGN_ANGLE - r.ARC_FROM) % (2 * math.pi)) / r.SWEEP
texts = [r.place("97", 22, 8), r.place("Mb", 33, 8), r.place("15", 50, 8), r.place("Mb", 59, 8)]
ours = np.asarray(r.compose(t, texts=texts), dtype=int)
fig = np.asarray(Image.open(Path(__file__).parent / "figma-85-40269.png").convert("RGB"), dtype=int)
d = np.abs(ours - fig).max(axis=2)
print(f"needle t={t:.3f}; max {d.max()}, mean {d.mean():.2f}, pixels >16: {(d > 16).sum()}, >40: {(d > 40).sum()}")
for y in range(16):
    print("".join("#" if v > 40 else "+" if v > 16 else "." for v in d[y]))
out = sys.argv[1] if len(sys.argv) > 1 else None
if out:
    big = lambda a: Image.fromarray(a.astype(np.uint8)).resize((72 * 12, 16 * 12), Image.NEAREST)
    canvas = Image.new("RGB", (72 * 12, 16 * 12 * 2 + 12))
    canvas.paste(big(fig), (0, 0)); canvas.paste(big(ours), (0, 16 * 12 + 12))
    canvas.save(out)
