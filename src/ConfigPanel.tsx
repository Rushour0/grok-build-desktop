import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ConfigPanelProps {
  open: boolean;
  onClose: () => void;
}

interface GrokAccount {
  first_name: string;
  email: string;
  auth_mode: string;
  team_id: string;
  grok_version: string;
  default_model: string;
}

interface ConfigSection {
  name: string;
  lines: string[];
}

const EMPTY_ACCOUNT: GrokAccount = {
  first_name: "",
  email: "",
  auth_mode: "",
  team_id: "",
  grok_version: "",
  default_model: "",
};

/** A deliberately small TOML display parser: section headers and assignments only. */
function parseConfig(text: string): ConfigSection[] {
  const sections: ConfigSection[] = [];
  let current: ConfigSection = { name: "General", lines: [] };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      if (current.lines.length > 0) sections.push(current);
      current = { name: line.slice(1, -1), lines: [] };
      continue;
    }
    if (line.includes("=")) current.lines.push(line);
  }

  if (current.lines.length > 0) sections.push(current);
  return sections;
}

/** Floating config overlay, matching the existing preferences panel close behavior. */
export function ConfigPanel({ open, onClose }: ConfigPanelProps): React.ReactElement | null {
  const [config, setConfig] = useState("");
  const [account, setAccount] = useState<GrokAccount>(EMPTY_ACCOUNT);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const load = async () => {
      try {
        const [nextConfig, nextAccount] = await Promise.all([
          invoke<string>("read_grok_config"),
          invoke<GrokAccount>("read_grok_account"),
        ]);
        if (cancelled) return;
        setConfig(nextConfig);
        setAccount(nextAccount);
        setLoadError(null);
      } catch {
        if (!cancelled) setLoadError("Could not read local Grok settings.");
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [open]);

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

  const sections = parseConfig(config);
  const valueOf = (value: string) => value || "Unavailable";

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs" onClick={(event) => event.stopPropagation()}>
        <div className="prefs-head">
          <span>Config &amp; Auth</span>
        </div>

        <div className="prefs-section" style={{ overflowY: "auto", padding: "0.9rem 1.1rem 1.1rem" }}>
          <div className="prefs-section-title">Account</div>
          <div className="prefs-row">
            <span className="prefs-row-label">Name</span>
            <span>{valueOf(account.first_name)}</span>
          </div>
          <div className="prefs-row">
            <span className="prefs-row-label">Email</span>
            <span>{valueOf(account.email)}</span>
          </div>
          <div className="prefs-row">
            <span className="prefs-row-label">Auth mode</span>
            <span>{valueOf(account.auth_mode)}</span>
          </div>
          <div className="prefs-row">
            <span className="prefs-row-label">Version</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>{valueOf(account.grok_version)}</span>
          </div>
          {account.default_model ? (
            <div className="prefs-row">
              <span className="prefs-row-label">Default model</span>
              <span style={{ fontFamily: "var(--font-mono)" }}>{account.default_model}</span>
            </div>
          ) : null}
          {account.team_id ? (
            <div className="prefs-row">
              <span className="prefs-row-label">Team ID</span>
              <span style={{ color: "var(--ink-soft)", fontFamily: "var(--font-mono)" }}>{account.team_id}</span>
            </div>
          ) : null}

          <div className="prefs-section" style={{ marginTop: "1.25rem" }}>
            <div className="prefs-section-title">Config</div>
            {loadError ? (
              <div className="prefs-row" style={{ color: "var(--ink-soft)" }}>
                {loadError}
              </div>
            ) : sections.length === 0 ? (
              <div className="prefs-row" style={{ color: "var(--ink-soft)" }}>
                No config.toml found.
              </div>
            ) : (
              sections.map((section) => (
                <div key={section.name} style={{ marginBottom: "0.85rem" }}>
                  <div
                    style={{ color: "var(--ink-soft)", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}
                  >
                    [{section.name}]
                  </div>
                  <pre
                    style={{
                      margin: "0.35rem 0 0",
                      padding: "0.65rem",
                      overflowX: "auto",
                      border: "1px solid var(--line)",
                      background: "var(--panel)",
                      color: "var(--ink)",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.75rem",
                      lineHeight: 1.55,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {section.lines.join("\n")}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
