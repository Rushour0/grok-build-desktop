#!/usr/bin/env bash
#
# Sign + notarize + staple a locally-built macOS .app or .dmg with your
# Developer ID, so it opens on download with no "damaged" / Gatekeeper warning.
#
# One-time prerequisites:
#   1. Apple Developer Program membership ($99/yr).
#   2. A "Developer ID Application" certificate installed in your login keychain
#      (Xcode → Settings → Accounts → Manage Certificates → + → Developer ID
#      Application). Confirm with:  security find-identity -v -p codesigning
#   3. Store notarization credentials once (creates a reusable keychain profile):
#        xcrun notarytool store-credentials gbd-notary \
#          --apple-id "you@example.com" \
#          --team-id "YOURTEAMID" \
#          --password "APP_SPECIFIC_PASSWORD"   # from appleid.apple.com
#
# Usage:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
#     scripts/sign-macos.sh "path/to/Grok Build Desktop.app" [more .app/.dmg …]
#
# Env:
#   APPLE_SIGNING_IDENTITY  signing identity (default: "Developer ID Application")
#   NOTARY_PROFILE          notarytool keychain profile name (default: gbd-notary)
#   ENTITLEMENTS            optional path to an entitlements plist
set -euo pipefail

IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application}"
PROFILE="${NOTARY_PROFILE:-gbd-notary}"
ENTITLEMENTS="${ENTITLEMENTS:-}"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <path-to-.app-or-.dmg> [more…]" >&2
  exit 2
fi

for TARGET in "$@"; do
  if [ ! -e "$TARGET" ]; then
    echo "!! not found: $TARGET" >&2
    exit 1
  fi
  case "$TARGET" in
    *.app)
      echo "==> Signing app (hardened runtime): $TARGET"
      codesign --force --deep --options runtime --timestamp \
        ${ENTITLEMENTS:+--entitlements "$ENTITLEMENTS"} \
        --sign "$IDENTITY" "$TARGET"
      codesign --verify --deep --strict --verbose=2 "$TARGET"
      ZIPDIR="$(mktemp -d)"
      ZIP="$ZIPDIR/app.zip"
      ditto -c -k --keepParent "$TARGET" "$ZIP"
      echo "==> Notarizing (a few minutes)…"
      xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait
      xcrun stapler staple "$TARGET"
      rm -rf "$ZIPDIR"
      echo "==> OK: signed, notarized, stapled → $TARGET"
      ;;
    *.dmg)
      echo "==> Signing dmg: $TARGET"
      codesign --force --timestamp --sign "$IDENTITY" "$TARGET"
      echo "==> Notarizing dmg (a few minutes)…"
      xcrun notarytool submit "$TARGET" --keychain-profile "$PROFILE" --wait
      xcrun stapler staple "$TARGET"
      echo "==> OK: signed, notarized, stapled → $TARGET"
      ;;
    *)
      echo "!! skipping (want .app or .dmg): $TARGET" >&2
      ;;
  esac
done

echo "All done. Verify with:  spctl -a -vvv \"<the .app>\""
