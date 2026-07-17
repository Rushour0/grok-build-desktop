import { diffLines, diffWordsWithSpace } from "diff";

/// The split-view diff model. A `SplitRow` is one aligned line pair: `left` is the old file,
/// `right` is the new one, and either may be null where a line exists only on one side. The
/// segments carry word-level change info so a modified line highlights just the words that
/// actually changed, not the whole line.
export type SegKind = "same" | "add" | "del";
export interface Seg {
  text: string;
  kind: SegKind;
}
export interface DiffCell {
  num: number | null;
  segs: Seg[];
}
export type RowKind = "context" | "del" | "add" | "change";
export interface SplitRow {
  kind: RowKind;
  left: DiffCell | null;
  right: DiffCell | null;
}
/// A collapsed run of unchanged lines, kept so the UI can reveal it on demand.
export interface Gap {
  kind: "gap";
  count: number;
  rows: SplitRow[];
}
export type DisplayRow = SplitRow | Gap;

export function isGap(row: DisplayRow): row is Gap {
  return row.kind === "gap";
}

/// One diff part's text back into lines. jsdiff terminates each line with `\n`, so the split
/// leaves a trailing empty element that isn't a real line — drop it. A genuinely empty line
/// in the middle (a bare `\n`) is preserved as an empty string.
function partLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/// Split a changed line pair into word-level segments. The left cell keeps the unchanged and
/// removed runs; the right keeps the unchanged and added runs — so the same words line up and
/// only the edited ones are marked.
function wordSegs(oldLine: string, newLine: string): [Seg[], Seg[]] {
  const left: Seg[] = [];
  const right: Seg[] = [];
  for (const part of diffWordsWithSpace(oldLine, newLine)) {
    if (part.added) {
      right.push({ text: part.value, kind: "add" });
    } else if (part.removed) {
      left.push({ text: part.value, kind: "del" });
    } else {
      left.push({ text: part.value, kind: "same" });
      right.push({ text: part.value, kind: "same" });
    }
  }
  if (left.length === 0) left.push({ text: "", kind: "del" });
  if (right.length === 0) right.push({ text: "", kind: "add" });
  return [left, right];
}

/// Align old and new text into side-by-side rows. A removed run immediately followed by an
/// added run is treated as an edit and paired line-for-line (with word-level segments);
/// leftover lines on either side become one-sided del/add rows. This is the alignment the
/// terminal can't give you — matching lines sit across from each other instead of all
/// deletions then all additions.
export function buildSplitRows(oldText: string, newText: string): SplitRow[] {
  const parts = diffLines(oldText, newText);
  const rows: SplitRow[] = [];
  let oldNum = 1;
  let newNum = 1;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const lines = partLines(part.value);

    if (!part.added && !part.removed) {
      for (const line of lines) {
        rows.push({
          kind: "context",
          left: { num: oldNum++, segs: [{ text: line, kind: "same" }] },
          right: { num: newNum++, segs: [{ text: line, kind: "same" }] },
        });
      }
      continue;
    }

    if (part.removed) {
      const next = parts[i + 1];
      if (next && next.added) {
        // Paired edit: line k of the removal sits across from line k of the addition.
        const delLines = lines;
        const addLines = partLines(next.value);
        i += 1; // consumed the addition part
        const n = Math.max(delLines.length, addLines.length);
        for (let k = 0; k < n; k++) {
          const oldLine = k < delLines.length ? delLines[k] : null;
          const newLine = k < addLines.length ? addLines[k] : null;
          if (oldLine !== null && newLine !== null) {
            const [leftSegs, rightSegs] = wordSegs(oldLine, newLine);
            rows.push({
              kind: "change",
              left: { num: oldNum++, segs: leftSegs },
              right: { num: newNum++, segs: rightSegs },
            });
          } else if (oldLine !== null) {
            rows.push({
              kind: "del",
              left: { num: oldNum++, segs: [{ text: oldLine, kind: "same" }] },
              right: null,
            });
          } else if (newLine !== null) {
            rows.push({
              kind: "add",
              left: null,
              right: { num: newNum++, segs: [{ text: newLine, kind: "same" }] },
            });
          }
        }
      } else {
        for (const line of lines) {
          rows.push({
            kind: "del",
            left: { num: oldNum++, segs: [{ text: line, kind: "same" }] },
            right: null,
          });
        }
      }
      continue;
    }

    // Pure addition (a removal ahead of it would have consumed it above).
    for (const line of lines) {
      rows.push({
        kind: "add",
        left: null,
        right: { num: newNum++, segs: [{ text: line, kind: "same" }] },
      });
    }
  }

  return rows;
}

export function hasChanges(rows: SplitRow[]): boolean {
  return rows.some((row) => row.kind !== "context");
}

/// Fold long stretches of unchanged lines into gaps, keeping `context` lines of breathing room
/// around every change. A file that changes three lines shouldn't make you scroll past three
/// hundred that didn't — but the hidden lines ride along in the gap so the UI can reveal them.
export function collapseContext(rows: SplitRow[], context = 3): DisplayRow[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== "context") {
      const from = Math.max(0, i - context);
      const to = Math.min(rows.length - 1, i + context);
      for (let j = from; j <= to; j++) keep[j] = true;
    }
  }

  const out: DisplayRow[] = [];
  let i = 0;
  while (i < rows.length) {
    if (keep[i]) {
      out.push(rows[i]);
      i += 1;
      continue;
    }
    const hidden: SplitRow[] = [];
    while (i < rows.length && !keep[i]) {
      hidden.push(rows[i]);
      i += 1;
    }
    out.push({ kind: "gap", count: hidden.length, rows: hidden });
  }
  return out;
}
