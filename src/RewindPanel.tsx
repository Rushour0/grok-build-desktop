import { useEffect, useState } from "react";
import type { RewindPoint } from "./lib/bridge";
import { describeRewind, isDestructiveMode, type RewindMode } from "./lib/rewind";

/// Props for the Rewind overlay. Purely controlled/presentational, same
/// shape as `Preferences`: the parent owns fetching the point list (via
/// `rewindPoints`) and actually executing a restore (via `rewindExecute`
/// inside `onConfirm`). This component never calls the bridge itself — it
/// only renders what it's given and reports the user's final, explicit
/// choice.
export interface RewindPanelProps {
  open: boolean;
  onClose: () => void;
  points: RewindPoint[];
  loading?: boolean;
  error?: string | null;
  /** Pre-highlight the point that corresponds to the "you" bubble the user
   *  clicked "Rewind to here" on, if the caller could derive it. */
  focusPointId?: string | null;
  /** Fires ONLY after the user has explicitly confirmed — for destructive
   *  scopes ("files"/"both") that means the second, separate "Yes, rewind"
   *  click, never the first "Rewind to this point" click. */
  onConfirm: (pointId: string, mode: RewindMode) => void;
}

const SCOPE_OPTIONS: { value: RewindMode; label: string }[] = [
  { value: "conversation", label: "Conversation only" },
  { value: "files", label: "Files only" },
  { value: "both", label: "Both" },
];

/// A rewind point's identity for list rendering/keys. Points are documented
/// as optional-everything (wire shape unverified), so fall back to the
/// array index when `id` is missing rather than crashing on a duplicate key.
function pointKey(point: RewindPoint, index: number): string {
  return typeof point.id === "string" && point.id.length > 0 ? point.id : `idx-${index}`;
}

function formatCreatedAt(value: RewindPoint["createdAt"]): string | null {
  if (value === undefined || value === null) return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : null;
  return date.toLocaleString();
}

