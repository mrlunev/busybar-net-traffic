"""
The APPS menu icons, drawn in Figma ("Apps for BUSY Bar Catalog"), written into the app's PNGs.

- src/appmeta/icon_front_8x8.png: colour, transparent where the LED stays off;
- src/appmeta/icon_back_11x11.png: the firmware takes only its alpha (LA).

  python tools/make-icons.py [--preview out.png]
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# The front icon, from Figma ("Apps for BUSY Bar Catalog", node 110:33): colour on black, RRGGBB.
FRONT = [
    "000000 000000 000000 000000 000000 000000 000000 000000",
    "000000 000000 2E602D 53AF52 5BBF59 5D9F5C 0F1F0F 000000",
    "000000 497F48 89FE88 468F46 5D9F5C 96EF94 6CDF6B 071007",
    "141D14 A1F2A1 3C5C3B 000000 A0A0A0 192019 7DDE7C 477F47",
    "283228 7CA07B 010101 424242 CBCBCB 000000 4E754E 6AA167",
    "0E100E 222722 020202 696969 8F8F8F 010101 1E261E 384938",
    "000000 020202 010101 010101 010101 010101 040504 080908",
    "000000 010101 010101 000000 000000 000000 000000 010101",
]
# Darker than this is the export's noise: the LED would stay off, so the pixel is left out.
BLACK = 0x0A

# The back icon, from Figma ("Apps for BUSY Bar Catalog", node 110:9): grey levels on black. The firmware takes only
# the alpha and recolours it, so each level becomes the alpha of a white pixel.
BACK = [
    "00 00 00 00 00 00 00 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00",
    "00 00 20 90 EF FF DF 9F 1F 00 00",
    "00 5F EF EF 8F 60 8F E0 EF 60 00",
    "20 EF A0 10 00 00 2F 77 FF EF 1F",
    "A0 DF 10 00 00 00 4D FF 59 EF 90",
    "E0 90 00 00 00 8E E3 B7 00 90 EF",
    "FF 5F 00 00 4C FF FF 66 00 60 FF",
    "CF 4F 00 00 FF FF FF 4D 00 60 BF",
    "00 00 00 00 4C FF 4C 00 00 00 00",
    "00 00 00 00 00 00 00 00 00 00 00",
]


def front() -> Image.Image:
    img = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    for y, row in enumerate(FRONT):
        for x, hexrgb in enumerate(row.split()):
            rgb = tuple(int(hexrgb[i:i + 2], 16) for i in (0, 2, 4))
            if max(rgb) >= BLACK:
                img.putpixel((x, y), rgb + (255,))
    return img


def back() -> Image.Image:
    img = Image.new("LA", (11, 11), (255, 0))
    for y, row in enumerate(BACK):
        for x, level in enumerate(row.split()):
            img.putpixel((x, y), (255, int(level, 16)))
    return img


def preview(f: Image.Image, b: Image.Image, path: Path) -> None:
    s = 24
    sheet = Image.new("RGB", (22 * s, 11 * s), (40, 40, 40))
    fb = Image.new("RGBA", f.size, (0, 0, 0, 255))
    fb.alpha_composite(f)
    sheet.paste(fb.convert("RGB").resize((8 * s, 8 * s), Image.NEAREST), (s, 0))
    bb = Image.new("RGB", b.size, (0, 0, 0))
    bb.paste(Image.new("RGB", b.size, (0xFF, 0xFF, 0xFF)), mask=b.getchannel("A"))
    sheet.paste(bb.resize((11 * s, 11 * s), Image.NEAREST), (10 * s, 0))
    sheet.save(path)


def main() -> None:
    f, b = front(), back()
    f.save(ROOT / "src/appmeta/icon_front_8x8.png", optimize=True)
    b.save(ROOT / "src/appmeta/icon_back_11x11.png", optimize=True)
    if "--preview" in sys.argv:
        preview(f, b, Path(sys.argv[sys.argv.index("--preview") + 1]))


if __name__ == "__main__":
    main()
