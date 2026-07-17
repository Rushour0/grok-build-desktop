import { useEffect, useMemo, useRef, useState } from "react";
import { filterActions } from "./lib/commands";

/// One entry in the command palette: same shape filterActions ranks against
/// (id/title/hint/keywords), plus the handler to invoke when it's picked.
export interface PaletteAction {
  id: string;
  title: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

/// Cmd/Ctrl+K floating overlay: fuzzy-filter `actions` by the typed query,
/// navigate with the keyboard or the mouse, run the active one on Enter/click.
/// Purely controlled by the parent — `open` and `onClose` own the open state,
/// this component owns only the query text and which row is highlighted.
export function CommandPalette({
  open,
  actions,
  onClose,
}: {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterActions(actions, query), [actions, query]);

  // Reset to a clean slate every time the palette opens, and autofocus the
  // search input so Cmd/Ctrl+K drops the user straight into typing.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    // Focus after paint so the just-mounted input actually exists.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Query changed -> whatever was highlighted may no longer exist at that
  // index in the re-ranked list, so snap back to the top match.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  const runAt = (index: number) => {
    const action = filtered[index];
    if (!action) return;
    onClose();
    action.run();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (filtered.length > 0) setActiveIndex((i) => (i + 1) % filtered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (filtered.length > 0) setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="cmdk-backdrop" onClick={onClose}>
      <div className="cmdk" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          className="cmdk-input"
          placeholder="Type a command…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="cmdk-list">
          {filtered.length === 0 ? (
            <div className="cmdk-empty">No matching commands</div>
          ) : (
            filtered.map((action, index) => (
              <div
                key={action.id}
                className={`cmdk-row${index === activeIndex ? " active" : ""}`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runAt(index)}
              >
                <span className="cmdk-title">{action.title}</span>
                {action.hint ? <span className="cmdk-hint">{action.hint}</span> : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
