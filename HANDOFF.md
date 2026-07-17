# Grok Build Desktop: engineer handoff

A Tauri 2 desktop GUI around xAI's `grok` CLI. The Rust host spawns `grok agent stdio`, speaks
Agent Client Protocol (ACP) over the child's stdio, and forwards the live session to a React
webview. Independent and unofficial: it drives the upstream CLI at runtime and does not
redistribute it. See `NOTICE`.

Current version: **0.9.6**.

```text
webview (React)  --invoke-->  Rust host  --stdin-->   grok agent stdio
webview (React)  <--emit----  Rust host  <--stdout--  grok agent stdio
```

No local web server. `src/lib/bridge.ts` is the typed webview transport; the whole Rust/ACP
bridge is `src-tauri/src/lib.rs`. ACP is newline-delimited JSON-RPC 2.0.

---

## The three things that will bite you

Read this section before changing anything. Each one is a real failure this codebase already
had, and each is invisible until it isn't.

### 1. A denylist does not hold. The allowlist is the architecture.

Verified experimentally against grok 0.2.101, and still the reason `READONLY_TOOLS` is shaped
as it is:

- A hook denying `write`, `search_replace`, and `run_terminal_command` **failed**. Grok routed
  around it *in the same turn* using `monitor`, an undocumented background-shell runner, wrote
  the file anyway, and then misreported the failure.
- A **default-deny allowlist held** against an adversarial "use any means necessary" prompt.
  The file was unchanged.
- Hooks **fail open**: grok's runner allows the call if the hook times out or crashes. The
  hook's own ~500s deadline self-denies, but a crashed hook process does not. This is risk
  reduction, not a sandbox.

**Never replace the allowlist with a list of known write tools.** Unknown tools — including
shell-capable ones like `monitor` — must default to denial.

Two invariants are pinned by tests, because nothing else checks them:
`READONLY_TOOLS` vs the hook script's `case` arm, and `WINDOW_LABEL_PREFIX` vs the `w*` glob in
`capabilities/default.json` (a drift there costs the window every permission, **silently**, in
release builds only).

### 2. Sync `#[tauri::command]` runs on the main thread.

This froze the whole app for up to five minutes during sign-in, because `authenticate` did
`rx.recv_timeout(5 * 60)` on it. Fixed in v0.8.4, and the doctrine binds:

- Blocking body, caller needs the value → `#[tauri::command] async fn` + `spawn_blocking`,
  re-acquiring `app.state::<AcpState>()` **inside** the closure. Never capture `State` across it.
- **Bare `#[tauri::command(async)]` on a sync body is banned** — it parks a tokio worker.
- `authenticate` alone is fire-and-forget on a thread (`send_prompt` is the template).

### 3. Failures here are silent, so the empty case is never the honest answer.

The recurring bug in this codebase is *returning nothing* where the truth is *something broke*.
Real instances:

- `percent_decode` panicked on a `%` cutting a multi-byte char → `JoinError` →
  `unwrap_or_default()` → **empty sidebar**, no error.
- A failed history search rendered as **"No matches"** — a flat lie about conversations on disk.
- `search_sessions` returns `{hits, content_error}`, not a bare `Vec`, precisely so "content
  search couldn't run" cannot collapse into "no results".

If you add a fallible read, decide what the user sees when it fails. "Nothing" is a lie.

---

## Architecture notes

### Identity: one project per window

`AcpState` is keyed by `SessionKey { window, tab }`. The `window` half is Tauri's
`WebviewWindow::label()`, injected from the IPC message — **the webview cannot forge it**, and
that property is the whole safety argument. Don't accept a window label as a command parameter.

Why it matters: every webview's JS `nextTabId` starts at 1. Keyed by `tab_id` alone, window B's
`connect("tab-1")` would find window A's session and the non-destructive insert would kill it —
opening a second project would silently end the conversation you were having.

`SessionKey` is also the emit route (`emit_to(&key.window, ...)`). One struct, one owner.
`acp-install` stays **broadcast** — installing the CLI is machine-wide.

### Approval ownership

`respond_hook` once did `let _ = tab_id;` — it discarded its only identity and wrote any
decision it was handed. Sessions now hold the set of requests they actually surfaced, and the
check **consumes** it. Lock order is **AcpState → emitted, everywhere**: clone the Arc out under
the AcpState guard, drop the guard, then touch it. `Session::kill` blocks on `child.wait()`, so
no helper may hold the map guard across it.

### Conversations

Grok advertises `agentCapabilities.loadSession: true`. `session/load` replays the conversation
as ordinary `session/update` notifications — the same kinds `reduceUpdates` already renders, so
there is no second render path. The `live/<sessionId>` marker means the approval watcher **must
be re-armed** after a load, or the resumed conversation runs with no gate.

### Search

