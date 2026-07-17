import { describe, expect, it } from "vitest";
import type { Item } from "../App";
import { itemsToMarkdown, receiptFilename } from "./receipt";

describe("itemsToMarkdown", () => {
  it("never throws and returns a string for empty items", () => {
    const md = itemsToMarkdown([]);
    expect(typeof md).toBe("string");
    expect(md).toContain("No items");
  });

  it("renders a header with title, cwd, model, and effort", () => {
    const md = itemsToMarkdown([], {
      title: "Fix the bug",
      cwd: "/Users/me/proj",
      model: { currentModelId: "grok-4", model: { name: "Grok 4", reasoningEffort: "high" } },
    });
    expect(md).toContain("# Fix the bug");
    expect(md).toContain("/Users/me/proj");
    expect(md).toContain("Grok 4");
    expect(md).toContain("high");
  });

  it("renders a user prompt as a blockquote and an answer as prose", () => {
    const items: Item[] = [
      { id: "1", kind: "you", text: "please fix it" },
      { id: "2", kind: "answer", text: "done" },
    ];
    const md = itemsToMarkdown(items);
    expect(md).toContain("> please fix it");
    expect(md).toContain("done");
  });

  it("renders thought and error items, clearly labeled", () => {
    const items: Item[] = [
      { id: "1", kind: "thought", text: "hmm let me think" },
      { id: "2", kind: "error", text: "boom" },
    ];
    const md = itemsToMarkdown(items);
    expect(md).toContain("Thinking");
    expect(md).toContain("hmm let me think");
    expect(md).toContain("**Error:**");
    expect(md).toContain("boom");
  });

  it("renders a tool call with status, read-only tag, duration, output, and diffs", () => {
    const items: Item[] = [
      {
        id: "t1",
        kind: "tool",
        title: "Edit file",
        status: "completed",
        meta: { label: "Editing src/App.tsx", readOnly: false, source: "acp" },
        content: [
          { type: "text", text: "wrote 3 lines" },
          { type: "diff", path: "src/App.tsx", oldText: "a\nb", newText: "a\nc" },
        ],
        locations: [{ path: "src/App.tsx", line: 10 }],
        startedAt: 1000,
        endedAt: 2500,
      } as Item,
    ];
    const md = itemsToMarkdown(items);
    expect(md).toContain("Editing src/App.tsx");
    expect(md).toContain("completed");
    expect(md).toContain("1.5s");
    expect(md).toContain("```diff");
    expect(md).toContain("-a");
    expect(md).toContain("+c");
    expect(md).toContain("wrote 3 lines");
    expect(md).toContain("src/App.tsx:10");
  });

  it("marks read-only tools and failed tools distinctly", () => {
    const items: Item[] = [
      {
        id: "t1",
        kind: "tool",
        title: "Read file",
        status: "failed",
        meta: { label: "Reading x", readOnly: true, source: "acp" },
        content: [],
        locations: [],
      } as Item,
    ];
    const md = itemsToMarkdown(items);
    expect(md).toContain("(read-only)");
    expect(md).toContain("failed");
    expect(md).toContain("✖");
  });

  it("renders an ask item with its decision", () => {
    const items: Item[] = [
      {
        id: "a1",
        kind: "ask",
        req: {
          requestId: 1,
          toolCall: { title: "Run rm -rf", content: [{ type: "diff", path: "f.txt", oldText: "1", newText: "2" }] },
          options: [{ optionId: "allow", name: "Allow" }],
        },
        decided: "allow",
        failed: null,
      } as Item,
    ];
    const md = itemsToMarkdown(items);
    expect(md).toContain("Approval requested");
    expect(md).toContain("Run rm -rf");
    expect(md).toContain("Decision: allow");
    expect(md).toContain("```diff");
  });

  it("renders plan entries as a checklist", () => {
    const items: Item[] = [
      {
        id: "p1",
        kind: "plan",
        entries: [
          { content: "Step one", status: "completed" },
          { content: "Step two", status: "in_progress" },
          { content: "Step three", status: "pending" },
        ],
      } as Item,
    ];
    const md = itemsToMarkdown(items);
    expect(md).toContain("[x] Step one");
    expect(md).toContain("[~] Step two");
    expect(md).toContain("[ ] Step three");
  });

  it("renders usage as a summary line", () => {
    const items: Item[] = [
      {
        id: "u1",
        kind: "usage",
        modelId: "grok-4",
        totalTokens: 1000,
        inputTokens: 700,
        outputTokens: 300,
        apiDurationMs: 2500,
      } as Item,
    ];
    const md = itemsToMarkdown(items);
    expect(md).toContain("grok-4");
    expect(md).toContain("1,000 tokens");
    expect(md).toContain("700 in");
    expect(md).toContain("2.5s");
  });

  it("never throws on malformed/unrecognized items", () => {
    const items = [null, undefined, { id: "x" }, { id: "y", kind: "mystery", weird: () => {} }] as unknown as Item[];
    expect(() => itemsToMarkdown(items)).not.toThrow();
  });

  it("is deterministic for the same input", () => {
    const items: Item[] = [{ id: "1", kind: "you", text: "hi" }];
    const meta = { title: "t", generatedAt: "2026-01-01T00:00:00.000Z" };
    expect(itemsToMarkdown(items, meta)).toBe(itemsToMarkdown(items, meta));
  });
});

describe("receiptFilename", () => {
  it("falls back to a plain default with no title", () => {
    expect(receiptFilename()).toBe("grok-run.md");
    expect(receiptFilename({})).toBe("grok-run.md");
  });

  it("slugifies a title", () => {
    expect(receiptFilename({ title: "Fix the Login Bug!" })).toBe("grok-run-fix-the-login-bug.md");
  });

  it("never throws on weird titles", () => {
    expect(() => receiptFilename({ title: "!!!///" })).not.toThrow();
    expect(receiptFilename({ title: "!!!///" })).toBe("grok-run.md");
  });
});
