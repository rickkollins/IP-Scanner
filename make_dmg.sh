#!/bin/bash
# Builds a self-contained "IP Scanner.app" (Python and Tk bundled inside)
# and packs it into an installable disk image:  dist/IP-Scanner-<version>.dmg
#
# Run on a Mac:  ./make_dmg.sh
# Needs Python 3 with Tk 8.6 (the python.org installer works). Set
# TARGET_ARCH=universal2 to build one app for Apple silicon and Intel Macs.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
BUILD="$SRC/build"
DIST="$SRC/dist"
VERSION=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$SRC/scanner.py")

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

# PyInstaller goes in a private virtual environment, not your system Python.
mkdir -p "$BUILD"
if [ ! -x "$BUILD/venv/bin/pyinstaller" ]; then
  "$PYTHON" -m venv "$BUILD/venv"
  "$BUILD/venv/bin/pip" install --quiet --upgrade pip pyinstaller
fi

rm -rf "$BUILD/pyinstaller" "$DIST/IP Scanner.app" "$DIST/IP Scanner"
"$BUILD/venv/bin/pyinstaller" --noconfirm --log-level WARN \
  --workpath "$BUILD/pyinstaller" --distpath "$DIST" \
  "$SRC/packaging/ip_scanner.spec"

APP="$DIST/IP Scanner.app"
# Ad-hoc signature so the app runs on Apple silicon. It is not notarized,
# so a downloaded copy needs "Open Anyway" once (see README).
codesign --force --deep --sign "${CODESIGN_IDENTITY:--}" "$APP"

# Disk image: the app plus an Applications shortcut to drag it onto.
STAGE="$BUILD/dmg"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

DMG="$DIST/IP-Scanner-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "IP Scanner" -srcfolder "$STAGE" -fs HFS+ \
  -format UDZO -imagekey zlib-level=9 -ov "$DMG" >/dev/null
rm -rf "$STAGE" "$DIST/IP Scanner"

echo
echo "Built: $DMG"
if [ -z "${CI:-}" ]; then
  open -R "$DMG"   # show it in Finder
fi
