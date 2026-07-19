/// A compact dropdown above the composer for switching Grok's thinking (reasoning)
/// effort — the biggest token lever there is — without opening Preferences. Purely
/// a view over the session's advertised effort levels: it calls `onPick`, which the
/// parent turns into a `/effort <level>` command (same path Preferences uses). The
/// menu opens UPWARD (the composer sits at the bottom of the window) and is anchored
/// to `.effort-picker` — which MUST be position:relative in CSS, or the menu escapes
/// to the nearest positioned ancestor (the autocomplete had exactly that bug).
import { useEffect, useRef, useState } from "react";

export function EffortPicker({
  efforts,
  current,
  disabled,
  onPick,
}: {
  efforts: string[];
  current?: string;
  disabled?: boolean;
  onPick: (level: string) => void;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (efforts.length === 0) return null;
  const label = current ?? efforts[0];

  return (
    <div className="effort-picker" ref={rootRef}>
      <button
        type="button"
        className="effort-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Grok's thinking effort — higher thinks more, costs more tokens"
      >
        <span className="effort-cap">Effort</span>
        <span className="effort-value">{label}</span>
        <span className="effort-chevron" aria-hidden="true" />
      </button>
      {open && !disabled && (
        <ul className="effort-menu" role="listbox">
          {efforts.map((level) => (
            <li key={level} role="option" aria-selected={level === current}>
              <button
                type="button"
                className={"effort-option" + (level === current ? " active" : "")}
                onClick={() => {
                  onPick(level);
                  setOpen(false);
                }}
              >
                {level}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
