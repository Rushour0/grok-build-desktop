# Code signing (macOS)

Right now the macOS builds are **unsigned** (ad-hoc only). When you download an
unsigned `.dmg`, macOS quarantines it and — on Apple Silicon especially — refuses
to open it with **"Grok Build Desktop is damaged and can't be opened."** The app
isn't damaged; that's Gatekeeper rejecting an un-notarized, quarantined app.

There are two ways to deal with it: the interim user workaround, and the real fix
(Developer ID + notarization).

## Interim workaround (for the current unsigned builds)

Tell macOS users to strip the quarantine flag after dragging the app to
Applications:

```sh
xattr -cr "/Applications/Grok Build Desktop.app"
```

Then it opens normally. (The old "right-click → Open" trick does **not** clear the
"damaged" error on Apple Silicon — this does.)

## The real fix — sign + notarize (removes the warning for everyone)

This needs the **Apple Developer Program** ($99/yr) — there is no free path that
Gatekeeper trusts. A self-signed certificate does **not** work for distribution.

### 1. Get a Developer ID Application certificate

1. Enroll at <https://developer.apple.com> ($99/yr).
2. In Xcode: **Settings → Accounts → (your account) → Manage Certificates → + →
   Developer ID Application**. (Must be *Developer ID Application* — not "Apple
   Distribution" or "Mac App Store"; those are App-Store-only.)
3. Confirm it's installed:
   ```sh
   security find-identity -v -p codesigning
   # look for: "Developer ID Application: Your Name (TEAMID)"
   ```

### 2. Export it and encode it for CI

1. Open **Keychain Access**, find the cert, right-click → **Export** → save a
   `.p12`, set a password.
2. Base64-encode it as a **single line** (important — no wrapping):
   ```sh
   base64 -i DeveloperID.p12 | tr -d '\n' | pbcopy   # now on your clipboard
   ```

### 3. Create an app-specific password + get your Team ID

- App-specific password: <https://appleid.apple.com> → **Sign-In & Security →
  App-Specific Passwords**.
- Team ID: the `(TEAMID)` in your signing identity, or the Membership page in the
  developer portal.

### 4. Add these six GitHub repo secrets

`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | the base64 `.p12` (single line, from step 2) |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password (step 3) |
| `APPLE_TEAM_ID` | your Team ID |

That's it. `release.yml` already has a **dormant** signing step: it turns on
automatically the moment `APPLE_CERTIFICATE` exists, and stays a no-op (unsigned
build) until then. The next tag you push will produce a **signed + notarized** app
that opens on double-click with no warning and no `xattr`.

## Signing a build locally (optional)

If you'd rather sign a build on your own Mac instead of in CI, after the one-time
setup above (plus `xcrun notarytool store-credentials gbd-notary …`):

```sh
APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
  scripts/sign-macos.sh "src-tauri/target/release/bundle/macos/Grok Build Desktop.app"
```

Verify the result:

```sh
spctl -a -vvv "/Applications/Grok Build Desktop.app"   # should say: accepted, source=Notarized Developer ID
```

## Windows (later)

Windows SmartScreen wants a code-signing cert too. The cheap path is **Azure
Trusted Signing** (~$10/mo, cloud, no hardware token) vs. a traditional OV/EV cert
($200–500/yr). Not wired yet — ask when you want it.
