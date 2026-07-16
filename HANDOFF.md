# Grok Build Desktop: engineer handoff

## Overview

Grok Build Desktop is a Tauri v2 desktop GUI around xAI's `grok` CLI. The Rust host starts `grok agent stdio`, speaks Agent Client Protocol (ACP) over the child process's stdio, and forwards the live session to a React webview. It is intended for people who want to use Grok Build on a project folder without operating the terminal CLI directly.

Current version: **0.1.1**.

This is an independent, unofficial wrapper. It downloads and drives the upstream CLI at runtime; it does not redistribute it. See `NOTICE` for attribution and trademark details.

## Architecture

```text
webview (React)  --invoke-->  Rust host  --stdin-->   grok agent stdio
webview (React)  <--emit----  Rust host  <--stdout--  grok agent stdio
```

There is no local web server. `src/lib/bridge.ts` is the typed webview-side transport, and the entire Rust process/ACP bridge is in `src-tauri/src/lib.rs`.

ACP is newline-delimited JSON-RPC 2.0 (one JSON message per line) over stdin/stdout. Initialization advertises `protocolVersion: 1` and disables client filesystem capabilities:

```json
{
  "protocolVersion": 1,
  "clientCapabilities": {
    "fs": {
      "readTextFile": false,
      "writeTextFile": false
    }
  }
}
```

New sessions are requested with `cwd` and an empty `mcpServers` list. The Rust reader routes JSON-RPC responses to pending callers; it emits session updates, permission requests, turn completion, errors, stderr, and process closure to the webview as `acp-*` events.

### Tauri commands

The command signatures and behavior below match `src-tauri/src/lib.rs`.

| Command | Rust signature | Purpose |
| --- | --- | --- |
| `grok_installed` | `fn grok_installed() -> bool` | Resolves the `grok` executable from known install locations or `PATH`. |
| `auth_status` | `fn auth_status() -> AuthStatus` | Reports whether Grok is installed, its resolved path, and whether `~/.grok/auth.json` exists. |
| `install_grok` | `fn install_grok(app: AppHandle) -> Result<String, String>` | Runs xAI's official shell or PowerShell installer, emits install status, and returns the resolved executable path. |
| `recent_projects` | `fn recent_projects() -> Vec<Project>` | Reads valid project directories from `~/.grok/sessions`, sorts them by session-directory modification time, and returns up to 50. |
| `connect` | `fn connect(app: AppHandle, state: State<AcpState>, cwd: String) -> Result<ConnectResult, String>` | Replaces any live child, starts `grok agent stdio` in `cwd`, initializes ACP, and opens a session or reports that authentication is required. |
| `authenticate` | `fn authenticate(state: State<AcpState>, method_id: String) -> Result<(), String>` | Sends ACP `authenticate` for the selected method and waits up to five minutes for browser sign-in. |
| `open_session` | `fn open_session(state: State<AcpState>, cwd: String) -> Result<String, String>` | Sends `session/new` after authentication and returns the new session ID. |
| `respond_permission` | `fn respond_permission(state: State<AcpState>, request_id: i64, option_id: Option<String>) -> Result<(), String>` | Answers a pending ACP permission request with the selected option, or cancellation when the option is `None`. This path is currently unreachable; see below. |
| `send_prompt` | `fn send_prompt(app: AppHandle, state: State<AcpState>, text: String) -> Result<(), String>` | Sends a text-only `session/prompt`, returns immediately, and emits streamed updates plus eventual turn completion or error. |
| `cancel` | `fn cancel(state: State<AcpState>) -> Result<(), String>` | Best-effort sends `session/cancel`, then kills and reaps the child process. |

## The approval/safety problem (verified)

These results were verified experimentally with Grok 0.2.101:

