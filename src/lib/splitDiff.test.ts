import { describe, expect, it } from "vitest";
import {
  buildSplitRows,
  collapseContext,
  hasChanges,
  isGap,
  type SplitRow,
} from "./splitDiff";

const kinds = (rows: SplitRow[]) => rows.map((r) => r.kind);

describe("buildSplitRows", () => {
  it("treats identical text as all context with no changes", () => {
    const rows = buildSplitRows("a\nb\nc\n", "a\nb\nc\n");
    expect(kinds(rows)).toEqual(["context", "context", "context"]);
    expect(hasChanges(rows)).toBe(false);
    // Both sides carry the same line numbers, 1-based.
    expect(rows[0].left?.num).toBe(1);
    expect(rows[0].right?.num).toBe(1);
    expect(rows[2].left?.num).toBe(3);
  });

  it("puts an appended line on the right side only", () => {
    const rows = buildSplitRows("a\nb\n", "a\nb\nc\n");
    expect(kinds(rows)).toEqual(["context", "context", "add"]);
    const add = rows[2];
    expect(add.left).toBeNull();
    expect(add.right?.num).toBe(3);
    expect(add.right?.segs.map((s) => s.text).join("")).toBe("c");
    expect(hasChanges(rows)).toBe(true);
  });

  it("puts a removed line on the left side only", () => {
    const rows = buildSplitRows("a\nb\nc\n", "a\nc\n");
    expect(kinds(rows)).toEqual(["context", "del", "context"]);
    const del = rows[1];
    expect(del.right).toBeNull();
    expect(del.left?.num).toBe(2);
    expect(del.left?.segs.map((s) => s.text).join("")).toBe("b");
  });

  it("pairs an edited line across both sides with word-level segments", () => {
    const rows = buildSplitRows("foo bar\n", "foo baz\n");
    expect(kinds(rows)).toEqual(["change"]);
    const change = rows[0];
    // The unchanged word survives on both sides; the changed word is marked per side.
    expect(change.left?.segs.some((s) => s.kind === "same" && s.text.includes("foo"))).toBe(true);
    expect(change.right?.segs.some((s) => s.kind === "same" && s.text.includes("foo"))).toBe(true);
    expect(change.left?.segs.some((s) => s.kind === "del" && s.text.includes("bar"))).toBe(true);
    expect(change.right?.segs.some((s) => s.kind === "add" && s.text.includes("baz"))).toBe(true);
    // The right cell must never carry a deletion, nor the left an addition.
    expect(change.left?.segs.some((s) => s.kind === "add")).toBe(false);
    expect(change.right?.segs.some((s) => s.kind === "del")).toBe(false);
  });

  it("pairs what it can and leaves the surplus one-sided when block sizes differ", () => {
    // Two old lines become three new ones: two pair as changes, the extra is a lone add.
    const rows = buildSplitRows("one\ntwo\n", "1\n2\n3\n");
    expect(kinds(rows)).toEqual(["change", "change", "add"]);
    expect(rows[2].left).toBeNull();
    expect(rows[2].right?.num).toBe(3);
    // Old numbering stops at 2 (only two old lines); new numbering reaches 3.
    expect(rows[1].left?.num).toBe(2);
    expect(rows[1].right?.num).toBe(2);
  });

  it("keeps line numbers monotonic across mixed hunks", () => {
    const rows = buildSplitRows("a\nb\nc\nd\n", "a\nB\nc\nd\ne\n");
    // a=context, b->B=change, c=context, d=context, +e=add
    expect(kinds(rows)).toEqual(["context", "change", "context", "context", "add"]);
    const lastContext = rows[3];
    expect(lastContext.left?.num).toBe(4);
    expect(lastContext.right?.num).toBe(4);
    expect(rows[4].right?.num).toBe(5);
  });
});

describe("collapseContext", () => {
  it("folds a long unchanged run into a single gap that carries the hidden rows", () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    // Change only the very first line, leaving a long unchanged tail.
    const newText = "CHANGED\n" + Array.from({ length: 29 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const display = collapseContext(buildSplitRows(oldText, newText), 3);

    const gaps = display.filter(isGap);
    expect(gaps.length).toBe(1);
    // 30 rows, 1 changed + 3 kept as context => 26 hidden.
    expect(gaps[0].count).toBe(26);
    expect(gaps[0].rows.length).toBe(26);
    expect(gaps[0].rows.every((r) => r.kind === "context")).toBe(true);
  });

  it("keeps context lines on both sides of a change and never collapses the change itself", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const oldText = lines.join("\n") + "\n";
    const changed = [...lines];
    changed[10] = "CHANGED";
    const display = collapseContext(buildSplitRows(oldText, changed.join("\n") + "\n"), 3);

    // A gap before and after the change, with the change row visible between them.
    const changeVisible = display.some((r) => !isGap(r) && r.kind === "change");
    expect(changeVisible).toBe(true);
    expect(display.filter(isGap).length).toBe(2);
  });

  it("produces one big gap and no visible rows when nothing changed", () => {
    const text = "a\nb\nc\n";
    const display = collapseContext(buildSplitRows(text, text), 3);
    expect(display.length).toBe(1);
    expect(isGap(display[0])).toBe(true);
  });
});
