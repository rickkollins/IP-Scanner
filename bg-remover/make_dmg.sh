#!/bin/bash
# Builds a self-contained "Background Remover.app" (Python, Tk, rembg and
# onnxruntime bundled) and packs it into a disk image:
#   bg-remover/dist/Background-Remover-<version>-<arch>.dmg
#
# Run on a Mac:  ./bg-remover/make_dmg.sh
# Needs Python 3.10+ with Tk 8.6 (the python.org installer works). The app
# runs on macOS 14 or later (numpy/scipy wheels need it). It is
# built for the Mac it runs on (Apple silicon or Intel): onnxruntime, numba
# and scipy don't publish universal2 wheels.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
BUILD="$SRC/build"
DIST="$SRC/dist"
NAME="Background Remover"
VERSION=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$SRC/bgremove.py")
ARCH=$(uname -m)

if [ "$(uname)" != "Darwin" ]; then
  echo "make_dmg.sh must run on macOS (it uses hdiutil)." >&2
  exit 1
fi

# Pick a Python with Tk 8.6+ (Apple's /usr/bin/python3 has the old Tk 8.5).
PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for PY in /Library/Frameworks/Python.framework/Versions/3.*/bin/python3 \
            /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    [ -x "$PY" ] || continue
    TK=$("$PY" -c "import tkinter; print(tkinter.TkVersion)" 2>/dev/null) || continue
    if [ "$TK" = "8.6" ] || [ "${TK%%.*}" -ge 9 ]; then PYTHON="$PY"; break; fi
  done
fi
if [ -z "$PYTHON" ]; then
  echo "No Python with Tk 8.6 found. Install Python from https://www.python.org/downloads/" >&2
  exit 1
fi
echo "Using $PYTHON"

# Dependencies and PyInstaller go in a private virtual environment.
mkdir -p "$BUILD"
if [ ! -x "$BUILD/venv/bin/pyinstaller" ]; then
  "$PYTHON" -m venv "$BUILD/venv"
  "$BUILD/venv/bin/pip" install --quiet --upgrade pip
  # Prebuilt wheels only: the newest numba/llvmlite/onnxruntime have no
  # Intel Mac wheels, and building them from source fails. pip then picks
  # the newest versions that do have wheels for this Mac.
  "$BUILD/venv/bin/pip" install --quiet --only-binary=:all: \
    -r "$SRC/requirements.txt" pyinstaller
fi

rm -rf "$BUILD/pyinstaller" "$DIST/$NAME.app" "$DIST/$NAME"
"$BUILD/venv/bin/pyinstaller" --noconfirm --log-level WARN \
  --workpath "$BUILD/pyinstaller" --distpath "$DIST" \
  "$SRC/packaging/bg_remover.spec"

APP="$DIST/$NAME.app"
# Ad-hoc signature so the app runs on Apple silicon. It is not notarized,
# so a downloaded copy needs "Open Anyway" once (see README).
codesign --force --deep --sign "${CODESIGN_IDENTITY:--}" "$APP"

# Disk image: the app plus an Applications shortcut to drag it onto.
STAGE="$BUILD/dmg"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

DMG="$DIST/Background-Remover-$VERSION-$ARCH.dmg"
rm -f "$DMG"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -fs HFS+ \
  -format UDZO -imagekey zlib-level=9 -ov "$DMG" >/dev/null
rm -rf "$STAGE" "$DIST/$NAME"

echo
echo "Built: $DMG"
if [ -z "${CI:-}" ]; then
  open -R "$DMG"   # show it in Finder
fi
