# Changelog

All notable changes to Grok Build Desktop are documented here. This project follows the
spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions below correspond
to tagged GitHub releases.

v0.9.7 was the final version on the original feature roadmap. v0.9.8 begins a UX-craft
pass: making what already shipped feel intentional, and fixing the transcript.

## [v0.10.3]

### Added

- **Generated files open in a side panel.** When Grok produces an image, PDF, or Word doc,
  it opens in a right-docked panel that slides in beside the conversation — the transcript
  shrinks to make room and stays live, instead of a modal covering everything. Close with
  the × or Esc.

### Changed

- **Message actions are icons.** Copy, Edit, and Rewind are compact icon buttons now, and
  sit on the side their message is on — assistant actions on the left, your actions on the
  right.

### Fixed

- **Generated images now open reliably.** The auto-open fires the moment the image finishes
  generating, instead of at the end of the turn (which could miss it).

## [v0.10.2]

### Fixed

- **Transcript items line up.** Thoughts, tool cards, and the assistant answer were each
  landing at a slightly different left edge; every turn item now shares the one centered
  column.

## [v0.10.1]

A flat, minimal redesign toward a coder-first IDE feel (Codex / Zed / Linear), plus the
controls a daily agent session needs. (First published cut of the redesign; v0.10.0 was
tagged internally but never released.)

### Changed

- **The transcript no longer sprawls.** Conversations now read down one centered column
  instead of a phone-style left/right zig-zag with a hollow middle. Assistant answers are
  borderless prose; your messages are a small neutral chip; the composer shares the same
  lane so the input sits under the conversation.
- **Flat, monochrome look.** Removed the gradients, sheens, and layered shadows in favour of
  flat surfaces with 1px hairline borders (shadows are kept only for menus and modals). One
  restrained blue accent, used only for the primary action, focus ring, links, and
  selection. Monospace for paths, the model name, and token counts. Tighter radii.
- **Merged header.** The project name/status folds into the tab row, so there's one bar
  above the transcript instead of two.
- **Compact composer.** The input and Send button share the primary row; effort and the
  model label sit in a slim strip below it.
- **Calmer sidebar.** Denser rows and a quieter selected state (a subtle tint plus the blue
  rail), and a demoted, non-shouty "New chat" button.

### Added

- **Stop button.** While a turn is running, Send becomes Stop (also `⌘.` / `Ctrl+.`), so a
  long or mistaken turn no longer means closing the conversation to interrupt it.
- **"Jump to latest."** The transcript only auto-follows the live output when you're already
  at the bottom; scroll up to read and a button brings you back.
- **Auto-growing composer.** The input grows from one line up to a cap as you type, instead
  of a fixed single-line strip.
- **Model label.** The composer shows which model the session is running.
- **Generated assets open themselves.** When Grok produces a viewable file — an image, PDF,
  or Word document — it opens automatically in the side viewer the moment the turn finishes,
  instead of leaving you to find and click the path. Opens once per file, only for the tab
  you're looking at. (In-app video isn't supported yet.)

## [v0.9.11]

### Fixed

- **Reasoning-effort dropdown now appears.** It was gated on model capability fields
  the CLI doesn't actually report, so it never showed. It now appears above the composer
  in any live session, with `low` / `medium` / `high` levels.

## [v0.9.10]

### Added

