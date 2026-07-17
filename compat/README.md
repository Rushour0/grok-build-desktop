# compat/

Baseline snapshots of the upstream contracts this app depends on:

| File | Upstream source |
|---|---|
| `npm-latest.json` | `@xai-official/grok` latest version on npm |
| `tool_meta.schema.json` | `CanonicalToolMeta` JSON schema (tool identity / `read_only` envelope) |
| `default_models.json` | Grok Build's default model list |
| `acp-schema-version.txt` | Agent Client Protocol schema version (latest `schema-v1.*` release tag) |

`upstream.lock.json` records each source's URL and the last-seen value the
app was built against.

## How the watcher-bot works

A scheduled GitHub Action (`.github/workflows/track-upstream.yml`) runs
`scripts/track-upstream.sh` daily. The script:

1. Fetches all four sources above.
2. Diffs each against the snapshot committed here.
3. Classifies any change:
   - **security** — `tool_meta.schema.json` changed (tool identity /
     `read_only` contract — review carefully, this touches trust
     boundaries).
   - **protocol** — the ACP schema version changed.
   - **feature** — the npm version or `default_models.json` changed.
4. Writes `reports/latest.md`, a human-readable table of what changed.
5. If (and only if) something actually changed, it commits the new
   snapshots to a `bot/upstream-compat` branch and opens (or updates) a
   single PR labeled `compatibility`, with `reports/latest.md` as the PR
   body.

If nothing changed, the run exits cleanly with no PR.

**This bot never edits `src/` or `src-tauri/`.** It only updates the
snapshots in this directory. A human reviews the PR, decides whether (and
how) the app needs to change to match upstream, and makes that change
separately.

## Running it locally

```sh
DRY_RUN=1 scripts/track-upstream.sh
```

`DRY_RUN=1` fetches and diffs as normal and prints the classified report,
but never commits, pushes, or opens a PR. Scratch files are written to the
repo-local, gitignored `./.compat-work/` directory (never `/tmp`).