Grok maintains its own FTS5 index at `~/.grok/sessions/session_search.sqlite`, live via
triggers. We query it read-only (WAL; concurrent reads are safe). **Title matching never goes
through it** — indexing is lazy and races, so ~4% of sessions are unindexed at any moment, and
title search must cover 100%.

`session_docs.cwd` is **not** canonicalized, and the exact string compare is correct.
`/private/tmp` and `/tmp` are *two distinct projects* with their own session folders.
Canonicalizing would merge them; a test fails if you try.

---

## Release runbook

Set the same `X.Y.Z` in **four** places — `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and the `grok-build-desktop` entry in `src-tauri/Cargo.lock`
(`cargo update -p grok-build-desktop --offline`). CI's `validate-version` job enforces it.

```bash
git tag -a vX.Y.Z -m "..."
git push origin refs/tags/vX.Y.Z   # the full ref: branch and tag share a name
```

macOS builds are **signed and notarized**. `release.yml` notarizes and staples the **`.dmg`
separately** — tauri notarizes the `.app` and only *signs* the `.dmg` around it, and the `.dmg`
is what users double-click. Do not delete that step; see `SIGNING.md` for why it looks redundant
and isn't.

Verify the artifact, not the checkmark:

```sh
spctl -a -vvv -t open --context context:primary-signature <dmg>   # accepted / Notarized Developer ID
xcrun stapler validate <dmg>                                       # works offline
```

Windows is **not** signed; SmartScreen still warns.

---

## Testing

382 tests: **158 Rust** (`cd src-tauri && cargo test`) + **224 frontend** (`npm run test`,
Vitest). CI runs `cargo check --all-targets`, `cargo test`, and the frontend suite.

No test touches the real `~/.grok`: `list_sessions_at` / `search_sessions_at` take a root
parameter and fixtures build a temp store with a real FTS5 index.

Two rules the suite is built on:

- **Never encode a bug as expected.** Several known-real bugs are deliberately *untested* and
  documented instead. A test that locks in a bug is worse than no test.
- **Assert on real tags, not substrings.** `<img src=x onerror=alert(1)>` renders as
  `<p>&lt;img src=x onerror=alert(1)&gt;</p>` — the substring `onerror=` is present and
  completely inert. A substring assertion fails on *safe* output and pushes the next person to
  "fix" correct code.

---

## Known bugs — real, verified, unfixed

All four share one root: **`appendText` searches only the last item while `reduceUpdates`
searches by id.** Two code paths, one job, different semantics. Extracting one pure helper over
`(items, id, kind, chunk)` kills the class and makes both testable.

| Bug | Status |
|---|---|
| `appendText` can push a second item with the same id → duplicate React key | Real; needs answer→thought→answer with no `tool_call` between (which resets). Unobserved in captures. |
| `reduceUpdates` never accumulates `user_message_chunk` (agent chunks do) | Real; captured replays show user messages arriving whole. Latent. |
| `toMention(cwd, cwd)` returns a bare `@` | Verified. |
| `toMention` never relativizes on Windows — guard hardcoded to `/`, though `folderName` handles `\` | Verified. v0.8.0 shipped Windows approval. |

Also deferred: `authenticate`'s pending-entry leak on the timeout arm (commented in-file); the
tray's zero-window arm is unreachable (Tauri exits with the last window; making it live needs
`prevent_exit`, a behaviour change); `.side-row.open` has no CSS; dead CSS remains from the
deleted transcript mode (`.content-header`, `.content-actions`, `.history-state`,
`.transcript-close`).

## Known limits

- **CLI args don't reach a Finder-launched `.app`** — macOS gives it no argv. They arrive via
  `./binary <path>` or `open -a "…" --args <path>`. A PATH shim (VS Code's `code`) is the fix.
- **A second invocation starts a second process**, rather than opening a window in the running one.
- Windows/Linux CSP behaviour is unverified (only macOS was exercised).
- Cold sign-in and the install flow have never been driven end to end — they need a signed-out
  account and an uninstalled CLI.
- `recent_projects` no longer freezes the app on a stale network mount, but the list itself can
  hang.
- Multi-word search is a literal **phrase**: "approval hook" won't match "hook for approval".

## Roadmap

0. **Shipped in v0.9.0:** expandable tool cards driven by `x.ai/tool` metadata (source,
   semantic kind, read-only flag, canonical input, locations) replacing the flat tool pill,
   plus syntax-highlighted code blocks (highlight.js, class-based, CSP-safe) with a copy
   button in the transcript's Markdown rendering.
0a. **Shipped in v0.9.1:** command palette (Cmd/Ctrl+K), slash-command palette from
   `available_commands_update`, and @-mention file autocomplete. Invocation is unchanged — the
   composer draft is still sent verbatim via `sendPrompt`; picking a slash command or file just
   inserts text into the draft.
0b. **Shipped in v0.9.2:** Preferences overlay (Cmd/Ctrl+,), Light/Dark/System theme toggle, and
   a model + reasoning-effort panel.
0c. **Shipped in v0.9.3 ("Never drift again"):** an upstream watcher-bot
   (`scripts/track-upstream.sh` + `.github/workflows/track-upstream.yml`, scheduled daily) that
   diffs the `grok` npm version, the ACP schema version, and Grok's tool-metadata schema/default
   models against committed `compat/` snapshots and opens one classified PR (`security` /
   `protocol` / `feature`) on drift — purely additive infra, never touches `src/` or `src-tauri/`.
   Plus a read-only "Tools & Safety" section in Preferences (`readonly_tools` Tauri command,
   `Preferences.tsx`) that displays the app's auto-approved read-only tool allowlist.
   **The security-critical approval allowlist itself (`READONLY_TOOLS`, the hook scripts,
   `build_permission_payload`, `respond_hook`) was NOT changed.** The app never auto-approves
   based on anything Grok reports about its own tools (`x.ai/tool`, `read_only`, or otherwise) —
   that metadata is display-only. Upstream drift is surfaced for a human to review, not consumed
   to change what gets approved.
0d. **Shipped in v0.9.4 ("Experiment without fear" — safe slice):** message actions — a Copy
   button on transcript bubbles (both agent answers and user messages) that copies the raw text
   via the clipboard, and an Edit action on user ("you") messages that loads that message's text
   back into the composer draft and focuses it so it can be tweaked and sent as a **new** turn.
   This is purely additive to the composer draft: it does not delete, rewrite, or truncate any
   transcript history.
0e. **Shipped in v0.9.5 ("checkpoint/rewind"):** a "Rewind to here" action on user ("you")
   message bubbles opens a Rewind panel listing checkpoints from Grok's `x.ai/rewind/points`
   ACP extension method (roughly one per prompt), with a scope selector (conversation only /
   files only / both) and restore via `x.ai/rewind/execute`. **The wire shape of both methods
   is unverified headlessly**, so the Rust commands return raw `serde_json::Value` and the TS
   side (`src/lib/rewind.ts`) normalizes defensively — it accepts a bare array or a
   `{points: [...]}` envelope and tolerates missing/extra fields on each point. Any restore
   whose scope includes files overwrites on-disk work and cannot be undone, so that path is
   **double-confirmed**: a first screen states exactly what will be lost, and only a second,
   visually distinct, non-default-focused "Yes, rewind" button actually calls
   `x.ai/rewind/execute`. Conversation-only restores are non-destructive and confirm in one
   step. `window.confirm`/`window.alert`/the dialog plugin do not work in this app (wry's
   macOS `WKUIDelegate` doesn't implement `runJavaScriptConfirmPanel`), so the two-step gate is
   in-app React UI only, following the same pattern as the `UpdateBanner` two-step update gate.
   After a successful execute, the transcript is rebuilt via the existing reload/replay flow
   (re-arm `sessionReplays`, `loadSession`, `reduceUpdates`) rather than hand-patched in place.
0f. **Shipped in v0.9.6 ("subagent/task dashboard"):** a Tasks panel showing the agent's
   spawned subagents and background/scheduled tasks live, sourced from `x.ai/session_notification`
   ACP notifications — previously silently dropped by `spawn_reader`'s wildcard match arm, now
   forwarded as an additive `acp-notify` emit mirroring the existing `acp-update` emit. The
   notification's tagged variant is unverified headlessly, so parsing (`src/lib/notify.ts`) is
   defensive: it reads a tag from `sessionUpdate`/`type`/`kind`, tolerates unknown/irrelevant
   variants without throwing, and only turns subagent/task-ish variants into dashboard rows.
   Display-only, read-only — no actions that mutate anything. **Full MCP server management
   (viewing/adding/removing MCP servers from the app) is intentionally deferred**, not shipped
   here: it would mean the app writes to Grok's own config file and handles secrets, which is a
   materially different trust boundary than the read-only surfaces shipped so far.
1. The one refactor above (kills four bugs).
2. ~~Surface grok's own capabilities — it advertises `available_commands`~~ — the slash-command
   piece is done (see 0a). Remaining: exposing `/compact`, `/context`, `/session-info`, and
   `/always-approve` as first-class UI affordances beyond the raw slash-command autocomplete.
   Note `/always-approve` toggles **grok's** prompts, not this app's hook — they are two
   different switches and conflating them would be a safety bug.
3. Reasoning-effort picker: `supportsReasoningEffort` with `[high, medium, low]`, persisted per
   session as `reasoning_effort` (default `high` — the biggest token lever there is). A *model*
   picker is pointless: `availableModels` has exactly one entry.
4. PATH shim + single-instance.
5. Windows code signing.

Verify before building any of these. `promptCapabilities.image` is `false` and
`agentCapabilities.auth` is `{}` — there is no auth callback to register, however much it looks
like there should be.
