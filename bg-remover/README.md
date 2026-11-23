# Background Remover

A small desktop app that removes the background from a photo and saves the
result as a **transparent PNG**. The AI model ([rembg](https://github.com/danielgatis/rembg),
U²-Net / IS-Net via onnxruntime) runs locally, so images never leave your computer.

It shares the light-blue / dark theme with IP Scanner (`../theme.py`).

## Setup

Python 3.10+ with Tk (the python.org installers for macOS and Windows include it).

```bash
cd bg-remover
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Use the app

```bash
python bg_remover_gui.py            # or: python bg_remover_gui.py photo.jpg
```

1. **Open Image…** (Ctrl/⌘+O): PNG, JPEG, WebP, BMP, TIFF or GIF.
2. **Remove Background** (Enter). The first run of each model downloads it
   once (5–180 MB) into `~/.rembg`; after that it works offline.
3. **Save PNG…** (Ctrl/⌘+S): saves `<name>_nobg.png` with a transparent background.

Options:

| Option | What it does |
| --- | --- |
| Model → General | Good default for most photos (u2net) |
| Model → General, high quality | Sharper edges, a bit slower (isnet-general-use) |
| Model → People / portraits | Tuned for people (u2net_human_seg) |
| Model → Fast (small model) | 5 MB model, quickest, rougher edges (u2netp) |
| Refine edges | Alpha matting: better hair and fur, noticeably slower |
| Crop to subject | Trims the empty transparent border from the saved PNG |

The checkerboard behind the result shows which parts are transparent.
Settings (window size, model, options, last folders, theme) are kept in
`~/.bg_remover.json`.

## Command line

```bash
python bgremove.py photo.jpg                       # -> photo_nobg.png
python bgremove.py *.jpg -o cutouts/ --crop        # batch into a folder
python bgremove.py portrait.jpg -m u2net_human_seg --refine
```

## Tests

```bash
python -m unittest discover -s tests -v
```

The model tests are skipped if rembg isn't installed.
