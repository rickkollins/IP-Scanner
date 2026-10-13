"""The scanning side: cameras, flatbed scanners and page clean-up.

- Camera: any camera macOS can see - the built-in one, a USB document
  camera, or an iPhone via Continuity Camera. Frames are read on a
  background thread; `PageWatcher` captures a page automatically once a new
  page has been turned and held still.
- Flatbed: via SANE's `scanimage` when it is installed
  (`brew install sane-backends`).
- Clean-up: find the page in a photo, flatten it (perspective correction),
  and split a two-page spread at the gutter.
"""

from __future__ import annotations

import io
import shutil
import subprocess
import threading
import time

import cv2
import numpy as np
from PIL import Image, ImageOps

try:  # iPhone photos (.heic)
    from pillow_heif import register_heif_opener
    register_heif_opener()
except ImportError:
    pass


# ---------------------------------------------------------------- cameras

def list_cameras(max_index: int = 5) -> list[int]:
    """Indexes of the cameras that open and deliver a frame."""
    found = []
    for i in range(max_index):
        cap = cv2.VideoCapture(i)
        try:
            if cap.isOpened() and cap.read()[0]:
                found.append(i)
        finally:
            cap.release()
    return found


class Camera:
    """Keeps the newest frame of a camera, read on a background thread."""

    def __init__(self, index: int = 0, width: int = 3840, height: int = 2160):
        self.index = index
        self.cap = cv2.VideoCapture(index)
        if not self.cap.isOpened():
            raise RuntimeError(
                f"Camera {index} could not be opened. On a Mac, allow camera access in "
                "System Settings → Privacy & Security → Camera.")
        # Ask for the highest resolution; the camera picks the nearest it has.
        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self._frame: np.ndarray | None = None
        self._lock = threading.Lock()
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        failures = 0
        while self._running:
            ok, frame = self.cap.read()
            if ok:
                failures = 0
                with self._lock:
                    self._frame = frame
            else:
                failures += 1
                if failures > 50:
                    self._running = False
                time.sleep(0.05)

    @property
    def alive(self) -> bool:
        return self._running

    def frame(self) -> np.ndarray | None:
        with self._lock:
            return None if self._frame is None else self._frame.copy()

    def close(self) -> None:
        self._running = False
        self._thread.join(timeout=2)
        self.cap.release()


class PageWatcher:
    """Decides when to auto-capture: after movement (a page being turned)
    the picture has to stay still for `still_seconds`."""

    def __init__(self, still_seconds: float = 1.2, moving: float = 12.0,
                 still: float = 3.0):
        self.still_seconds = still_seconds
        self.moving = moving
        self.still = still
        self._prev: np.ndarray | None = None
        self._armed = False
        self._still_since: float | None = None

    @staticmethod
    def _small(frame: np.ndarray) -> np.ndarray:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        return cv2.GaussianBlur(cv2.resize(gray, (160, 120)), (5, 5), 0)

    def reset(self) -> None:
        self._prev, self._armed, self._still_since = None, False, None

    def update(self, frame: np.ndarray, now: float | None = None) -> bool:
        """Feed a frame; True means 'capture this one now'."""
        now = time.monotonic() if now is None else now
        small = self._small(frame)
        prev, self._prev = self._prev, small
        if prev is None:
            return False
        diff = float(np.mean(cv2.absdiff(small, prev)))
        if diff > self.moving:
            self._armed, self._still_since = True, None
            return False
        if not self._armed:
            return False
        if diff < self.still:
            if self._still_since is None:
                self._still_since = now
            elif now - self._still_since >= self.still_seconds:
                self._armed, self._still_since = False, None
                return True
        else:
            self._still_since = None
        return False


# ---------------------------------------------------------------- flatbed

def flatbed_available() -> bool:
    return _scanimage() is not None


def _scanimage() -> str | None:
    return (shutil.which("scanimage") or shutil.which("/opt/homebrew/bin/scanimage")
            or shutil.which("/usr/local/bin/scanimage"))


