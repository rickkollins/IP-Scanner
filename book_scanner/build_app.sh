#!/bin/bash
# Builds "Book Scanner.app" and installs it into /Applications (falling back
# to ~/Applications if that isn't writable), or into the folder given as the
# first argument. Run on the Mac:  book_scanner/build_app.sh
#
# The app's Python packages (OpenCV, Pillow, python-docx, Apple Vision
# bindings) go into a private virtual environment inside the app, so your
# own Python stays untouched. Needs Python 3 with Tk 8.6 (python.org).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${1:-}" ]; then
  DEST="$1"
elif [ -w /Applications ]; then
  DEST=/Applications
else
  DEST="$HOME/Applications"
fi
APP="$DEST/Book Scanner.app"
VERSION=$(sed -n 's/^__version__ = "\(.*\)"/\1/p' "$SRC/book_scanner_gui.py")

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

mkdir -p "$DEST"
rm -rf "$APP"
RES="$APP/Contents/Resources"
mkdir -p "$APP/Contents/MacOS" "$RES"
cp "$SRC"/book_scanner_gui.py "$SRC"/book.py "$SRC"/capture.py "$SRC"/ocr.py \
   "$SRC"/export_docx.py "$SRC"/requirements.txt "$RES/"

echo "Installing the app's Python packages (this takes a minute)…"
"$PYTHON" -m venv "$RES/venv"
"$RES/venv/bin/pip" install --quiet --upgrade pip
"$RES/venv/bin/pip" install --quiet -r "$SRC/requirements.txt"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Book Scanner</string>
  <key>CFBundleDisplayName</key><string>Book Scanner</string>
  <key>CFBundleIdentifier</key><string>com.rickkollins.bookscanner</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Book Scanner</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSCameraUsageDescription</key>
  <string>Book Scanner uses the camera to photograph the pages of your book.</string>
  <key>NSContinuityCameraUsageDescription</key>
  <string>Book Scanner can use your iPhone as a camera to photograph book pages.</string>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/Book Scanner" <<'LAUNCHER'
#!/bin/bash
export TK_SILENCE_DEPRECATION=1
HERE="$(cd "$(dirname "$0")/../Resources" && pwd)"
if [ -x "$HERE/venv/bin/python3" ]; then
  exec "$HERE/venv/bin/python3" "$HERE/book_scanner_gui.py"
fi
osascript -e 'display alert "Book Scanner" message "The app is incomplete. Run book_scanner/build_app.sh again."'
exit 1
LAUNCHER
chmod +x "$APP/Contents/MacOS/Book Scanner"

echo
echo "Installed: $APP"
echo "Find it in Finder > Applications, Launchpad, or Spotlight (Cmd+Space, \"Book Scanner\")."
if [ -z "${1:-}" ] && command -v open >/dev/null; then
  open -R "$APP"
  open "$APP"
fi
