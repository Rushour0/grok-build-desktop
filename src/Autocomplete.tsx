/// Presentational anchored dropdown shown just above the composer while a
/// "/" slash-command or "@" mention trigger is active (see detectTrigger in
/// src/lib/commands.ts). This component is deliberately dumb: it owns no
/// state and no keyboard handling. App.tsx computes `items` and
/// `activeIndex` from the pure trigger/filter helpers and the live keydown
/// listener on the composer textarea, then just re-renders this list. The
/// only interaction this component originates itself is a mouse click on a
/// row, which reports the picked item back via onPick.

import React from "react";

/// One row's display data. `id` is caller-defined (e.g. a command name or a
/// relative file path) and is echoed back verbatim via onPick — this
/// component never inspects it.
export interface AcItem {
  id: string;
  label: string;
  sub?: string;
}

export function Autocomplete({
  items,
  activeIndex,
  onPick,
}: {
  items: AcItem[];
  activeIndex: number;
  onPick: (item: AcItem) => void;
}): React.ReactElement | null {
  if (items.length === 0) return null;

  return (
    <div className="composer-ac">
      {items.map((item, i) => (
        <div
          key={item.id}
          className={i === activeIndex ? "composer-ac-row active" : "composer-ac-row"}
          onMouseDown={(e) => {
            // mousedown (not click) so this fires before the textarea blurs
            // and before any onBlur-driven dismissal of the dropdown.
            e.preventDefault();
            onPick(item);
          }}
        >
          <span className="composer-ac-label">{item.label}</span>
          {item.sub ? <span className="composer-ac-sub">{item.sub}</span> : null}
        </div>
      ))}
    </div>
  );
}
