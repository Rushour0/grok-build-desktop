#!/usr/bin/env bash
#
# track-upstream.sh — watcher-bot for upstream Grok/ACP drift.
#
# Fetches the four upstream contract sources this app depends on, diffs each
# against the committed compat/ snapshot, classifies any changes, and (when
# real drift is found and DRY_RUN is not set) opens or updates a single PR
# via `gh` so a human can review and update the app.
#
# This script NEVER edits src/ or src-tauri/. It only touches compat/ and a
# repo-local, gitignored scratch dir (./.compat-work/) — never /tmp or
# mktemp, since a sandboxed local run may not have access to /tmp.
#
# Env:
#   DRY_RUN=1   — do everything except `git commit`/`push` and `gh pr`.
#                 Prints the classified diff (or "no upstream drift") and
#                 exits 0. Safe to run locally, offline-tolerant.
#   GH_TOKEN    — passed through to `gh` in CI (see workflow).
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORK_DIR="./.compat-work"
COMPAT_DIR="./compat"
REPORTS_DIR="${COMPAT_DIR}/reports"
REPORT_FILE="${REPORTS_DIR}/latest.md"

DRY_RUN="${DRY_RUN:-}"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"
mkdir -p "$REPORTS_DIR"

NPM_URL="https://registry.npmjs.org/@xai-official%2Fgrok/latest"
SCHEMA_URL="https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-tools/schema/tool_meta.schema.json"
MODELS_URL="https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-models/default_models.json"
ACP_URL="https://api.github.com/repos/agentclientprotocol/agent-client-protocol/releases?per_page=30"

# ---------------------------------------------------------------------------
# Fetch helpers — tolerant of failure. On any error, write "unavailable" as
# the fetched value rather than crashing the whole run (upstream hosts can
# be flaky; a transient failure should not block the schedule).
# ---------------------------------------------------------------------------

fetch() {
  # fetch <url> <dest-file>
  # Returns 0 always; writes an empty file on failure.
  local url="$1"
  local dest="$2"
  if curl -fsSL --max-time 20 "$url" -o "$dest" 2>/dev/null; then
    return 0
  fi
  : > "$dest"
  return 0
}

# npm latest version
fetch "$NPM_URL" "${WORK_DIR}/npm-latest.json"
if [[ -s "${WORK_DIR}/npm-latest.json" ]]; then
  NEW_NPM_VERSION="$(jq -r '.version // empty' "${WORK_DIR}/npm-latest.json" 2>/dev/null || true)"
else
  NEW_NPM_VERSION=""
fi
[[ -z "$NEW_NPM_VERSION" ]] && NEW_NPM_VERSION="unavailable"

# tool_meta.schema.json
fetch "$SCHEMA_URL" "${WORK_DIR}/tool_meta.schema.json"
if [[ ! -s "${WORK_DIR}/tool_meta.schema.json" ]]; then
  SCHEMA_FETCH_OK=0
else
  SCHEMA_FETCH_OK=1
fi

# default_models.json
fetch "$MODELS_URL" "${WORK_DIR}/default_models.json"
if [[ ! -s "${WORK_DIR}/default_models.json" ]]; then
  MODELS_FETCH_OK=0
else
  MODELS_FETCH_OK=1
fi

# ACP schema version — first tag_name matching schema-v1.*
fetch "$ACP_URL" "${WORK_DIR}/acp-releases.json"
if [[ -s "${WORK_DIR}/acp-releases.json" ]]; then
  NEW_ACP_VERSION="$(jq -r '[.[] | .tag_name // empty | select(startswith("schema-v1."))][0] // empty' "${WORK_DIR}/acp-releases.json" 2>/dev/null || true)"
else
  NEW_ACP_VERSION=""
fi
[[ -z "$NEW_ACP_VERSION" ]] && NEW_ACP_VERSION="unavailable"
printf '%s\n' "$NEW_ACP_VERSION" > "${WORK_DIR}/acp-schema-version.txt"

# ---------------------------------------------------------------------------
# Diff against committed snapshots + classify
# ---------------------------------------------------------------------------

OLD_NPM_VERSION="$(jq -r '.version // empty' "${COMPAT_DIR}/npm-latest.json" 2>/dev/null || echo "unknown")"
OLD_ACP_VERSION="$(cat "${COMPAT_DIR}/acp-schema-version.txt" 2>/dev/null || echo "unknown")"

CHANGED=0
declare -a ROWS=()

# feature: npm version
if [[ "$NEW_NPM_VERSION" != "unavailable" && "$NEW_NPM_VERSION" != "$OLD_NPM_VERSION" ]]; then
  CHANGED=1
  ROWS+=("| npm (@xai-official/grok) | ${OLD_NPM_VERSION} | ${NEW_NPM_VERSION} | feature |")
fi