- **In-app image viewer.** Click a `.png`, `.jpg`, `.gif`, `.webp`, `.bmp`, `.avif`, or
  `.ico` file path in a tool card to open it in the viewer, with zoom — alongside PDF
  and DOCX. (Animated GIFs show their first frame; `.svg` isn't supported yet.)
- **Reasoning-effort dropdown.** Switch Grok's thinking effort right above the composer
  instead of digging into Preferences — the biggest token lever, one click away. Appears
  only when the current session supports it.

## [v0.9.9]

### Added

- **In-app PDF & DOCX viewer.** Click a `.pdf` or `.docx` file path in a tool card to
  open it in a viewer — no leaving the app. PDFs render page-by-page with zoom; Word
  documents render as clean, read-only prose. Everything loads on demand, and the file
  read is scoped to the current project folder. (Legacy `.doc` shows an unsupported
  notice — use `.docx`.)

## [v0.9.8]

### Added

- **First-run journey.** The install screen now shows the whole path to a first answer —
  Install → Sign in → Open a project → First prompt — so a brand-new user sees where this
  is going before anything happens.
- **Turn-complete receipt.** A finished turn ends on a quiet "Done · Xs · N tokens" beat
  instead of a flat usage line.
- **Cold-open starters.** The empty composer offers a few starter prompts that fill (never
  send) the draft.
- **A resident cat.** A small cat now paces the header bar where a redundant "Close tab"
  button used to be (every tab already has its own × in the strip).

### Fixed

- **The transcript scrolls.** A long conversation now scrolls instead of squeezing each
  message shorter and shorter.
- **No more hover bounce.** Hovering a message highlights it quietly instead of lifting and
  tilting it.
- **Images render properly** at their natural proportions instead of squashed.
- **"/" and "@" autocomplete** now appears above the composer — the menu was being anchored
  offscreen, so it looked like the feature was missing.

### Changed

- **Overlays feel designed, not dumped.** Preferences, Tasks, Rewind, and the receipt panel
  drop the divider-per-row look for grouped cards and real spacing, gain a blurred backdrop so
  the app no longer bleeds through, and empty states now teach instead of sitting blank. The
  "Signed in" status shows a live indicator.

## [v0.9.7]

### Added

- **Execution receipt.** Export the current conversation as a shareable Markdown document —
  prompts, agent answers, tool calls (with status, read-only flag, and duration), file diffs,
  the run plan, and token usage. A Receipt panel previews the generated Markdown with **Copy**
  (to clipboard) and **Save…** (to a file) actions, reachable from the command palette.

## [v0.9.6]

### Added

- **Tasks panel.** A live dashboard of the agent's spawned subagents and background/scheduled
  tasks, read from `x.ai/session_notification` events.

## [v0.9.5]

### Added

- **Checkpoint/rewind.** Restore an earlier point in a conversation — conversation only, files
  only, or both — from a "Rewind to here" action on your own messages, gated behind a two-step
  confirmation before any file restore.

## [v0.9.4]

### Added

- **Message actions.** Copy any message to the clipboard, and edit-and-resend a prior prompt
  as a new turn.

## [v0.9.3]

### Added

- **Upstream watcher-bot.** A scheduled CI job checks xAI's `grok` package version, the ACP
  schema, and Grok's tool-metadata schema/default models against committed snapshots, and opens
  a classified PR when they drift. It never edits `src/` or `src-tauri/`, and never touches the
  approval allowlist.
- **Tools & Safety panel.** A read-only view in Preferences listing the exact local read-only
  tools the app auto-approves. Transparency only — it does not change what gets approved.

## [v0.9.2]

### Added

- **Preferences (Cmd/Ctrl+,).** Light/Dark/System theme toggle, plus a model and
  reasoning-effort panel.

## [v0.9.1]

### Added

- **Command palette (Cmd/Ctrl+K).** Slash-command palette sourced from
  `available_commands_update`, and @-mention file autocomplete in the composer.

## [v0.9.0]

### Added

- **Expandable tool cards** driven by `x.ai/tool` metadata, with syntax-highlighted code blocks
  and copy support.

[v0.9.7]: https://github.com/Rushour0/grok-build-desktop/releases/tag/v0.9.7
[v0.9.6]: https://github.com/Rushour0/grok-build-desktop/releases/tag/v0.9.6
[v0.9.5]: https://github.com/Rushour0/grok-build-desktop/releases/tag/v0.9.5
[v0.9.4]: https://github.com/Rushour0/grok-build-desktop/releases/tag/v0.9.4
[v0.9.3]: https://github.com/Rushour0/grok-build-desktop/releases/tag/v0.9.3
[v0.9.2]: https://github.com/Rushour0/grok-build-desktop/releases/tag/v0.9.2
[v0.9.1]: https://github.com/Rushour0/grok-build-desktop/releases/tag/v0.9.1
[v0.9.0]: https://github.com/Rushour0/grok-build-desktop/releases/tag/v0.9.0
