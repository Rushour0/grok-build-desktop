import { useMemo, useState } from "react";
import {
  buildSplitRows,
  collapseContext,
  hasChanges,
  isGap,
  type Seg,
  type SplitRow,
} from "./lib/splitDiff";

/// A side-by-side diff of the edit awaiting approval: old on the left, new on the right, with
/// matching lines aligned across from each other, only the changed words highlighted, and long
/// unchanged stretches folded into gaps you can open. This is the review a terminal can't give
/// you — the whole reason a permission prompt belongs in a window and not a scrollback.
export function SplitDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = useMemo(() => buildSplitRows(oldText, newText), [oldText, newText]);
  const display = useMemo(() => collapseContext(rows), [rows]);
  // Which gaps the user has opened, and whether long lines wrap or scroll. Kept per diff.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [wrap, setWrap] = useState(true);

  if (!hasChanges(rows)) {
    return <div className="split-diff-empty">(no textual change)</div>;
  }

  return (
    <div className="split-diff-wrap">
      <div className="split-diff-tools">
        <button type="button" className="diff-tool" onClick={() => setWrap((w) => !w)} aria-pressed={!wrap}>
          {wrap ? "No wrap" : "Wrap"}
        </button>
      </div>
      <div className={`split-diff${wrap ? "" : " nowrap"}`}>
        <div className="split-diff-grid">
          {display.map((row, index) => {
            if (isGap(row)) {
              if (expanded.has(index)) {
                return row.rows.map((hidden, k) => <DiffRow key={`${index}-${k}`} row={hidden} />);
              }
              return (
                <button
                  key={index}
                  type="button"
                  className="diff-gap"
                  onClick={() => setExpanded((current) => new Set(current).add(index))}
                >
                  ⋯ {row.count} unchanged {row.count === 1 ? "line" : "lines"}
                </button>
              );
            }
            return <DiffRow key={index} row={row} />;
          })}
        </div>
      </div>
    </div>
  );
}

/// The line-tint for one side of a row. Word-level highlight rides on top of this (see
/// `DiffSegs`); an unchanged line and an absent line are visually distinct — one is quiet,
/// the other is marked as "nothing here".
function cellClass(row: SplitRow, side: "left" | "right"): string {
  const cell = side === "left" ? row.left : row.right;
  if (!cell) return "empty";
  if (row.kind === "context") return "same";
  return side === "left" ? "del" : "add";
}

function DiffRow({ row }: { row: SplitRow }) {
  return (
    <>
      <div className={`d-num${row.left ? "" : " empty"}`}>{row.left?.num ?? ""}</div>
      <div className={`d-code left ${cellClass(row, "left")}`}>
        {row.left ? <DiffSegs segs={row.left.segs} /> : null}
      </div>
      <div className={`d-num d-num-new${row.right ? "" : " empty"}`}>{row.right?.num ?? ""}</div>
      <div className={`d-code right ${cellClass(row, "right")}`}>
        {row.right ? <DiffSegs segs={row.right.segs} /> : null}
      </div>
    </>
  );
}

/// The words of a line. `same` runs render plain; a changed line's edited words carry a
/// stronger mark so you see exactly what moved, not just that the line changed.
function DiffSegs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((seg, i) =>
        seg.kind === "same" ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <span key={i} className={`seg-${seg.kind}`}>
            {seg.text}
          </span>
        ),
      )}
    </>
  );
}
