#!/usr/bin/env bash
# Build the RelayTimer firmware with arduino-cli and collect the .bin files
# in esp32-relay-timer/dist/.  Needs arduino-cli with the esp32 core and
# ArduinoJson installed (see .github/workflows/relaytimer.yml).
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
FQBN="esp32:esp32:esp32c3:CDCOnBoot=cdc,PartitionScheme=default"
BUILD="$HERE/build"
DIST="$HERE/dist"

python3 "$HERE/tools/embed_html.py"
rm -rf "$BUILD" "$DIST"
arduino-cli compile --fqbn "$FQBN" --output-dir "$BUILD" "$HERE/RelayTimer"

mkdir -p "$DIST"
if [ ! -f "$BUILD/RelayTimer.ino.merged.bin" ]; then
  echo "merged image missing from the build output" >&2
  exit 1
fi
cp "$BUILD/RelayTimer.ino.merged.bin"     "$DIST/RelayTimer-esp32c3-full.bin"
cp "$BUILD/RelayTimer.ino.bin"            "$DIST/RelayTimer-esp32c3-app.bin"
cp "$BUILD/RelayTimer.ino.bootloader.bin" "$DIST/RelayTimer-esp32c3-bootloader.bin"
cp "$BUILD/RelayTimer.ino.partitions.bin" "$DIST/RelayTimer-esp32c3-partitions.bin"
ls -l "$DIST"
