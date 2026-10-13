"""Text recognition for scanned pages.

Two engines produce the same result, a list of Line objects in pixel
coordinates (origin top-left):

- Apple Vision (macOS 10.15+, via pyobjc) - built into the Mac, nothing
  else to install, and the most accurate choice there.
- Tesseract (any platform, via pytesseract) - needs the tesseract program
  (`brew install tesseract` on a Mac, `apt install tesseract-ocr` on Linux).
"""

from __future__ import annotations

import io
import shutil
import sys
from dataclasses import asdict, dataclass

from PIL import Image


@dataclass
class Line:
    text: str
    x: float
    y: float
    w: float
    h: float
    conf: float = 1.0

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def bottom(self) -> float:
        return self.y + self.h

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Line":
        return cls(**d)


class OCRError(RuntimeError):
    pass


def vision_available() -> bool:
    if sys.platform != "darwin":
        return False
    try:
        import Vision  # noqa: F401
        from Foundation import NSData  # noqa: F401
    except ImportError:
        return False
    return True


def tesseract_available() -> bool:
    try:
        import pytesseract  # noqa: F401
    except ImportError:
        return False
    return shutil.which("tesseract") is not None or _brew_tesseract() is not None


def _brew_tesseract() -> str | None:
    # Apps started from Finder don't get Homebrew's PATH.
    for path in ("/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"):
        if shutil.which(path):
            return path
    return None


def engines() -> list[str]:
    """Names of the engines that work on this computer, best first."""
    names = []
    if vision_available():
        names.append("Apple Vision")
    if tesseract_available():
        names.append("Tesseract")
    return names


def recognize(image: Image.Image, engine: str | None = None,
              language: str = "en-US") -> list[Line]:
    """OCR one page image. `engine` defaults to the best available one."""
    available = engines()
    if not available:
        raise OCRError(
            "No text recognition engine found. On a Mac install the "
            "requirements (pyobjc-framework-Vision); elsewhere install Tesseract.")
    engine = engine if engine in available else available[0]
    if engine == "Apple Vision":
        return _recognize_vision(image, language)
    return _recognize_tesseract(image, language)


