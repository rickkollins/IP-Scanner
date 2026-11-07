"""Draws the System Monitor app icon: a usage gauge over a memory bar.

Writes system_monitor/icon.icns (macOS app) and system_monitor/icon.png
(window icon). Needs Pillow, only when regenerating:
    python3 system_monitor/make_icon.py
"""

import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
S = 4  # supersampling
SIZE = 1024 * S

BG_TOP = (24, 58, 112)
BG_BOTTOM = (8, 20, 46)
TRACK = (45, 80, 130)
ARC = [(52, 211, 153), (79, 179, 255), (255, 173, 79)]
SEGMENTS = [((79, 179, 255), 0.42), ((255, 173, 79), 0.16), ((192, 140, 255), 0.10),
            ((47, 106, 153), 0.18)]


def px(v: float) -> int:
    return int(round(v * S))


def draw() -> Image.Image:
    g = Image.new("RGB", (1, SIZE))
    for y in range(SIZE):
        t = y / (SIZE - 1)
        g.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    img = g.resize((SIZE, SIZE)).convert("RGBA")
    d = ImageDraw.Draw(img)

    # Gauge: a 240-degree arc, filled to about 70 % in green -> blue -> orange.
    cx, cy, r, width = 512, 470, 270, 70
    box = (px(cx - r), px(cy - r), px(cx + r), px(cy + r))
    start, sweep = 150, 240  # PIL angles run clockwise from 3 o'clock
    d.arc(box, start, start + sweep, fill=TRACK, width=px(width))
    filled = 0.7 * sweep
    steps = 120
    for i in range(steps):
        t = i / steps
        a0 = start + filled * t
        k = t * (len(ARC) - 1)
        lo, f = int(k), k - int(k)
        hi = min(lo + 1, len(ARC) - 1)
        col = tuple(int(ARC[lo][j] + (ARC[hi][j] - ARC[lo][j]) * f) for j in range(3))
        d.arc(box, a0, a0 + filled / steps + 0.6, fill=col, width=px(width))
    # Round caps.
    for ang, col in ((start, ARC[0]), (start + filled, ARC[-1])):
        a = math.radians(ang)
        x, y = cx + (r - width / 2) * math.cos(a), cy + (r - width / 2) * math.sin(a)
        d.ellipse((px(x - width / 2), px(y - width / 2), px(x + width / 2),
                   px(y + width / 2)), fill=col)
    # Needle and hub.
    a = math.radians(start + filled)
    nx, ny = cx + 190 * math.cos(a), cy + 190 * math.sin(a)
    d.line((px(cx), px(cy), px(nx), px(ny)), fill=(235, 245, 255), width=px(22))
    d.ellipse((px(cx - 42), px(cy - 42), px(cx + 42), px(cy + 42)), fill=(235, 245, 255))

    # Segmented memory bar.
    x0, x1, y0, h = 250, 774, 720, 70
    d.rounded_rectangle((px(x0), px(y0), px(x1), px(y0 + h)), radius=px(h / 2), fill=TRACK)
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((px(x0), px(y0), px(x1), px(y0 + h)),
                                           radius=px(h / 2), fill=255)
    bar = Image.new("RGBA", img.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(bar)
    x = x0
    for col, frac in SEGMENTS:
        w = (x1 - x0) * frac
        bd.rectangle((px(x), px(y0), px(x + w), px(y0 + h)), fill=col)
        x += w
    img.paste(bar, (0, 0), Image.composite(bar, Image.new("RGBA", img.size), mask).split()[3])

    # macOS-style rounded tile.
    tile = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(tile).rounded_rectangle((px(100), px(100), px(924), px(924)),
                                           radius=px(185), fill=255)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(img, (0, 0), tile)
    return out.resize((1024, 1024), Image.LANCZOS)


def main() -> None:
    icon = draw()
    icon.save(os.path.join(HERE, "icon.icns"))
    icon.resize((128, 128), Image.LANCZOS).save(os.path.join(HERE, "icon.png"))
    print("Wrote icon.icns and icon.png")


if __name__ == "__main__":
    main()
