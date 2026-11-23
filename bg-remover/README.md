# Background Remover

A small desktop app that removes the background from a photo and saves the
result as a **transparent PNG**. The AI model ([rembg](https://github.com/danielgatis/rembg),
U²-Net / IS-Net via onnxruntime) runs locally, so images never leave your computer.

It shares the light-blue / dark theme with IP Scanner (`../theme.py`).

## Download

Ready-made apps are built by GitHub Actions
([.github/workflows/bg-remover.yml](../.github/workflows/bg-remover.yml)) on
every push that changes `bg-remover/`. Open the run under the repository's
**Actions → Background Remover** tab and download the artifacts. Each merge
to `main` with a new version also publishes a `bg-remover-v<version>`
release.

- **Mac (macOS 14 Sonoma or later):** `Background-Remover-<version>-arm64.dmg`
  (Apple silicon) or `-x86_64.dmg` (Intel). Open it and drag the app to Applications. The app
  isn't notarized, so the first launch needs System Settings → Privacy &
  Security → **Open Anyway**. You can also drop an image on its Dock icon or
  use Finder's **Open With**.
- **Windows 10/11:** `Background-Remover-Setup-<version>.exe` (no admin
  rights needed; SmartScreen: **More info → Run anyway**), or the portable
  `.zip`. The installer adds Background Remover to Explorer's **Open with** menu.

## Run from source

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

## Build the apps yourself

```bash
./bg-remover/make_dmg.sh                 # on a Mac -> bg-remover/dist/*.dmg
```

```powershell
.\bg-remover\make_installer.ps1          # on Windows, needs Inno Setup 6
```

Both use [packaging/bg_remover.spec](packaging/bg_remover.spec) (PyInstaller)
and a private virtual environment under `bg-remover/build/`. The Mac build
targets the Mac it runs on (onnxruntime, numba and scipy have no universal2
wheels). The bundles are large (about 250–400 MB) because they include
onnxruntime, scipy and numba. The AI model isn't bundled: it downloads on
first use.

To check a packaged build, run `<app executable> --self-test report.txt`.
It removes the background from a generated picture with and without
"Refine edges", checks that Tk can draw the preview, writes the report, and
exits 0 on success. To redraw the icon, run `python packaging/make_icon.py`.

## Tests

```bash
python -m unittest discover -s tests -v
```

The model tests are skipped if rembg isn't installed.