def _recognize_vision(image: Image.Image, language: str) -> list[Line]:
    gray = image.convert("L")
    lines = _vision_lines(gray, language, correct=True)
    # Vision skips a lone page number in the margin, so read each patch of
    # ink in the header and footer strips again, enlarged, as its own image.
    width, height = gray.size
    strip = int(height * MARGIN_STRIP)
    for top in (0, height - strip):
        for x0, y0, x1, y1 in _ink_patches(gray.crop((0, top, width, top + strip))):
            y0, y1 = y0 + top, y1 + top
            if any(y0 < o.bottom and o.y < y1 and x0 < o.right and o.x < x1
                   for o in lines):
                continue
            pad = max(8, (y1 - y0) // 2)
            box = (max(0, x0 - pad), max(0, y0 - pad), min(width, x1 + pad),
                   min(height, y1 + pad))
            patch = gray.crop(box)
            scale = max(1.0, 96.0 / patch.height)
            patch = patch.resize((int(patch.width * scale), int(patch.height * scale)),
                                 Image.LANCZOS)
            for ln in _vision_lines(patch, language, correct=False):
                lines.append(Line(ln.text, box[0] + ln.x / scale, box[1] + ln.y / scale,
                                  ln.w / scale, ln.h / scale, ln.conf))
    lines.sort(key=lambda ln: (ln.y, ln.x))
    return lines


def _ink_patches(strip: Image.Image) -> list[tuple[int, int, int, int]]:
    """Boxes around groups of dark pixels in a margin strip, left to right."""
    import numpy as np

    a = np.asarray(strip, dtype=np.uint8)
    if a.size == 0:
        return []
    ink = a < min(128, int(a.mean()) - 40)
    rows = np.where(ink.any(axis=1))[0]
    cols = np.where(ink.any(axis=0))[0]
    if len(rows) == 0:
        return []
    gap = max(10, a.shape[0] // 4)
    patches, start, prev = [], cols[0], cols[0]
    for c in list(cols[1:]) + [None]:
        if c is None or c - prev > gap:
            sub = ink[:, start:prev + 1]
            r = np.where(sub.any(axis=1))[0]
            # Skip specks and anything cut by the strip's edges (body text).
            cut = r[0] == 0 or r[-1] == a.shape[0] - 1
            if prev - start >= 2 and r[-1] - r[0] >= 4 and not cut:
                patches.append((int(start), int(r[0]), int(prev) + 1, int(r[-1]) + 1))
            if c is not None:
                start = c
        if c is not None:
            prev = c
    return patches[:12]


def _vision_lines(image: Image.Image, language: str, correct: bool) -> list[Line]:
    import Vision
    from Foundation import NSData

    width, height = image.size
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    png = buf.getvalue()
    data = NSData.dataWithBytes_length_(png, len(png))
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    request.setUsesLanguageCorrection_(correct)
    if hasattr(request, "setMinimumTextHeight_"):
        request.setMinimumTextHeight_(0.0)
    if language:
        request.setRecognitionLanguages_([language])
    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise OCRError(f"Apple Vision could not read the page: {error}")
    lines = []
    for obs in request.results() or []:
        candidates = obs.topCandidates_(1)
        if not candidates:
            continue
        cand = candidates[0]
        text = str(cand.string()).strip()
        if not text:
            continue
        box = obs.boundingBox()  # normalised, origin bottom-left
        x = box.origin.x * width
        w = box.size.width * width
        h = box.size.height * height
        y = (1.0 - box.origin.y - box.size.height) * height
        lines.append(Line(text, x, y, w, h, float(cand.confidence())))
    lines.sort(key=lambda ln: (ln.y, ln.x))
    return lines


TESSERACT_LANGS = {"en": "eng", "de": "deu", "fr": "fra", "es": "spa", "it": "ita",
                   "pt": "por", "nl": "nld"}


def _recognize_tesseract(image: Image.Image, language: str) -> list[Line]:
    import pytesseract

    if not shutil.which("tesseract") and _brew_tesseract():
        pytesseract.pytesseract.tesseract_cmd = _brew_tesseract()
    lang = TESSERACT_LANGS.get(language.split("-")[0].lower(), "eng")
    gray = image.convert("L")
    lines = _tesseract_lines(gray, lang, "--psm 3")
    # Full-page layout analysis tends to drop a lone page number in the
    # margin, so read the header and footer strips again as plain blocks.
    width, height = gray.size
    strip = int(height * MARGIN_STRIP)
    for top in (0, height - strip):
        crop = gray.crop((0, top, width, top + strip))
        for ln in _tesseract_lines(crop, lang, "--psm 6"):
            ln.y += top
            overlaps = any(ln.y < o.bottom and o.y < ln.bottom for o in lines)
            inside = (top == 0 or ln.y > top) and ln.bottom < top + strip
            if not overlaps and inside:
                lines.append(ln)
    lines.sort(key=lambda ln: (ln.y, ln.x))
    return lines


MARGIN_STRIP = 0.12


def _tesseract_lines(image: Image.Image, lang: str, config: str) -> list[Line]:
    import pytesseract

    try:
        data = pytesseract.image_to_data(
            image, lang=lang, config=config, output_type=pytesseract.Output.DICT)
    except pytesseract.TesseractError as e:
        raise OCRError(f"Tesseract could not read the page: {e}") from e
    groups: dict[tuple, list[int]] = {}
    for i, word in enumerate(data["text"]):
        if not word.strip() or float(data["conf"][i]) < 0:
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        groups.setdefault(key, []).append(i)
    lines = []
    for idx in groups.values():
        idx.sort(key=lambda i: data["left"][i])
        x0 = min(data["left"][i] for i in idx)
        y0 = min(data["top"][i] for i in idx)
        x1 = max(data["left"][i] + data["width"][i] for i in idx)
        y1 = max(data["top"][i] + data["height"][i] for i in idx)
        text = " ".join(data["text"][i].strip() for i in idx)
        conf = sum(float(data["conf"][i]) for i in idx) / len(idx) / 100.0
        lines.append(Line(text, x0, y0, x1 - x0, y1 - y0, conf))
    return lines
