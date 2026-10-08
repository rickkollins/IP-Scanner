#!/bin/bash
# Builds "IP Scanner.app" and installs it into /Applications (falling back to
# ~/Applications if that isn't writable), or into the folder given as the
# first argument. Run on the Mac:  ./build_app.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${1:-}" ]; then
  DEST="$1"
elif [ -w /Applications ]; then
  DEST=/Applications
else
  DEST="$HOME/Applications"
fi
APP="$DEST/IP Scanner.app"

mkdir -p "$DEST"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$SRC/scanner.py" "$SRC/ip_scanner_gui.py" "$SRC/report.py" "$APP/Contents/Resources/"
cp -R "$SRC/data" "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>IP Scanner</string>
  <key>CFBundleDisplayName</key><string>IP Scanner</string>
  <key>CFBundleIdentifier</key><string>com.rickkollins.ipscanner</string>
  <key>CFBundleVersion</key><string>2.0</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>IP Scanner</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSLocalNetworkUsageDescription</key>
  <string>IP Scanner probes devices on your local network to find alive hosts and open ports.</string>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/IP Scanner" <<'LAUNCHER'
#!/bin/bash
# Start the GUI with the best Python 3 that has Tkinter. Apple's
# /usr/bin/python3 ships the old Tk 8.5, which can draw blank windows on
# recent macOS, so any Python with Tk 8.6+ (python.org, Homebrew) wins.
export TK_SILENCE_DEPRECATION=1
HERE="$(cd "$(dirname "$0")/../Resources" && pwd)"
CANDIDATES=(
  /Library/Frameworks/Python.framework/Versions/3.*/bin/python3
  /opt/homebrew/bin/python3 /opt/homebrew/opt/python@3.*/bin/python3
  /usr/local/bin/python3 /usr/local/opt/python@3.*/bin/python3
  /usr/bin/python3
)
FALLBACK=""
for PY in "${CANDIDATES[@]}"; do
  [ -x "$PY" ] || continue
  TK=$("$PY" -c "import tkinter; print(tkinter.TkVersion)" 2>/dev/null) || continue
  if [ "${TK%%.*}" -ge 9 ] || [ "$TK" = "8.6" ]; then
    exec "$PY" "$HERE/ip_scanner_gui.py"
  fi
  [ -z "$FALLBACK" ] && FALLBACK="$PY"
done
if [ -n "$FALLBACK" ]; then
  exec "$FALLBACK" "$HERE/ip_scanner_gui.py"
fi
osascript -e 'display alert "IP Scanner" message "Python 3 with Tkinter was not found.\n\nInstall Python from python.org/downloads, then open IP Scanner again."'
exit 1
LAUNCHER
chmod +x "$APP/Contents/MacOS/IP Scanner"

# Remove the copy an older version of this script put in ~/Applications.
OLD="$HOME/Applications/IP Scanner.app"
if [ "$APP" != "$OLD" ] && [ -d "$OLD" ]; then
  rm -rf "$OLD"
fi

echo
echo "Installed: $APP"
echo "Find it in Finder > Applications, Launchpad, or Spotlight (Cmd+Space, \"IP Scanner\")."
if [ -z "${1:-}" ] && command -v open >/dev/null; then
  open -R "$APP"   # show it in Finder
  open "$APP"
fi
