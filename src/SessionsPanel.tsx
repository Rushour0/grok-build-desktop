/// Read-only cross-project session browser. It follows the existing Preferences /
/// Tasks floating-overlay shell exactly: the parent owns whether it is open, while
/// this component owns only its best-effort inspection request and display state.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SessionsPanelProps {
  open: boolean;
  onClose: () => void;
}

interface PanelSession {
  project_path: string;
  project_name: string;
  session_id: string;
  title: string;
  updated_ms: number;
}

interface ProjectSessions {
  projectPath: string;
  projectName: string;
  sessions: PanelSession[];
}

function relativeDate(updatedMs: number, now: number): string {
  if (!Number.isFinite(updatedMs) || updatedMs <= 0) return "unknown";

  const elapsedSeconds = Math.max(0, Math.floor((now - updatedMs) / 1000));
  if (elapsedSeconds < 60) return "just now";
  if (elapsedSeconds < 3_600) return `${Math.floor(elapsedSeconds / 60)}m ago`;
  if (elapsedSeconds < 86_400) return `${Math.floor(elapsedSeconds / 3_600)}h ago`;
  if (elapsedSeconds < 604_800) return `${Math.floor(elapsedSeconds / 86_400)}d ago`;
  return new Date(updatedMs).toLocaleDateString();
}

/// Floating Sessions overlay: ESC and backdrop-click close it, while opening it
/// refreshes the filesystem-backed session inventory.
export function SessionsPanel({ open, onClose }: SessionsPanelProps): React.ReactElement | null {
  const [sessions, setSessions] = useState<PanelSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNow(Date.now());

    void invoke<PanelSession[]>("panel_sessions")
      .then((result) => {
        if (!cancelled) setSessions(result);
      })
      .catch(() => {
        if (!cancelled) {
          setSessions([]);
          setError("Could not read sessions.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [open]);

  const projects = useMemo<ProjectSessions[]>(() => {
    const grouped = new Map<string, ProjectSessions>();
    for (const session of sessions) {
      const project = grouped.get(session.project_path) ?? {
        projectPath: session.project_path,
        projectName: session.project_name,
        sessions: [],
      };
      project.sessions.push(session);
      grouped.set(session.project_path, project);
    }

    return Array.from(grouped.values())
      .map((project) => ({
        ...project,
        sessions: project.sessions.slice().sort((left, right) => right.updated_ms - left.updated_ms),
      }))
      .sort((left, right) => (right.sessions[0]?.updated_ms ?? 0) - (left.sessions[0]?.updated_ms ?? 0));
  }, [sessions]);

  if (!open) return null;

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs" onClick={(event) => event.stopPropagation()}>
        <div className="prefs-head">
          <span>Sessions</span>
        </div>

        <div className="prefs-body">
          {loading ? (
            <div className="prefs-section">
              <div className="prefs-row">
                <span className="prefs-hint">Reading sessions…</span>
              </div>
            </div>
          ) : error ? (
            <div className="prefs-section">
              <div className="prefs-row">
                <span style={{ color: "var(--ink-soft)" }}>{error}</span>
              </div>
            </div>
          ) : projects.length === 0 ? (
            <div className="prefs-section">
              <div className="prefs-row">
                <span className="prefs-hint">No saved Grok sessions found.</span>
              </div>
            </div>
          ) : (
            projects.map((project) => (
              <div className="prefs-section" key={project.projectPath}>
                <div className="prefs-section-title">{project.projectName}</div>
                <div
                  style={{
                    color: "var(--ink-soft)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.72rem",
                    marginBottom: "0.35rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={project.projectPath}
                >
                  {project.projectPath}
                </div>
                {project.sessions.map((session) => (
                  <div
                    className="side-row"
                    key={session.session_id}
                    style={{
                      borderBottom: "1px solid var(--line)",
                      padding: "0.45rem 0",
                    }}
                  >
                    <div
                      style={{
                        color: "var(--ink)",
                        fontSize: "0.86rem",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        width: "100%",
                      }}
                      title={session.title}
                    >
                      {session.title}
                    </div>
                    <div
                      className="side-row-meta"
                      style={{ display: "flex", fontFamily: "var(--font-mono)", gap: "0.65rem" }}
                    >
                      <span title={session.session_id}>{session.session_id}</span>
                      <span style={{ marginLeft: "auto" }}>{relativeDate(session.updated_ms, now)}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
