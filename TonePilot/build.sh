#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$HOME/Applications/TonePilot.app"
if [[ -v TONEPILOT_APP_PATH ]]; then APP="$TONEPILOT_APP_PATH"; fi
RESOURCES="$APP/Contents/Resources"

mkdir -p "$APP/Contents/MacOS" "$RESOURCES"
echo "Building TonePilot for macOS…"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>TonePilot</string>
    <key>CFBundleDisplayName</key><string>TonePilot</string>
    <key>CFBundleIdentifier</key><string>app.tonepilot.mac</string>
    <key>CFBundleExecutable</key><string>TonePilot</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>0.3.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>CFBundleIconFile</key><string>TonePilot</string>
</dict>
</plist>
PLIST

/usr/bin/swiftc -parse-as-library -O -framework SwiftUI -framework AppKit -framework Combine \
    "$ROOT/Source/WorkspaceModel.swift" \
    "$ROOT/Source/TonePilotApp.swift" \
    -o "$APP/Contents/MacOS/TonePilot"

# Include an icon so a clean checkout builds a complete, recognizable .app.
if /usr/bin/swift "$ROOT/Source/IconMaker.swift" >/dev/null; then
    iconset="$(mktemp -d /tmp/TonePilot-iconset.XXXXXX)/TonePilot.iconset"
    mkdir -p "$iconset"
    for points in 16 32 128 256 512; do
        pixels=$((points * 2))
        /usr/bin/sips -z "$points" "$points" /tmp/tonepilot-icon-1024.png \
            --out "$iconset/icon_"$points"x"$points".png" >/dev/null
        /usr/bin/sips -z "$pixels" "$pixels" /tmp/tonepilot-icon-1024.png \
            --out "$iconset/icon_"$points"x"$points"@2x.png" >/dev/null
    done
    /usr/bin/iconutil -c icns "$iconset" -o "$RESOURCES/TonePilot.icns"
    rm -rf "$(dirname "$iconset")"
fi

/usr/bin/codesign --force --sign - "$APP"
/usr/bin/plutil -lint "$APP/Contents/Info.plist"
echo "Built: $APP"
echo "Development build only: ad-hoc signed, not notarized."
