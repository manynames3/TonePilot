#!/bin/zsh
# Builds TonePilot.app.
#
#   ./TonePilot/build.sh                      ad-hoc signed development build
#   TONEPILOT_APP_PATH=/tmp/TonePilot.app ./TonePilot/build.sh
#   TONEPILOT_SIGN_IDENTITY="Developer ID Application: …" ./TonePilot/build.sh
#                                             hardened-runtime build ready for notarize.sh
#   TONEPILOT_BUNDLE_BRIDGE=0 ./TonePilot/build.sh
#                                             skip bundling the Lightroom bridge (falls back to pinned npx)
#
# The app is staged in a temporary folder and only moved into place once every step,
# including the analyzer self-test and signature verification, has succeeded.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="0.5.0"
BUILD_NUMBER="${TONEPILOT_BUILD_NUMBER:-5}"
APP="${TONEPILOT_APP_PATH:-$HOME/Applications/TonePilot.app}"
SIGN_ID="${TONEPILOT_SIGN_IDENTITY:--}"
BUNDLE_BRIDGE="${TONEPILOT_BUNDLE_BRIDGE:-1}"
TARGET="arm64-apple-macos14.0"

STAGE="$(mktemp -d /tmp/TonePilot-build.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
OUT="$STAGE/TonePilot.app"
CONTENTS="$OUT/Contents"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$RESOURCES/TonePilotEngine"

echo "Building TonePilot $VERSION ($BUILD_NUMBER)…"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>TonePilot</string>
    <key>CFBundleDisplayName</key><string>TonePilot</string>
    <key>CFBundleIdentifier</key><string>app.tonepilot.mac</string>
    <key>CFBundleExecutable</key><string>TonePilot</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>$BUILD_NUMBER</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSApplicationCategoryType</key><string>public.app-category.photography</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <key>CFBundleIconFile</key><string>TonePilot</string>
    <key>NSHumanReadableCopyright</key><string>TonePilot developer preview. Not affiliated with Adobe.</string>
</dict>
</plist>
PLIST

# Swift 5 language mode; no SwiftUI macros, so the Command Line Tools are enough.
/usr/bin/swiftc -parse-as-library -swift-version 5 -target "$TARGET" -O \
    -framework SwiftUI -framework AppKit \
    "$ROOT"/Source/Models.swift "$ROOT"/Source/Engine.swift "$ROOT"/Source/AppModel.swift \
    "$ROOT"/Source/Components.swift "$ROOT"/Source/StartViews.swift "$ROOT"/Source/SessionViews.swift \
    "$ROOT"/Source/TonePilotApp.swift "$ROOT"/Source/Snapshot.swift \
    -o "$CONTENTS/MacOS/TonePilot"

/usr/bin/swiftc -swift-version 5 -target "$TARGET" -O -framework Vision -framework CoreGraphics -framework ImageIO \
    "$ROOT/Engine/Analyzer.swift" -o "$CONTENTS/MacOS/TonePilotAnalyzer"
"$CONTENTS/MacOS/TonePilotAnalyzer" --selftest >/dev/null || { echo "Analyzer self-test failed" >&2; exit 1; }

if /usr/bin/swift "$ROOT/Source/IconMaker.swift" >/dev/null; then
    iconset="$STAGE/TonePilot.iconset"; mkdir -p "$iconset"
    for points in 16 32 128 256 512; do
        /usr/bin/sips -z "$points" "$points" /tmp/tonepilot-icon-1024.png --out "$iconset/icon_${points}x${points}.png" >/dev/null
        /usr/bin/sips -z $((points * 2)) $((points * 2)) /tmp/tonepilot-icon-1024.png --out "$iconset/icon_${points}x${points}@2x.png" >/dev/null
    done
    /usr/bin/iconutil -c icns "$iconset" -o "$RESOURCES/TonePilot.icns"
fi

# Every engine module ships; a fixed list once left one out (CI's bundled-engine check caught it).
cp "$ROOT"/Engine/*.mjs "$RESOURCES/TonePilotEngine/"

if [[ "$BUNDLE_BRIDGE" == "1" ]]; then
    # Exact versions and integrity hashes come from the committed lockfile; install
    # scripts never run.
    mkdir -p "$RESOURCES/BridgeServer"
    cp "$ROOT/BridgeServer/package.json" "$ROOT/BridgeServer/package-lock.json" "$RESOURCES/BridgeServer/"
    (cd "$RESOURCES/BridgeServer" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error)
    # TonePilot edition: accept Lightroom's relative white balance (JPEG/HEIC/TIFF).
    node "$ROOT/BridgePatch/patch-bridge.mjs" --apply --server "$RESOURCES/BridgeServer/node_modules/@mskalski/lightroom-mcp/dist" >/dev/null
    if find "$RESOURCES/BridgeServer" -name "*.node" | grep -q .; then echo "Unexpected native module in bridge" >&2; exit 1; fi
fi

if [[ "$SIGN_ID" == "-" ]]; then
    /usr/bin/codesign --force --sign - "$CONTENTS/MacOS/TonePilotAnalyzer"
    /usr/bin/codesign --force --sign - "$OUT"
else
    for bin in "$CONTENTS/MacOS/TonePilotAnalyzer" "$OUT"; do
        /usr/bin/codesign --force --options runtime --timestamp --entitlements "$ROOT/TonePilot.entitlements" --sign "$SIGN_ID" "$bin"
    done
fi
/usr/bin/codesign --verify --strict --verbose=1 "$OUT"
/usr/bin/plutil -lint "$CONTENTS/Info.plist" >/dev/null

mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
mv "$OUT" "$APP"
echo "Built: $APP"
if [[ "$SIGN_ID" == "-" ]]; then echo "Development build: ad-hoc signed, not notarized."; else echo "Signed with $SIGN_ID. Run TonePilot/notarize.sh before distributing."; fi
