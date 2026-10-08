#!/bin/bash
# Builds "IP Scanner.app" and installs it into ~/Applications (or the folder
# given as the first argument). Run on the Mac:  ./build_app.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-$HOME/Applications}"
APP="$DEST/IP Scanner.app"

mkdir -p "$DEST"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$SRC/scanner.py" "$SRC/ip_scanner_gui.py" "$APP/Contents/Resources/"
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
# Find a Python 3 that has Tkinter and start the GUI with it.
HERE="$(cd "$(dirname "$0")/../Resources" && pwd)"
for PY in /opt/homebrew/bin/python3 /usr/local/bin/python3 \
          /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
          /usr/bin/python3; do
  if [ -x "$PY" ] && "$PY" -c "import tkinter" >/dev/null 2>&1; then
    exec "$PY" "$HERE/ip_scanner_gui.py"
  fi
done
osascript -e 'display alert "IP Scanner" message "Python 3 with Tkinter was not found.\n\nInstall it with:  xcode-select --install\nor:  brew install python-tk"'
exit 1
LAUNCHER
chmod +x "$APP/Contents/MacOS/IP Scanner"

echo "Installed: $APP"
echo "Open it from Finder/Launchpad, or run:  open \"$APP\""
