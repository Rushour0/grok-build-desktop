# Code signing (macOS)

**Status: macOS builds are signed + notarized as of v0.8.2.** They open on a
double-click with no warning and no `xattr`. Windows is still unsigned — see the
bottom of this file.

Releases **before v0.8.2** were unsigned. macOS quarantines an unsigned `.dmg` and
— on Apple Silicon especially — refuses to open it with **"Grok Build Desktop is
damaged and can't be opened."** The app isn't damaged; that's Gatekeeper rejecting
an un-notarized, quarantined app. If you're stuck on one of those old builds, strip
the quarantine flag after dragging to Applications:

```sh
xattr -cr "/Applications/Grok Build Desktop.app"
```

(The "right-click → Open" trick does **not** clear the "damaged" error on Apple
Silicon — this does.) The real fix is just to download v0.8.2 or later.

The rest of this file documents the setup, for reference and for whoever renews the
certificate in 2031.

## How it was set up — Developer ID + notarization

This needs the **Apple Developer Program** ($99/yr) — there is no free path that
Gatekeeper trusts. A self-signed certificate does **not** work for distribution.

### 1. Get a Developer ID Application certificate

Either let Xcode do it (**Settings → Accounts → Manage Certificates → + →
Developer ID Application**), or generate the keypair yourself and upload a CSR to
<https://developer.apple.com/account/resources/certificates>:

```sh
openssl req -new -newkey rsa:2048 -nodes \
  -keyout developer-id.key \
  -out developer-id.certSigningRequest \
  -subj "/emailAddress=you@example.com/CN=Your Name/C=IN"
```

Two traps on the portal:

- The type must be **Developer ID Application** — not "Apple Distribution" or
  "Mac App Store". Despite the name, "Apple Distribution" is App-Store-only and
  Gatekeeper will **not** trust it for a direct `.dmg` download.
- On the intermediary screen, pick **G2 Sub-CA**, not the pre-selected "Previous
  Sub-CA" — certs on the old Sub-CA expire **Feb 01, 2027** regardless of their
  own validity dates.

Download the issued `.cer`, then bundle it with your key:

```sh
openssl x509 -in developerID_application.cer -inform DER -out developer-id.pem
openssl pkcs12 -export -legacy -inkey developer-id.key -in developer-id.pem \
  -out developer-id.p12 -name "Developer ID Application: Your Name (TEAMID)"
security import developer-id.p12 -k ~/Library/Keychains/login.keychain-db \
  -T /usr/bin/codesign
```

Confirm it's installed:

```sh
security find-identity -v -p codesigning
# look for: "Developer ID Application: Your Name (TEAMID)"
```

If that says **`0 valid identities found`**, the Developer ID G2 intermediate is
missing from your keychain and the chain can't reach a trusted root. Fix:

```sh
curl -fsSLO https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
security import DeveloperIDG2CA.cer -k ~/Library/Keychains/login.keychain-db
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
