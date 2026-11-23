"""Draws the Background Remover app icon: a portrait silhouette whose
background is half photo, half transparency checkerboard.

Writes packaging/icon.icns (macOS), packaging/icon.ico (Windows) and
assets/icon.png (window icon). Needs Pillow:  python3 packaging/make_icon.py
"""

import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
S = 4
SIZE = 1024 * S

TOP, BOTTOM = (43, 139, 224), (20, 62, 128)    # theme light blue -> deep blue
CHECK_A, CHECK_B = (250, 252, 255), (205, 218, 234)
FIGURE = (255, 196, 140)
SHIRT = (52, 211, 153)


def px(v: float) -> int:
    return int(round(v * S))


def draw() -> Image.Image:
    tile = (px(100), px(100), px(924), px(924))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle(tile, radius=px(185), fill=255)

    # Photo side: vertical gradient.
    photo = Image.new("RGB", (1, SIZE))
    for y in range(SIZE):
        t = y / (SIZE - 1)
        photo.putpixel((0, y), tuple(int(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    photo = photo.resize((SIZE, SIZE))

    # Cut-out side: checkerboard.
    board = Image.new("RGB", (SIZE, SIZE), CHECK_A)
    d = ImageDraw.Draw(board)
    sq = px(68)
    for i, x in enumerate(range(0, SIZE, sq)):
        for j, y in enumerate(range(0, SIZE, sq)):
            if (i + j) % 2:
                d.rectangle((x, y, x + sq - 1, y + sq - 1), fill=CHECK_B)

    # Diagonal split: photo top-left, transparency bottom-right.
    split = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(split).polygon([(SIZE, 0), (SIZE, SIZE), (0, SIZE)], fill=255)
    bg = Image.composite(board, photo, split)

    # Person silhouette.
    fig = ImageDraw.Draw(bg)
    fig.rounded_rectangle((px(262), px(600), px(762), px(1000)), radius=px(200), fill=SHIRT)
    fig.ellipse((px(352), px(250), px(672), px(570)), fill=FIGURE)

    # Dashed cut line along the diagonal.
    line = ImageDraw.Draw(bg)
    for k in range(0, 1024, 64):
        a, b = k, k + 34
        line.line([(px(1024 - a), px(a)), (px(1024 - b), px(b))], fill=(255, 255, 255),
                  width=px(14))

    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(bg, (0, 0), mask)
    return out.resize((1024, 1024), Image.LANCZOS)


def main() -> None:
    img = draw()
    os.makedirs(os.path.join(ROOT, "assets"), exist_ok=True)
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "assets", "icon.png"))
    img.save(os.path.join(HERE, "icon.icns"))
    # Windows icons look better without the macOS margin around the tile.
    win = img.crop((100, 100, 924, 924)).resize((256, 256), Image.LANCZOS)
    win.save(os.path.join(HERE, "icon.ico"),
             sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("Wrote icon.icns, icon.ico and assets/icon.png")


if __name__ == "__main__":
    main()
