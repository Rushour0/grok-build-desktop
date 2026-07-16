# Grok Build Desktop

<img width="1063" height="736" alt="Screenshot 2026-07-16 at 5 49 37 AM" src="https://github.com/user-attachments/assets/0a8efbf6-c3ec-4d4e-9f6c-c89980ab14ae" />


**A GUI for [Grok Build](https://github.com/xai-org/grok-build) — for the rest of us.**

xAI open-sourced Grok Build, their coding agent. It's genuinely good. It's also a
terminal app, which means most people can't use it.

This is a small desktop app that fixes that. Download it, click **Install Grok Build**,
click **Sign in**, pick a folder, and type what you want in plain English. No terminal,
no `npm install`, no API keys to hunt down, no config files.

**[Download the latest release](https://github.com/Rushour0/grok-build-desktop/releases/latest)**
— macOS, Windows, and Linux installers. Builds are **unsigned**, so your OS warns on first
open. On **macOS**, if you see *"Grok Build Desktop is damaged and can't be opened,"* that's
Gatekeeper rejecting an unsigned download — the app is fine. Drag it to Applications, then run:

```sh
xattr -cr "/Applications/Grok Build Desktop.app"
```

and open it. (See [SIGNING.md](SIGNING.md) — signed + notarized builds, which remove this
step entirely, are coming once code-signing certs are in place.)

> **Status: early.** The app installs the CLI, signs you in, opens a folder, and streams
> real answers and live tool activity back. See [Known limits](#known-limits) before you
> point it at anything precious.

## What it does

- **Installs the agent for you.** If `grok` isn't on your machine, one button fetches it
  from xAI's official installer. You never open a terminal.
- **Signs you in.** One "Sign in with Grok" button, browser handles the rest.
- **Works on a folder you pick.** Native folder picker instead of `cd`.
- **Shows the work.** Streamed answers, live tool cards as the agent reads and edits files.

## How it works

Grok Build ships an [Agent Client Protocol](https://agentclientprotocol.com) interface
(`grok agent stdio`) — JSON-RPC 2.0 over stdio. This app is a [Tauri](https://tauri.app)
shell whose Rust host spawns that process and bridges it to a small React UI:

```
webview (React)  --invoke-->  Rust host  --stdin-->   grok agent stdio
webview (React)  <--emit----  Rust host  <--stdout--  grok agent stdio
```

No local web server, no ports, no Electron. The whole bridge is one file:
[`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).

## Run it from source

You need [Rust](https://rustup.rs) and [Node](https://nodejs.org). You do **not** need to
install Grok Build first — the app does that.

```bash
git clone https://github.com/Rushour0/grok-build-desktop
cd grok-build-desktop
npm install
npm run tauri dev
```

## Known limits

**Grok's ACP approval path does not fire.** Verified against grok 0.2.101:
`grok agent stdio` never emits `session/request_permission`, with or without
`[features] support_permission = true`. This was not a configuration mistake.

v0.2.0 adds a real approval gate through Grok's `PreToolUse` hook system. The app
installs a global, default-deny hook that asks you to **Allow** or **Deny** each file
edit or shell command before it runs. Only local read-only tools (reading files,
searching, listing) pass automatically; anything that writes, runs a command, or reaches
the network prompts you first.
It is default-deny on purpose: Grok will try alternate tools when one is blocked (it
will reach for a shell or a background-task tool if a file-edit tool is denied), so an
allowlist of safe tools holds where a denylist of dangerous ones does not.

This is meaningful risk reduction, not a hard security boundary. The hook system fails
open: if the approval process times out or crashes, Grok proceeds. Approval is available
on **macOS and Linux**. Windows approval now exists, but is **experimental and not yet
verified on real Windows** because the maintainer develops on macOS. It fails open like
the other platforms, so if the hook does not fire you simply get the previous no-approval
behavior — it cannot make Windows less safe. Windows users: please report whether the
Allow/Deny prompt appears. **Use this on a folder under version control**, so you can
always `git diff` and undo.

## Roadmap

- [x] Auto-install the Grok Build CLI from inside the app
- [x] Browser sign-in (ACP `authenticate`)
- [x] Folder picker → session → streamed answers + live tool cards
- [x] Recent projects, read from the CLI's own session store
- [x] Installers built by CI for macOS / Windows / Linux
- [x] **Approval before edits** — via a `PreToolUse` hook bridged back to the app
  (default-deny hook; macOS/Linux, experimental on Windows; best-effort, fails open)
- [x] Plan timeline — the agent's plan streams into the transcript as it works
- [ ] Run history, cost display
- [x] Approval on Windows (experimental, unverified)
- [ ] Code-signed builds (no Gatekeeper/SmartScreen warning)
- [ ] Optional `XAI_API_KEY` sign-in for people using API credits

Not yet, on the list:

- [ ] Persistent chat history and search
- [ ] File drop into prompts
- [ ] Tabbed parallel runs
- [ ] System tray

## Credits

This is an independent open-source wrapper. It is not affiliated with or endorsed by xAI.
All the actual intelligence is [xai-org/grok-build](https://github.com/xai-org/grok-build),
used under Apache-2.0. See [NOTICE](NOTICE).

Licensed under [Apache-2.0](LICENSE).