/// Rewind overlay: fixed scrim + centered panel, cloned from `Preferences`
/// (ESC + backdrop-click close, `.prefs-backdrop`/`.prefs` family reused for
/// the shell so the two overlays look and behave the same). Adds a point
/// list, a scope selector, and — critically — a TWO-STEP confirm gate for
/// any scope that touches on-disk files. `window.confirm` doesn't work in
/// this app's WKUIDelegate, so the second step is plain in-app React state,
/// not a native dialog.
export function RewindPanel({
  open,
  onClose,
  points,
  loading,
  error,
  focusPointId,
  onConfirm,
}: RewindPanelProps): React.ReactElement | null {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<RewindMode>("conversation");
  // Non-null while showing the destructive "are you sure" sub-state, so we
  // know exactly which point/mode the second click applies to. Cleared on
  // Cancel, on closing the panel, or after a successful confirm.
  const [confirming, setConfirming] = useState<{ pointId: string; mode: RewindMode } | null>(
    null
  );

  // Re-seed the highlighted point whenever the panel is (re)opened for a
  // different message, and always drop any half-finished confirm state so a
  // stale "Yes, rewind" button never lingers across opens.
  useEffect(() => {
    if (!open) return;
    setSelectedId(focusPointId ?? null);
    setMode("conversation");
    setConfirming(null);
  }, [open, focusPointId]);

  // ESC closes, matching Preferences/CommandPalette. Only listens while
  // open so it never intercepts ESC elsewhere in the app.
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

  if (!open) return null;

  const selectedPoint =
    selectedId !== null
      ? points.find((p, i) => pointKey(p, i) === selectedId) ?? null
      : null;

  function handleClose() {
    setConfirming(null);
    onClose();
  }

  /// First click on "Rewind to this point". Non-destructive scopes fire
  /// `onConfirm` immediately (single confirm is fine for conversation-only,
  /// per spec). Destructive scopes never call `onConfirm` here — they only
  /// move into the confirm sub-state; the actual restore only happens from
  /// the separate "Yes, rewind" button below.
  function handleRewindClick() {
    if (!selectedPoint || selectedId === null) return;
    if (isDestructiveMode(mode)) {
      setConfirming({ pointId: selectedId, mode });
    } else {
      onConfirm(selectedId, mode);
    }
  }

  function handleCancelConfirm() {
    setConfirming(null);
  }

  /// The one and only path that fires a destructive restore. Requires the
  /// explicit second click on a button that is never autofocused and is
  /// visually separate from Cancel.
  function handleConfirmDestructive() {
    if (!confirming) return;
    onConfirm(confirming.pointId, confirming.mode);
    setConfirming(null);
  }

  const confirmingPoint =
    confirming !== null
      ? points.find((p, i) => pointKey(p, i) === confirming.pointId) ?? null
      : null;

  return (
    <div className="prefs-backdrop rewind-backdrop" onClick={handleClose}>
      <div className="prefs rewind-panel" onClick={(event) => event.stopPropagation()}>
        <div className="prefs-head">
          <span>Rewind</span>
        </div>

        {confirming && confirmingPoint ? (
          <div className="prefs-section rewind-confirm">
            <div className="prefs-section-title">Confirm rewind</div>
            <div className="prefs-row rewind-confirm-text">
              <span>{describeRewind(confirmingPoint, confirming.mode)}</span>
            </div>
            <div className="prefs-row rewind-confirm-actions">
              <button type="button" onClick={handleCancelConfirm}>
                Cancel
              </button>
              {/* Deliberately NOT autofocused — the user must move to and
                  click this button on purpose. Visually distinct via the
                  "danger" class (the app's one destructive-button spot). */}
              <button type="button" className="danger" onClick={handleConfirmDestructive}>
                Yes, rewind
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="prefs-section">
              <div className="prefs-section-title">Checkpoints</div>
              {loading ? (
                <div className="prefs-row">
                  <span className="prefs-hint">Loading…</span>
                </div>
              ) : error ? (
                <div className="prefs-row">
                  <span className="rewind-error">{error}</span>
                </div>
              ) : points.length === 0 ? (
                <div className="prefs-row">
                  <span className="prefs-hint">No checkpoints available for this conversation.</span>
                </div>
              ) : (
                <ul className="rewind-list">
                  {points.map((point, index) => {
                    const key = pointKey(point, index);
                    const createdAt = formatCreatedAt(point.createdAt);
                    const preview =
                      typeof point.promptText === "string" && point.promptText.trim().length > 0
                        ? point.promptText.trim()
                        : "(no prompt text)";
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className={`rewind-point${selectedId === key ? " active" : ""}`}
                          onClick={() => setSelectedId(key)}
                          aria-pressed={selectedId === key}
                        >
                          <span className="rewind-point-preview">{preview}</span>
                          <span className="rewind-point-meta">
                            {createdAt ? <span>{createdAt}</span> : null}
                            {typeof point.fileChangeCount === "number" ? (
                              <span>
                                {point.fileChangeCount} file
                                {point.fileChangeCount === 1 ? "" : "s"}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="prefs-section">
              <div className="prefs-section-title">Scope</div>
              <div className="prefs-row">
                <div className="seg">
                  {SCOPE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={`seg-btn${mode === opt.value ? " active" : ""}`}
                      onClick={() => setMode(opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {isDestructiveMode(mode) ? (
                <div className="prefs-row">
                  <span className="prefs-hint rewind-hint-danger">
                    This scope overwrites files on disk and can't be undone.
                  </span>
                </div>
              ) : null}
            </div>

            <div className="prefs-section rewind-actions">
              <div className="prefs-row">
                <button type="button" onClick={handleClose}>
                  Close
                </button>
                <button
                  type="button"
                  disabled={!selectedPoint}
                  onClick={handleRewindClick}
                >
                  Rewind to this point
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
