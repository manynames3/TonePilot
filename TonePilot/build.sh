#!/bin/zsh
# Builds TonePilot.app.
#
#   ./TonePilot/build.sh                      ad-hoc signed development build
#   TONEPILOT_APP_PATH=/tmp/TonePilot.app ./TonePilot/build.sh
#   TONEPILOT_SIGN_IDENTITY="Developer ID Application: …" ./TonePilot/build.sh
#                                             hardened-runtime build ready for notarize.sh
#   TONEPILOT_BUNDLE_BRIDGE=0 ./TonePilot/build.sh
#                                             skip bundling the Lightroom bridge (falls back to pinned npx)
#   TONEPILOT_BUNDLE_NODE=0 ./TonePilot/build.sh
#                                             skip bundling Node.js (the app then needs a system Node 18+)
#
# The app is staged in a temporary folder and only moved into place once every step,
# including the analyzer self-test and signature verification, has succeeded.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
VERSION="0.6.1"
BUILD_NUMBER="${TONEPILOT_BUILD_NUMBER:-5}"
APP="${TONEPILOT_APP_PATH:-$HOME/Applications/TonePilot.app}"
SIGN_ID="${TONEPILOT_SIGN_IDENTITY:-}"
if [[ -z "$SIGN_ID" ]]; then
    # A stable local identity (a free Apple Development certificate, or a self-signed one named
    # "TonePilot Local") keeps macOS permission grants across rebuilds; an ad-hoc signature
    # changes with every build, so macOS asks again. Picked by hash: no name lands in the repo.
    SIGN_ID="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null \
        | /usr/bin/grep -E '"(TonePilot Local|Apple Development: [^"]*)"' | /usr/bin/head -1 | /usr/bin/awk '{print $2}' || true)"
    SIGN_ID="${SIGN_ID:--}"
fi
# Only Developer ID builds are distributed, so only they need a secure timestamp.
TIMESTAMP="--timestamp=none"
[[ "${TONEPILOT_SIGN_IDENTITY:-}" == Developer\ ID* ]] && TIMESTAMP="--timestamp"
BUNDLE_BRIDGE="${TONEPILOT_BUNDLE_BRIDGE:-1}"
TARGET="arm64-apple-macos14.0"
BUNDLE_NODE="${TONEPILOT_BUNDLE_NODE:-1}"
# Official Node.js LTS build; the checksum is from nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt.
NODE_VERSION="v22.23.4"
NODE_TARBALL="node-$NODE_VERSION-darwin-arm64.tar.xz"
NODE_SHA256="037650d0839f457747396f052073fb48333d31bf5abd3c98b74da20d89ebb1ad"
CACHE="$ROOT/.build"

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
    -framework SwiftUI -framework AppKit -framework Security \
    "$ROOT"/Source/Models.swift "$ROOT"/Source/Engine.swift "$ROOT"/Source/AIService.swift "$ROOT"/Source/AppModel.swift \
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
# The Claude SDKs (Amazon Bedrock / Anthropic API providers), exactly as locked; install
# scripts never run, and pure JavaScript only.
cp "$ROOT/Engine/package.json" "$ROOT/Engine/package-lock.json" "$RESOURCES/TonePilotEngine/"
(cd "$RESOURCES/TonePilotEngine" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error) \
    || { echo "Installing the engine's pinned dependencies failed" >&2; exit 1; }
if find "$RESOURCES/TonePilotEngine" -name "*.node" | grep -q .; then echo "Unexpected native module in the engine" >&2; exit 1; fi
# TonePilot's own Lightroom plug-in, for the app to install later. Nothing is installed here.
cp -R "$ROOT/LightroomPlugin/TonePilot.lrplugin" "$RESOURCES/"

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

if [[ "$BUNDLE_NODE" == "1" ]]; then
    # Only bin/node ships. The tarball is cached and verified against the pinned checksum on every build.
    mkdir -p "$CACHE" "$CONTENTS/Helpers"
    if [[ ! -f "$CACHE/$NODE_TARBALL" ]]; then
        /usr/bin/curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NODE_TARBALL" -o "$STAGE/$NODE_TARBALL"
        mv "$STAGE/$NODE_TARBALL" "$CACHE/$NODE_TARBALL"
    fi
    if [[ "$(/usr/bin/shasum -a 256 "$CACHE/$NODE_TARBALL" | cut -d' ' -f1)" != "$NODE_SHA256" ]]; then
        rm -f "$CACHE/$NODE_TARBALL"; echo "Node.js checksum mismatch; deleted the cached download" >&2; exit 1
    fi
    /usr/bin/tar -xJf "$CACHE/$NODE_TARBALL" -C "$CONTENTS/Helpers" --strip-components 2 "node-$NODE_VERSION-darwin-arm64/bin/node"
    [[ "$("$CONTENTS/Helpers/node" --version)" == "$NODE_VERSION" ]] || { echo "Bundled Node.js failed to run" >&2; exit 1; }
fi

if [[ "$SIGN_ID" == "-" ]]; then
    [[ -f "$CONTENTS/Helpers/node" ]] && /usr/bin/codesign --force --sign - "$CONTENTS/Helpers/node"
    /usr/bin/codesign --force --sign - "$CONTENTS/MacOS/TonePilotAnalyzer"
    /usr/bin/codesign --force --sign - "$OUT"
else
    # V8 needs JIT under the hardened runtime; only the Node binary gets that entitlement.
    [[ -f "$CONTENTS/Helpers/node" ]] && /usr/bin/codesign --force --options runtime $TIMESTAMP \
        --entitlements "$ROOT/Node.entitlements" --sign "$SIGN_ID" "$CONTENTS/Helpers/node"
    for bin in "$CONTENTS/MacOS/TonePilotAnalyzer" "$OUT"; do
        /usr/bin/codesign --force --options runtime $TIMESTAMP --entitlements "$ROOT/TonePilot.entitlements" --sign "$SIGN_ID" "$bin"
    done
fi
/usr/bin/codesign --verify --strict --verbose=1 "$OUT"
/usr/bin/plutil -lint "$CONTENTS/Info.plist" >/dev/null

mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
mv "$OUT" "$APP"
echo "Built: $APP"
if [[ "$SIGN_ID" == "-" ]]; then echo "Development build: ad-hoc signed (macOS will ask for permissions again after each build), not notarized."
elif [[ "$TIMESTAMP" == "--timestamp" ]]; then echo "Signed with $SIGN_ID. Run TonePilot/notarize.sh before distributing."
else echo "Signed with a stable local identity: macOS keeps your permission choices across builds. Not notarized; for this Mac only."; fi
