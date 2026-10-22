#!/bin/zsh
# Notarizes and staples a Developer ID–signed TonePilot.app. NOT run by the
# development workflow; it needs an Apple Developer account.
#
#   xcrun notarytool store-credentials tonepilot-notary --apple-id … --team-id …
#   TONEPILOT_SIGN_IDENTITY="Developer ID Application: …" TONEPILOT_APP_PATH=dist/TonePilot.app ./TonePilot/build.sh
#   TONEPILOT_NOTARY_PROFILE=tonepilot-notary ./TonePilot/notarize.sh dist/TonePilot.app
set -euo pipefail
APP="${1:?Usage: notarize.sh /path/to/TonePilot.app}"
PROFILE="${TONEPILOT_NOTARY_PROFILE:?Set TONEPILOT_NOTARY_PROFILE to a notarytool keychain profile}"

/usr/bin/codesign --verify --strict --deep "$APP"
if /usr/bin/codesign -dv "$APP" 2>&1 | grep -q "Signature=adhoc"; then
    echo "Refusing to notarize an ad-hoc signed build. Build with TONEPILOT_SIGN_IDENTITY first." >&2; exit 1
fi
ZIP="$(mktemp -d)/TonePilot.zip"
/usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
/usr/bin/xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
/usr/bin/xcrun stapler staple "$APP"
/usr/sbin/spctl --assess --type execute --verbose "$APP"
echo "Notarized and stapled: $APP"
