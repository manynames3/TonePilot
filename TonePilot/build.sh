#!/bin/zsh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/TonePilot.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
echo "Building TonePilot…"
/usr/bin/swiftc -parse-as-library -O -framework SwiftUI -framework AppKit -framework Combine \
  "$HERE/Source/WorkspaceModel.swift" "$HERE/Source/TonePilotApp.swift" \
  -o "$APP/Contents/MacOS/TonePilot"
codesign --force --sign - "$APP"
echo "Ready: $APP"
