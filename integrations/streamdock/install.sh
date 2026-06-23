#!/usr/bin/env bash
set -euo pipefail
SRC="$(cd "$(dirname "$0")/com.cap.streamdock.sdPlugin" && pwd)"
DST="$HOME/Library/Application Support/HotSpot/StreamDock/plugins/com.cap.streamdock.sdPlugin"
mkdir -p "$(dirname "$DST")" "$HOME/.cap"
ln -sfn "$SRC" "$DST"
echo "Linked $DST -> $SRC"
echo "Restart VSD Craft to load the CAP plugin:"
echo "  osascript -e 'quit app \"VSD Craft\"'; sleep 1; open -a 'VSD Craft'"
