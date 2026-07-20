import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface WorktreesPanelProps {
  open: boolean;
  onClose: () => void;
  /// The current project folder — worktrees are listed relative to it.
  cwd: string;
}

interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  is_main: boolean;
  locked: boolean;
}
interface WorktreesResult {
  is_repo: boolean;
  worktrees: Worktree[];
}

/// Floating worktrees overlay, matching the other inspector panels' close behavior.
export function WorktreesPanel({ open, onClose, cwd }: WorktreesPanelProps): React.ReactElement | null {
  const [result, setResult] = useState<WorktreesResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setResult(null);
    setError(null);
    invoke<WorktreesResult>("list_worktrees", { cwd })
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setError("Could not read git worktrees.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const mono: React.CSSProperties = { fontFamily: "var(--font-mono)" };
  const muted: React.CSSProperties = { color: "var(--ink-soft)" };

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs" onClick={(event) => event.stopPropagation()}>
        <div className="prefs-head">
          <span>Worktrees</span>
        </div>
        <div className="prefs-section" style={{ overflowY: "auto", padding: "0.9rem 1.1rem 1.1rem" }}>
          {error && <div className="prefs-row" style={{ color: "var(--danger)" }}>{error}</div>}
          {!error && !result && <div className="prefs-row" style={muted}>Loading…</div>}
          {!error && result && !result.is_repo && (
            <div className="prefs-row" style={muted}>
              This project isn&apos;t a git repository.
            </div>
          )}
          {!error && result?.is_repo && result.worktrees.length === 0 && (
            <div className="prefs-row" style={muted}>No worktrees.</div>
          )}
          {result?.worktrees.map((w) => (
            <div key={w.path} className="prefs-row" style={{ alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    ...mono,
                    fontSize: "0.8rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {w.path}
                </div>
                <div style={{ ...mono, ...muted, fontSize: "0.72rem" }}>
                  {w.branch ?? "detached"} · {w.head}
                </div>
              </div>
              <span style={{ flex: "none", fontSize: "0.7rem", ...muted }}>
                {w.is_main ? "main" : w.locked ? "locked" : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
