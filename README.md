# Grok Build Desktop

**A GUI for [Grok Build](https://github.com/xai-org/grok-build) — for the rest of us.**

xAI open-sourced Grok Build, their coding agent. It's genuinely good. It's also a
terminal app, which means most people can't use it.

This is a small desktop app that fixes that. Download it, click **Install Grok Build**,
click **Sign in**, pick a folder, and type what you want in plain English. No terminal,
no `npm install`, no API keys to hunt down, no config files.

> **Status: early.** The app installs the CLI, signs you in, opens a folder, and streams
> a real answer back. Visual diff approval, run history, and signed installers are next —
> see the roadmap below.

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

## Roadmap

- [x] Auto-install the Grok Build CLI from inside the app
- [x] Browser sign-in (ACP `authenticate`)
- [x] Folder picker → session → streamed answers + live tool cards
- [ ] **Visual diff approval** — Approve/Reject each file edit before it lands
- [ ] Plan timeline, run history, cost display
- [ ] Signed `.dmg` / `.msi` / `.AppImage` on GitHub Releases + auto-update

Right now the app auto-approves tool calls so a turn can complete end-to-end. The diff
approval UI replaces that — it's the next thing to land, and the reason the ACP interface
was chosen over the simpler headless mode.

## Credits

This is an independent open-source wrapper. It is not affiliated with or endorsed by xAI.
All the actual intelligence is [xai-org/grok-build](https://github.com/xai-org/grok-build),
used under Apache-2.0. See [NOTICE](NOTICE).

Licensed under [Apache-2.0](LICENSE).