# protocol: acp schema version
if [[ "$NEW_ACP_VERSION" != "unavailable" && "$NEW_ACP_VERSION" != "$OLD_ACP_VERSION" ]]; then
  CHANGED=1
  ROWS+=("| ACP schema version | ${OLD_ACP_VERSION} | ${NEW_ACP_VERSION} | protocol |")
fi

# security: tool_meta.schema.json
if [[ "$SCHEMA_FETCH_OK" -eq 1 ]]; then
  if ! cmp -s "${WORK_DIR}/tool_meta.schema.json" "${COMPAT_DIR}/tool_meta.schema.json" 2>/dev/null; then
    CHANGED=1
    ROWS+=("| tool_meta.schema.json | (committed) | (upstream changed) | security |")
  fi
fi

# feature: default_models.json
if [[ "$MODELS_FETCH_OK" -eq 1 ]]; then
  if ! cmp -s "${WORK_DIR}/default_models.json" "${COMPAT_DIR}/default_models.json" 2>/dev/null; then
    CHANGED=1
    ROWS+=("| default_models.json | (committed) | (upstream changed) | feature |")
  fi
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

{
  echo "# Upstream compatibility report"
  echo
  echo "Generated by \`scripts/track-upstream.sh\` on $(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)."
  echo
  if [[ "$CHANGED" -eq 0 ]]; then
    echo "No upstream drift detected. All tracked sources match the committed \`compat/\` snapshots."
  else
    echo "Upstream drift detected. Review each row below, update the app to match, then merge."
    echo
    echo "| Source | Old | New | Class |"
    echo "|---|---|---|---|"
    for row in "${ROWS[@]}"; do
      echo "$row"
    done
    echo
    echo "Classes: **security** (tool identity/read-only contract changed — review carefully),"
    echo "**protocol** (ACP schema version changed), **feature** (npm release or default models changed)."
  fi
} > "$REPORT_FILE"

if [[ "$CHANGED" -eq 0 ]]; then
  echo "no upstream drift"
  exit 0
fi

echo "upstream drift detected:"
cat "$REPORT_FILE"

if [[ -n "$DRY_RUN" ]]; then
  echo
  echo "DRY_RUN set — skipping git commit/push and gh pr."
  exit 0
fi

# ---------------------------------------------------------------------------
# Copy new snapshots over compat/, commit, push, open/update PR.
# Only copy sources that were successfully fetched (never clobber a good
# committed snapshot with an "unavailable" fetch).
# ---------------------------------------------------------------------------

if [[ "$NEW_NPM_VERSION" != "unavailable" ]]; then
  cp "${WORK_DIR}/npm-latest.json" "${COMPAT_DIR}/npm-latest.json"
fi
if [[ "$NEW_ACP_VERSION" != "unavailable" ]]; then
  cp "${WORK_DIR}/acp-schema-version.txt" "${COMPAT_DIR}/acp-schema-version.txt"
fi
if [[ "$SCHEMA_FETCH_OK" -eq 1 ]]; then
  cp "${WORK_DIR}/tool_meta.schema.json" "${COMPAT_DIR}/tool_meta.schema.json"
fi
if [[ "$MODELS_FETCH_OK" -eq 1 ]]; then
  cp "${WORK_DIR}/default_models.json" "${COMPAT_DIR}/default_models.json"
fi

# Keep upstream.lock.json's last-seen values in sync, if jq + file exist.
if [[ -f "${COMPAT_DIR}/upstream.lock.json" ]]; then
  TMP_LOCK="${WORK_DIR}/upstream.lock.json"
  jq \
    --arg npm "$NEW_NPM_VERSION" \
    --arg acp "$NEW_ACP_VERSION" \
    '(.sources.npm.lastSeen = (if $npm == "unavailable" then .sources.npm.lastSeen else $npm end))
     | (.sources.acp.lastSeen = (if $acp == "unavailable" then .sources.acp.lastSeen else $acp end))' \
    "${COMPAT_DIR}/upstream.lock.json" > "$TMP_LOCK" 2>/dev/null \
    && mv "$TMP_LOCK" "${COMPAT_DIR}/upstream.lock.json" \
    || true
fi

BRANCH="bot/upstream-compat"

git config user.name "upstream-compat-bot" 2>/dev/null || true
git config user.email "upstream-compat-bot@users.noreply.github.com" 2>/dev/null || true

git checkout -B "$BRANCH"
git add compat/
git commit -m "chore(compat): upstream drift detected

$(sed -n '/| Source | Old/,$p' "$REPORT_FILE")"

git push -f origin "$BRANCH"

EXISTING_PR="$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"

if [[ -n "$EXISTING_PR" ]]; then
  gh pr edit "$EXISTING_PR" --body-file "$REPORT_FILE"
  echo "updated PR #${EXISTING_PR}"
else
  gh pr create \
    --title "chore(compat): upstream Grok/ACP drift detected" \
    --body-file "$REPORT_FILE" \
    --label compatibility \
    --head "$BRANCH" \
    --base main
  echo "opened new PR"
fi
