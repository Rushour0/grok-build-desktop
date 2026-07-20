import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

interface MarketplaceSource {
  name: string;
  git: string;
}

interface PluginInventory {
  skills: string[];
  agents: string[];
  personas: string[];
  roles: string[];
  marketplace: MarketplaceSource[];
}

const EMPTY_INVENTORY: PluginInventory = {
  skills: [],
  agents: [],
  personas: [],
  roles: [],
  marketplace: [],
};

const INVENTORY_SECTIONS: { key: keyof Pick<PluginInventory, "skills" | "agents" | "personas" | "roles">; title: string }[] = [
  { key: "skills", title: "Skills" },
  { key: "agents", title: "Agents" },
  { key: "personas", title: "Personas" },
  { key: "roles", title: "Roles" },
];

export interface PluginsPanelProps {
  open: boolean;
  onClose: () => void;
}

function isPluginInventory(value: unknown): value is PluginInventory {
  if (typeof value !== "object" || value === null) return false;
  const inventory = value as Record<string, unknown>;
  const hasStringList = (key: string) => Array.isArray(inventory[key]) && inventory[key].every((item) => typeof item === "string");

  return (
    hasStringList("skills") &&
    hasStringList("agents") &&
    hasStringList("personas") &&
    hasStringList("roles") &&
    Array.isArray(inventory.marketplace) &&
    inventory.marketplace.every(
      (source) =>
        typeof source === "object" &&
        source !== null &&
        typeof (source as Record<string, unknown>).name === "string" &&
        typeof (source as Record<string, unknown>).git === "string",
    )
  );
}

/// Read-only installed Grok plugins and marketplace overlay. It matches the
/// Preferences/Tasks overlay shell: ESC and clicking the scrim close it.
export function PluginsPanel({ open, onClose }: PluginsPanelProps): React.ReactElement | null {
  const [inventory, setInventory] = useState<PluginInventory>(EMPTY_INVENTORY);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    void invoke<unknown>("plugin_inventory")
      .then((value) => {
        if (!cancelled) setInventory(isPluginInventory(value) ? value : EMPTY_INVENTORY);
      })
      .catch(() => {
        if (!cancelled) setInventory(EMPTY_INVENTORY);
      });

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

  const hasInventory = INVENTORY_SECTIONS.some(({ key }) => inventory[key].length > 0) || inventory.marketplace.length > 0;

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs" onClick={(event) => event.stopPropagation()}>
        <div className="prefs-head">
          <span>Plugins</span>
        </div>

        <div className="prefs-body">
          {!hasInventory ? (
            <div className="overlay-empty">
              <p className="overlay-empty-title">No installed plugins found</p>
              <p className="overlay-empty-hint">Grok bundle skills and configured marketplace sources appear here.</p>
            </div>
          ) : (
            <>
              {INVENTORY_SECTIONS.map(({ key, title }) => (
                <div className="prefs-section" key={key}>
                  <div className="prefs-section-title">{title}</div>
                  {inventory[key].length === 0 ? (
                    <div className="prefs-row" style={{ color: "var(--ink-soft)" }}>
                      <span>None installed</span>
                    </div>
                  ) : (
                    inventory[key].map((name) => (
                      <div className="prefs-row" key={name}>
                        <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{name}</span>
                      </div>
                    ))
                  )}
                </div>
              ))}

              <div className="prefs-section">
                <div className="prefs-section-title">Marketplace sources</div>
                {inventory.marketplace.length === 0 ? (
                  <div className="prefs-row" style={{ color: "var(--ink-soft)" }}>
                    <span>None configured</span>
                  </div>
                ) : (
                  inventory.marketplace.map((source, index) => (
                    <div className="prefs-row" key={`${source.name}-${source.git}-${index}`}>
                      <span style={{ color: "var(--ink)" }}>{source.name || "Unnamed source"}</span>
                      <span
                        style={{
                          color: "var(--ink-soft)",
                          fontFamily: "var(--font-mono)",
                          fontSize: "0.76rem",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={source.git}
                      >
                        {source.git || "—"}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