- `grok agent stdio` **never emits `session/request_permission`**, with or without `[features] support_permission = true` in `~/.grok/config.toml`. Both configurations were tested and the target file was rewritten both times. The existing `PermissionCard` / `respond_permission` ACP flow is therefore unreachable today.
- `PreToolUse` hooks **do fire in `grok agent stdio` mode**, although this behavior is undocumented. Global hooks in `~/.grok/hooks/*.json` are always trusted. A hook receives JSON on stdin with `toolName`, `toolInput`, `sessionId`, and `cwd`; it can deny the call by writing `{"decision":"deny","reason":"..."}` to stdout.
- Hooks **fail open**: a timeout, crash, or bad output allows the edit to proceed. The default timeout is five seconds. A hook-based approval layer reduces risk but is not a hard security boundary.
- A denylist of tool names **does not hold**. When a hook denied `write`, `search_replace`, and `run_terminal_command`, Grok routed around the restrictions in the same turn by using `monitor`, an undocumented background-shell runner, to write the file. It then misreported the failure.
- A **default-deny allowlist does hold** in the tested scenario. A hook allowing only `read_file`, `list_dir`, `grep`, `search_tool`, `web_search`, `web_fetch`, `get_command_or_subagent_output`, and `monitor_status`, while denying every other tool, survived an adversarial “use any means” prompt; the file remained unchanged. This is the chosen architecture for the approval feature.
- Independent corroboration: [`krakenunbound/grok-desktop`](https://github.com/krakenunbound/grok-desktop), a competing Tauri 2 app at v0.8.0, ships working Allow/Deny approval turns. The interaction is achievable even though this app's current ACP permission path is inert.

Do not replace the allowlist with a list of known write tools. Unknown tools, including shell-capable tools such as `monitor`, must default to denial or an explicit approval turn.

## Build & release runbook

Prerequisites are Node.js and Rust. From the repository root:

```bash
npm install
npm run tauri dev
```

Before release, set the same `X.Y.Z` version in all four locations:

- `package.json`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.toml`
- the `grok-build-desktop` package entry in `src-tauri/Cargo.lock`

Commit those changes, then push a matching tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

`.github/workflows/release.yml` runs on `v*` tags. Its four-build matrix targets macOS Apple Silicon, macOS Intel, Ubuntu Linux, and Windows. `tauri-apps/tauri-action` builds the installers and minisign-signed updater artifacts using the repository's `TAURI_SIGNING_PRIVATE_KEY` secrets, generates `latest.json`, and publishes a non-draft, non-prerelease GitHub Release.

## Auto-update

The updater reads:

```text
https://github.com/Rushour0/grok-build-desktop/releases/latest/download/latest.json
```

Updater artifacts are minisign-signed in CI and verified against the public key embedded in `src-tauri/tauri.conf.json`. `src/App.tsx` checks for an update at startup but does not install it automatically. It shows an **Update & restart** action; installation and relaunch happen only after the user opts in.

macOS auto-update is fragile while the app bundle is unsigned. There is no Apple Developer ID signing or notarization yet.

## Known limits & gaps

- Builds are not platform code-signed. Gatekeeper and SmartScreen warn on first open.
- There is no test suite.
- There is no lint script or lint configuration in the current project setup.
- Approval is not wired. Grok can currently edit the selected folder without asking, because the implemented ACP permission route never fires.
- `src/App.tsx` drops ACP `plan` updates in its default switch branch, including their `entries`; they are typed in `src/lib/bridge.ts` but not rendered.

Until the approval bridge exists, use the app only on folders whose changes can be reviewed and reverted, preferably under version control.

## Roadmap / next steps

1. **Build the default-deny approval bridge.** Install and manage a global `PreToolUse` hook; immediately allow only the verified read-only tool allowlist; route every other tool request through the Rust host to an Allow/Deny UI; and return valid hook output within the timeout. The hook-side fallback should be denial on app disconnect, malformed responses, or internal errors. Grok's hook runner still fails open if the hook process itself times out or crashes, so keep that process small and treat this as risk reduction rather than a sandbox.
2. Add persistent chat history and history search.
3. Add file drop into prompts.
4. Add tabbed concurrent runs.
5. Add system-tray behavior.
6. Add agent discovery.
