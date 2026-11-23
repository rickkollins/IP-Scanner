#!/usr/bin/env python3
"""Background removal core (and a small command-line tool).

Uses rembg, which runs a U^2-Net / IS-Net segmentation model locally through
onnxruntime. Nothing is uploaded; the model file (40-180 MB) is downloaded
once on first use into ~/.rembg (or $U2NET_HOME).

    python bgremove.py photo.jpg                 -> photo_nobg.png
    python bgremove.py a.jpg b.png -o out_dir/   -> out_dir/a_nobg.png, ...
"""

from __future__ import annotations

import argparse
import os
import sys
from functools import lru_cache

from PIL import Image, ImageOps

__version__ = "1.0.0"

# Label shown in the GUI -> rembg model name.
MODELS = {
    "General": "u2net",
    "General, high quality": "isnet-general-use",
    "People / portraits": "u2net_human_seg",
    "Fast (small model)": "u2netp",
}
DEFAULT_MODEL = "u2net"

OPEN_TYPES = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif")


@lru_cache(maxsize=4)
def _session(model: str):
    from rembg import new_session  # imported lazily: it is slow to import
    return new_session(model)


def model_is_downloaded(model: str) -> bool:
    """Best-effort check (rembg has moved its model folder between versions)."""
    xdg = os.environ.get("XDG_DATA_HOME")
    homes = [os.environ.get("U2NET_HOME"), os.path.join(xdg, "rembg") if xdg else None,
             os.path.join(xdg or "~", ".u2net"), "~/.rembg", "~/.u2net"]
    for home in filter(None, homes):
        home = os.path.expanduser(home)
        for path in (os.path.join(home, "models", model, f"{model}.onnx"),
                     os.path.join(home, f"{model}.onnx")):
            if os.path.exists(path):
                return True
    return False


def load_image(path: str) -> Image.Image:
    """Open an image, applying its EXIF rotation so phone photos are upright."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() or "transparency" in img.info
                          else "RGB")
    return img


def remove_background(img: Image.Image, model: str = DEFAULT_MODEL,
                      refine_edges: bool = False) -> Image.Image:
    """Return a copy of img with the background made transparent (RGBA)."""
    from rembg import remove
    out = remove(img, session=_session(model), alpha_matting=refine_edges,
                 alpha_matting_foreground_threshold=240,
                 alpha_matting_background_threshold=10,
                 alpha_matting_erode_size=10)
    return out.convert("RGBA")


def crop_to_subject(img: Image.Image, margin: int = 0) -> Image.Image:
    """Trim fully transparent borders from an RGBA image."""
    box = img.getchannel("A").getbbox()
    if not box:
        return img
    l, t, r, b = box
    return img.crop((max(l - margin, 0), max(t - margin, 0),
                     min(r + margin, img.width), min(b + margin, img.height)))


def default_output_path(src: str, out_dir: str | None = None) -> str:
    stem = os.path.splitext(os.path.basename(src))[0]
    folder = out_dir if out_dir else os.path.dirname(os.path.abspath(src))
    return os.path.join(folder, f"{stem}_nobg.png")


def save_png(img: Image.Image, path: str) -> str:
    if not path.lower().endswith(".png"):
        path += ".png"
    img.save(path, "PNG", optimize=True)
    return path


def self_test(report: str, model: str = "u2netp") -> int:
    """Remove the background of a generated picture and check the result.

    Used by CI to prove a packaged build (rembg + onnxruntime) really works.
    Each stage is written to the report as it happens, so if a build hangs
    the report shows where. Returns 0 on success.
    """
    from PIL import ImageDraw

    def log(line: str) -> None:
        with open(report, "a") as f:
            f.write(line + "\n")

    open(report, "w").close()
    log(f"Background Remover {__version__} self-test, model {model}")
    ok = False
    try:
        img = Image.new("RGB", (320, 240), (70, 140, 220))
        ImageDraw.Draw(img).ellipse((100, 50, 220, 190), fill=(230, 60, 40))
        log("removing background...")
        out = remove_background(img, model)
        corner, centre = out.getpixel((5, 5))[3], out.getpixel((160, 120))[3]
        log(f"mode={out.mode} size={out.size} corner_alpha={corner} centre_alpha={centre}")
        ok = out.mode == "RGBA" and corner < 40 and centre > 200
        # "Refine edges" goes through pymatting/numba, which can break when frozen.
        log("removing background with refined edges...")
        refined = remove_background(img, model, refine_edges=True)
        r_corner, r_centre = refined.getpixel((5, 5))[3], refined.getpixel((160, 120))[3]
        log(f"refined: corner_alpha={r_corner} centre_alpha={r_centre}")
        ok = ok and r_corner < 40 and r_centre > 200
    except Exception:
        import traceback
        log(traceback.format_exc())
    log("PASS" if ok else "FAIL")
    return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Remove the background from images "
                                             "(saves transparent PNGs).")
    ap.add_argument("images", nargs="+", help="input image file(s)")
    ap.add_argument("-o", "--output", help="output file (one input) or folder")
    ap.add_argument("-m", "--model", default=DEFAULT_MODEL,
                    choices=sorted(set(MODELS.values())))
    ap.add_argument("--refine", action="store_true",
                    help="refine edges with alpha matting (slower; helps hair/fur)")
    ap.add_argument("--crop", action="store_true", help="trim transparent borders")
    args = ap.parse_args(argv)

    out_is_dir = args.output and (len(args.images) > 1 or os.path.isdir(args.output))
    if out_is_dir:
        os.makedirs(args.output, exist_ok=True)

    failures = 0
    for src in args.images:
        try:
            result = remove_background(load_image(src), args.model, args.refine)
            if args.crop:
                result = crop_to_subject(result)
            if args.output and not out_is_dir:
                dest = args.output
            else:
                dest = default_output_path(src, args.output if out_is_dir else None)
            print(f"{src} -> {save_png(result, dest)}")
        except Exception as exc:  # keep going with the other files
            failures += 1
            print(f"{src}: {exc}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