def scan_flatbed(resolution: int = 300, timeout: float = 180) -> Image.Image:
    """One page from the default SANE scanner, in grayscale."""
    tool = _scanimage()
    if not tool:
        raise RuntimeError("scanimage was not found. Install it with "
                           "`brew install sane-backends`.")
    cmd = [tool, "--format=png", f"--resolution={resolution}", "--mode", "Gray"]
    proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if proc.returncode != 0 or not proc.stdout:
        msg = proc.stderr.decode(errors="replace").strip() or "no image returned"
        raise RuntimeError(f"The scanner failed: {msg}")
    return Image.open(io.BytesIO(proc.stdout)).copy()


# ---------------------------------------------------------------- clean-up

def to_pil(frame: np.ndarray) -> Image.Image:
    if frame.ndim == 2:
        return Image.fromarray(frame)
    return Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))


def to_cv(image: Image.Image) -> np.ndarray:
    return cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)


def _order(pts: np.ndarray) -> np.ndarray:
    """Corners as top-left, top-right, bottom-right, bottom-left."""
    pts = pts.reshape(4, 2).astype("float32")
    s = pts.sum(axis=1)
    d = np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)],
                     pts[np.argmax(s)], pts[np.argmax(d)]], dtype="float32")


def find_page(frame: np.ndarray, min_area: float = 0.2) -> np.ndarray | None:
    """The four corners of the page (or open book) in a photo, if found."""
    h, w = frame.shape[:2]
    scale = 800.0 / max(h, w)
    small = cv2.resize(frame, (int(w * scale), int(h * scale)))
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY) if small.ndim == 3 else small
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((5, 5), np.uint8), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    area_min = min_area * small.shape[0] * small.shape[1]
    for c in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        if cv2.contourArea(c) < area_min:
            break
        approx = cv2.approxPolyDP(c, 0.02 * cv2.arcLength(c, True), True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            return _order(approx / scale)
    return None


def flatten(frame: np.ndarray, corners: np.ndarray) -> np.ndarray:
    """Warp the area inside `corners` into a straight rectangle."""
    tl, tr, br, bl = corners
    width = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    height = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))
    dst = np.array([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]],
                   dtype="float32")
    matrix = cv2.getPerspectiveTransform(corners, dst)
    return cv2.warpPerspective(frame, matrix, (width, height))


def find_gutter(image: Image.Image) -> int:
    """x position of the fold between two facing pages.

    The gutter is the darkest (shadowed) or emptiest column strip near the
    middle; fall back to the exact middle.
    """
    gray = np.asarray(image.convert("L"), dtype=np.float32)
    w = gray.shape[1]
    lo, hi = int(w * 0.4), int(w * 0.6)
    if hi - lo < 3:
        return w // 2
    cols = gray[:, lo:hi].mean(axis=0)
    cols = np.convolve(cols, np.ones(9) / 9, mode="same")
    darkest = int(np.argmin(cols[4:-4])) + 4 if len(cols) > 8 else int(np.argmin(cols))
    # Only trust a clear shadow; an even page gives a near-flat profile.
    if cols.max() - cols[darkest] > 12:
        return lo + darkest
    return w // 2


def split_spread(image: Image.Image) -> tuple[Image.Image, Image.Image]:
    """Left and right page of a two-page spread."""
    x = find_gutter(image)
    w, h = image.size
    return image.crop((0, 0, x, h)), image.crop((x, 0, w, h))


def clean_page(image: Image.Image) -> Image.Image:
    """Grayscale with stretched contrast - easier to read and smaller."""
    return ImageOps.autocontrast(image.convert("L"), cutoff=1)


def process_capture(frame: np.ndarray, detect_page: bool = True,
                    spread: bool = False) -> list[Image.Image]:
    """Turn one camera frame into finished page images, in reading order."""
    if detect_page:
        corners = find_page(frame)
        if corners is not None:
            frame = flatten(frame, corners)
    image = to_pil(frame)
    pages = list(split_spread(image)) if spread else [image]
    return [clean_page(p) for p in pages]


def process_image(image: Image.Image, spread: bool = False) -> list[Image.Image]:
    """Finish an imported or flatbed-scanned image (already flat)."""
    image = ImageOps.exif_transpose(image)
    pages = list(split_spread(image)) if spread else [image]
    return [clean_page(p) for p in pages]
