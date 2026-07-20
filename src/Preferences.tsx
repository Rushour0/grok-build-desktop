import { useEffect } from "react";
import type { ThemePref, AccentPref } from "./lib/theme";
import type { SessionModelInfo } from "./lib/bridge";

/// Props for the Preferences overlay. Purely controlled/presentational: the
/// parent owns open state, current values, and every side effect (theme
/// persistence, sending the effort slash-command, kicking off an update
/// check). This component never fetches data and never touches localStorage
/// or the DOM directly — it only renders what it's given and calls back.
export interface PrefsProps {
  open: boolean;
  onClose: () => void;
  theme: ThemePref;
  onThemeChange: (t: ThemePref) => void;
  accent: AccentPref;
  onAccentChange: (a: AccentPref) => void;
  sessionInfo?: SessionModelInfo;
  /** True if grok advertised an effort/model slash-command in this session. */
  effortCommandAvailable: boolean;
  /** Sends the advertised slash command (e.g. "/effort high") for a level. */
  onSetEffort?: (level: string) => void;
  shortcuts: { title: string; hint?: string }[];
  cliPath?: string | null;
  cliVersion?: string | null;
  hasLogin?: boolean;
  onCheckUpdates?: () => void;
  /** Names of the app's hardcoded, auto-approved read-only tools (from the
   *  Rust default-deny allowlist). Display-only — this list is never used
   *  to decide anything client-side; it just tells the user what the
   *  backend already auto-approves. */
  readonlyTools?: string[];
}

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const ACCENT_OPTIONS: { value: AccentPref; label: string }[] = [
  { value: "amber", label: "Amber" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
];

/// Floating preferences overlay: fixed scrim + centered panel, cloned from
/// the CommandPalette pattern (ESC + backdrop-click close). Controlled by
/// `open`/`onClose` only — renders null when closed so it never eats focus
/// or keyboard events while hidden.
export function Preferences({
  open,
  onClose,
  theme,
  onThemeChange,
  accent,
  onAccentChange,
  sessionInfo,
  effortCommandAvailable,
  onSetEffort,
  shortcuts,
  cliPath,
  cliVersion,
  hasLogin,
  onCheckUpdates,
  readonlyTools,
}: PrefsProps) {
  // ESC closes, same as the command palette. Only listen while open so this
  // never intercepts ESC elsewhere in the app.
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

  const model = sessionInfo?.model;
  const currentEffort = model?.reasoningEffort;
  const canPickEffort = Boolean(model?.supportsReasoningEffort && effortCommandAvailable);

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs" onClick={(event) => event.stopPropagation()}>
        <div className="prefs-head">
          <span>Preferences</span>
        </div>

        <div className="prefs-section">
          <div className="prefs-section-title">Appearance</div>
          <div className="prefs-row">
            <div className="seg">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`seg-btn${theme === opt.value ? " active" : ""}`}
                  onClick={() => onThemeChange(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="prefs-row">
            <span className="prefs-row-label">Accent</span>
            <div className="seg">
              {ACCENT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`seg-btn seg-accent-${opt.value}${accent === opt.value ? " active" : ""}`}
                  onClick={() => onAccentChange(opt.value)}
                >
                  <span className={`accent-dot accent-dot-${opt.value}`} aria-hidden="true" />
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="prefs-section">
          <div className="prefs-section-title">Model</div>
          <div className="prefs-row">
            <span>{model?.name ?? sessionInfo?.currentModelId ?? "Unknown"}</span>
          </div>
          {typeof model?.totalContextTokens === "number" ? (
            <div className="prefs-row">
              <span>Context window: {model.totalContextTokens.toLocaleString()} tokens</span>
            </div>
          ) : null}
          {model?.supportsReasoningEffort ? (
            canPickEffort ? (
              <div className="prefs-row">
                <div className="seg">
                  {(model.reasoningEfforts ?? []).map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`seg-btn${currentEffort === level ? " active" : ""}`}
                      onClick={() => onSetEffort?.(level)}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="prefs-row">
                <span>Effort: {currentEffort ?? "default"}</span>
                <span className="prefs-hint">set via /effort in chat</span>
              </div>
            )
          ) : null}
        </div>

        <div className="prefs-section">
          <div className="prefs-section-title">About</div>
          <div className="prefs-card">
            <div className="prefs-card-row">
              <span className="prefs-card-key">CLI path</span>
              <span className="prefs-card-val">{cliPath ?? "unknown"}</span>
            </div>
            <div className="prefs-card-row">
              <span className="prefs-card-key">Version</span>
              <span className="prefs-card-val">{cliVersion ?? "unknown"}</span>
            </div>
            <div className="prefs-card-row">
              <span className="prefs-card-key">Status</span>
              {hasLogin ? (
                <span className="prefs-status">
                  <span className="prefs-status-dot" />
                  Signed in
                </span>
              ) : (
                <span className="prefs-card-val">Not signed in</span>
              )}
            </div>
          </div>
        </div>

        <div className="prefs-section">
          <div className="prefs-section-title">Tools &amp; Safety</div>
          <div className="prefs-row">
            <span>
              Grok's file edits and shell commands always ask you first. Only these local
              read-only tools run automatically:
            </span>
          </div>
          <div className="prefs-row prefs-tool-chips">
            {(readonlyTools ?? []).map((tool) => (
              <span className="prefs-tool-chip" key={tool}>
                {tool}
              </span>
            ))}
          </div>
          <div className="prefs-row">
            <span className="prefs-hint">
              Everything else — writing files, running commands, network access — needs your
              approval. This is best-effort risk reduction, not a hard sandbox.
            </span>
          </div>
        </div>

        <div className="prefs-section">
          <div className="prefs-section-title">Keyboard</div>
          {shortcuts.map((s) => (
            <div className="prefs-row" key={s.title}>
              <span>{s.title}</span>
              {s.hint ? <span className="prefs-kbd">{s.hint}</span> : null}
            </div>
          ))}
        </div>

        <div className="prefs-section">
          <div className="prefs-section-title">Updates</div>
          <div className="prefs-row">
            <button type="button" onClick={onCheckUpdates}>
              Check for updates
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
