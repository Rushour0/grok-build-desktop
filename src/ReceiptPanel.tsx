/// Read-only "Receipt" overlay: renders the current conversation as a shareable
/// Markdown execution receipt — prompts, agent answers, tool calls, diffs, plan,
/// and token usage — via the pure `itemsToMarkdown` helper. Cloned from
/// `TasksPanel.tsx`'s overlay shell (fixed scrim + centered panel, ESC + backdrop
/// -click close) so it matches the app's existing overlay idiom exactly rather
/// than inventing a new one.
///
/// This component is purely presentational plus two side effects the user
/// explicitly asks for: copying the rendered Markdown to the clipboard, and
/// saving it to a file the user picks via the native save dialog. It never
/// mutates `items`/`sessionInfo` — those are owned by the parent (App.tsx).
import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { Item } from "./App";
import type { SessionModelInfo } from "./lib/bridge";
import { saveText } from "./lib/bridge";
import { itemsToMarkdown, receiptFilename } from "./lib/receipt";

export interface ReceiptPanelProps {
  open: boolean;
  onClose: () => void;
  items: Item[];
  sessionInfo?: SessionModelInfo;
  title?: string;
  cwd?: string | null;
}

/// Transient status line shown after Copy/Save — cleared automatically after a
/// couple seconds so the button doesn't get stuck saying "Copied"/"Saved"
/// forever, and so a later error doesn't linger once the user moves on.
const STATUS_TIMEOUT_MS = 2000;

/// Floating receipt overlay: fixed scrim + centered panel, matching
/// `TasksPanel.tsx`/`Preferences.tsx` (ESC + backdrop-click close). Controlled
/// by `open`/`onClose` only — renders null when closed so it never eats focus
/// or keyboard events while hidden.
export function ReceiptPanel({
  open,
  onClose,
  items,
  sessionInfo,
  title,
  cwd,
}: ReceiptPanelProps): React.ReactElement | null {
  // ESC closes, same as Preferences / Tasks / the command palette. Only
  // listen while open so this never intercepts ESC elsewhere in the app.
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const [status, setStatus] = useState<string | null>(null);

  // Clear any transient status line whenever the panel closes/reopens, so a
  // stale "Copied"/"Saved"/error from a previous open doesn't flash back in.
  useEffect(() => {
    if (!open) setStatus(null);
  }, [open]);

  // Auto-clear the transient status after a couple seconds.
  useEffect(() => {
    if (!status) return;
    const id = window.setTimeout(() => setStatus(null), STATUS_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [status]);

  const meta = useMemo(() => ({ title, cwd, model: sessionInfo }), [title, cwd, sessionInfo]);

  // Recomputed only when the underlying transcript/meta actually changes —
  // `itemsToMarkdown` is pure but not free on a long transcript, and this
  // component re-renders on every status-line tick.
  const markdown = useMemo(() => itemsToMarkdown(items, meta), [items, meta]);

  if (!open) return null;

  const hasItems = items.length > 0;

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        setStatus("Clipboard unavailable");
        return;
      }
      await navigator.clipboard.writeText(markdown);
      setStatus("Copied");
    } catch {
      setStatus("Copy failed");
    }
  };

  const handleSave = async () => {
    try {
      const path = await save({
        defaultPath: receiptFilename(meta),
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!path) return;
      await saveText(path, markdown);
      setStatus("Saved");
    } catch {
      setStatus("Save failed");
    }
  };

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs receipt-panel" onClick={(event) => event.stopPropagation()}>
        <div className="prefs-head">
          <span>Receipt</span>
        </div>

        <div className="prefs-section">
          <div className="prefs-section-title">Export conversation</div>
          {!hasItems ? (
            <div className="prefs-row">
              <span className="prefs-hint">Nothing to export yet — this conversation has no items.</span>
            </div>
          ) : (
            <>
              <div className="receipt-actions">
                <button type="button" className="receipt-button" onClick={handleCopy}>
                  Copy
                </button>
                <button type="button" className="receipt-button" onClick={handleSave}>
                  Save…
                </button>
                {status && <span className="receipt-status">{status}</span>}
              </div>
              <pre className="receipt-preview">{markdown}</pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
