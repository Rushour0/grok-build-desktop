/// Read-only "Tasks" overlay: shows grok's background work — spawned subagents,
/// backgrounded/scheduled tasks — as a live list. Cloned from `Preferences.tsx`'s
/// overlay shell (fixed scrim + centered panel, ESC + backdrop-click close) so it
/// matches the app's existing overlay idiom exactly rather than inventing a new one.
///
/// This component is purely presentational: it owns no state of its own besides a
/// 1s ticking clock (to keep "elapsed" live) and never mutates `tasks` — the parent
/// (App.tsx) is the only thing that writes to the list, via `parseNotify`/`mergeTask`
/// in `./lib/notify`. There are no buttons here that change anything about a task.
import { useEffect, useState } from "react";
import type { TaskItem } from "./lib/notify";

export interface TasksPanelProps {
  open: boolean;
  onClose: () => void;
  tasks: TaskItem[];
}

/// Human-readable elapsed time since `startedAt`, e.g. "3s", "2m 04s", "1h 12m".
/// Returns null when we don't have a start time to measure from (never throws on
/// a missing/malformed timestamp — just omit the elapsed badge).
function elapsedOf(startedAt: number | undefined, now: number): string | null {
  if (!startedAt || !Number.isFinite(startedAt)) return null;
  const ms = Math.max(0, now - startedAt);
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/// Floating tasks overlay: fixed scrim + centered panel, matching
/// `Preferences.tsx` (ESC + backdrop-click close). Controlled by `open`/`onClose`
/// only — renders null when closed so it never eats focus or keyboard events
/// while hidden.
export function TasksPanel({ open, onClose, tasks }: TasksPanelProps): React.ReactElement | null {
  // ESC closes, same as Preferences / the command palette. Only listen while
  // open so this never intercepts ESC elsewhere in the app.
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

  // Ticking clock so "elapsed" advances live while the panel is open. Only
  // runs while open — no background timer eating cycles when the panel is
  // closed/unmounted-in-spirit (it returns null below, but hooks must still
  // run in the same order every render, so this stays above the early return).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  if (!open) return null;

  // Most-recent first: tasks with a startedAt sort newest-started first;
  // tasks without one (shouldn't normally happen, but parsing is defensive)
  // sort after everything that has a timestamp.
  const sorted = tasks.slice().sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs tasks-panel" onClick={(event) => event.stopPropagation()}>
        <div className="prefs-head">
          <span>Tasks</span>
        </div>

        <div className="prefs-section">
          <div className="prefs-section-title">Background work</div>
          {sorted.length === 0 ? (
            <div className="prefs-row">
              <span className="prefs-hint">No background tasks yet.</span>
            </div>
          ) : (
            <div className="tasks-list">
              {sorted.map((task) => (
                <div className="tasks-row" key={task.id}>
                  <div className="tasks-row-main">
                    <span className="tasks-kind-badge">{task.kind}</span>
                    <span className="tasks-title">{task.title}</span>
                  </div>
                  <div className="tasks-row-meta">
                    <span className={"tasks-status-badge tasks-status-" + task.status}>{task.status}</span>
                    {elapsedOf(task.startedAt, now) && (
                      <span className="tasks-elapsed">{elapsedOf(task.startedAt, now)}</span>
                    )}
                  </div>
                  {task.detail && <div className="tasks-detail">{task.detail}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
