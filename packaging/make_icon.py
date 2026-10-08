"""Draws the IP Scanner app icon: a radar sweep over network devices.

Writes packaging/icon.icns (for the .app) and data/icon.png (window icon).
Needs Pillow, only when regenerating:  python3 packaging/make_icon.py
"""

import math
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
S = 4  # supersampling factor for smooth edges
SIZE = 1024 * S

BG_TOP = (24, 58, 112)
BG_BOTTOM = (8, 20, 46)
RING = (90, 170, 230)
SWEEP = (52, 211, 153)
ALIVE = (52, 211, 153)
IDLE = (120, 150, 190)


def px(v: float) -> int:
    return int(round(v * S))


def tile_mask() -> Image.Image:
    # macOS Big Sur-style rounded square: 824 pt tile centred on a 1024 canvas.
    m = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        (px(100), px(100), px(924), px(924)), radius=px(185), fill=255)
    return m


def gradient() -> Image.Image:
    g = Image.new("RGB", (1, SIZE))
    for y in range(SIZE):
        t = y / (SIZE - 1)
        g.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))
    return g.resize((SIZE, SIZE))


def polar(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy - r * math.sin(a)


def draw() -> Image.Image:
    cx, cy = 512, 528
    rings = [110, 210, 310]
    sweep_to = 50  # degrees, counter-clockwise from 3 o'clock

    img = gradient().convert("RGBA")
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # Sweep: a fading wedge trailing the beam.
    trail = 75
    steps = 60
    for i in range(steps):
        a0 = sweep_to - trail + trail * i / steps
        alpha = int(150 * (i / steps) ** 2)
        d.pieslice((px(cx - 330), px(cy - 330), px(cx + 330), px(cy + 330)),
                   start=-(a0 + trail / steps), end=-a0, fill=SWEEP + (alpha,))

    # Range rings and cross hairs.
    for r in rings:
        d.ellipse((px(cx - r), px(cy - r), px(cx + r), px(cy + r)),
                  outline=RING + (110,), width=px(7))
    for deg in (0, 90):
        x1, y1 = polar(cx, cy, 330, deg)
        x2, y2 = polar(cx, cy, 330, deg + 180)
        d.line((px(x1), px(y1), px(x2), px(y2)), fill=RING + (55,), width=px(5))

    # Beam.
    bx, by = polar(cx, cy, 330, sweep_to)
    d.line((px(cx), px(cy), px(bx), px(by)), fill=(190, 255, 225, 255), width=px(9))

    # Devices on the network: (ring radius, angle, alive?)
    nodes = [(210, 28, True), (310, 12, True), (110, 120, False), (310, 145, False),
             (210, 205, False), (310, 250, True), (110, 300, False), (210, 330, True)]
    glow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    for r, deg, alive in nodes:
        x, y = polar(cx, cy, r, deg)
        d.line((px(cx), px(cy), px(x), px(y)), fill=IDLE + (70,), width=px(4))
        if alive:
            gd.ellipse((px(x - 46), px(y - 46), px(x + 46), px(y + 46)), fill=ALIVE + (150,))
    glow = glow.filter(ImageFilter.GaussianBlur(px(18)))
    layer = Image.alpha_composite(glow, layer)
    d = ImageDraw.Draw(layer)
    for r, deg, alive in nodes:
        x, y = polar(cx, cy, r, deg)
        rad = 30 if alive else 22
        d.ellipse((px(x - rad), px(y - rad), px(x + rad), px(y + rad)),
                  fill=(ALIVE if alive else IDLE) + (255,),
                  outline=(255, 255, 255, 230 if alive else 120), width=px(6))

    # Hub (this Mac).
    d.ellipse((px(cx - 34), px(cy - 34), px(cx + 34), px(cy + 34)), fill=(255, 255, 255, 255))
    d.ellipse((px(cx - 16), px(cy - 16), px(cx + 16), px(cy + 16)), fill=BG_TOP + (255,))

    img = Image.alpha_composite(img, layer)

    # Subtle top highlight on the tile.
    hl = Image.new("RGBA", img.size, (255, 255, 255, 0))
    ImageDraw.Draw(hl).ellipse((px(-200), px(-760), px(1224), px(330)),
                               fill=(255, 255, 255, 22))
    img = Image.alpha_composite(img, hl.filter(ImageFilter.GaussianBlur(px(40))))

    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), tile_mask())

    # Soft drop shadow under the tile, as macOS icons have.
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    sm = tile_mask().filter(ImageFilter.GaussianBlur(px(14)))
    shadow.paste((0, 0, 0, 110), (0, px(12)), sm)
    final = Image.alpha_composite(shadow, out)
    return final.resize((1024, 1024), Image.LANCZOS)


def main() -> None:
    icon = draw()
    icon.save(os.path.join(ROOT, "packaging", "icon.icns"),
              sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256),
                     (512, 512), (1024, 1024)])
    icon.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "data", "icon.png"))
    print("Wrote packaging/icon.icns and data/icon.png")


if __name__ == "__main__":
    main()
