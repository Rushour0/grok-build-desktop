# Grok Build Desktop

<img width="1063" height="736" alt="Screenshot 2026-07-16 at 5 49 37 AM" src="https://github.com/user-attachments/assets/0a8efbf6-c3ec-4d4e-9f6c-c89980ab14ae" />


**A GUI for [Grok Build](https://github.com/xai-org/grok-build) — for the rest of us.**

xAI open-sourced Grok Build, their coding agent. It's genuinely good. It's also a
terminal app, which means most people can't use it.

This is a small desktop app that fixes that. Download it, click **Install Grok Build**,
click **Sign in**, pick a folder, and type what you want in plain English. No terminal,
no `npm install`, no API keys to hunt down, no config files.

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

**Grok edits files without asking first.** This is the big one, and it's worth being
precise about. `grok agent stdio` executes its tools directly — verified against
grok 0.2.101: prompting it to rewrite a file rewrote the file, with no
`session/request_permission` ever sent and `yolo: false` on the session. So the agent
mode this app drives has no built-in per-edit approval step to hook into.

The real gate is Grok's [hooks](https://github.com/xai-org/grok-build) system: a
`PreToolUse` hook can deny a tool call, and hooks can call an HTTP endpoint. Wiring
that back into this app is the next thing to build. Until then, **use this on a folder
under version control**, so you can always `git diff` and undo.

The client code already handles `session/request_permission` if the agent ever does send
it — that path just doesn't fire today.

## Roadmap

- [x] Auto-install the Grok Build CLI from inside the app
- [x] Browser sign-in (ACP `authenticate`)
- [x] Folder picker → session → streamed answers + live tool cards
- [x] Recent projects, read from the CLI's own session store
- [x] Installers built by CI for macOS / Windows / Linux
- [ ] **Approval before edits** — via a `PreToolUse` hook bridged back to the app
- [ ] Plan timeline, run history, cost display
- [ ] Code-signed builds (no Gatekeeper/SmartScreen warning)
- [ ] Optional `XAI_API_KEY` sign-in for people using API credits

## Credits

This is an independent open-source wrapper. It is not affiliated with or endorsed by xAI.
All the actual intelligence is [xai-org/grok-build](https://github.com/xai-org/grok-build),
used under Apache-2.0. See [NOTICE](NOTICE).

Licensed under [Apache-2.0](LICENSE).
