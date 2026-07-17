import { describe, expect, it } from "vitest";
import type { SessionUpdate } from "./bridge";
import { mergeToolUpdate, parseToolMeta, toolContentOf, toolFieldsFromCall } from "./toolMeta";

describe("parseToolMeta", () => {
  it("parses a real x.ai/tool meta object", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Read file",
      kind: "read",
      _meta: {
        "x.ai/tool": {
          label: "Reading src/App.tsx",
          kind: "read_file",
          read_only: true,
          namespace: "fs",
          canonical_input: { path: "src/App.tsx" },
        },
      },
    };
    const meta = parseToolMeta(update);
    expect(meta.source).toBe("x.ai/tool");
    expect(meta.label).toBe("Reading src/App.tsx");
    expect(meta.semanticKind).toBe("read_file");
    expect(meta.readOnly).toBe(true);
    expect(meta.namespace).toBe("fs");
    expect(meta.canonicalInput).toEqual({ path: "src/App.tsx" });
  });

  it("falls back to acp source when there is no x.ai/tool meta but acp kind/title exist", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "call_2",
      title: "Edit file",
      kind: "edit",
    };
    const meta = parseToolMeta(update);
    expect(meta.source).toBe("acp");
    // No x.ai/tool meta present, so no readOnly opinion was ever parsed out of it.
    expect(meta.readOnly).toBeUndefined();
    expect(meta.namespace).toBeUndefined();
    expect(meta.canonicalInput).toBeUndefined();
  });

  it("falls back to unknown source when there is no meta, kind, or title at all", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "call_3",
    };
    const meta = parseToolMeta(update);
    expect(meta.source).toBe("unknown");
  });

  it("still parses an unrecognized kind/namespace instead of throwing, and reflects read_only:false", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "call_4",
      title: "Do a weird thing",
      _meta: {
        "x.ai/tool": {
          kind: "some_totally_unknown_kind_v99",
          namespace: "mystery_namespace",
          read_only: false,
        },
      },
    };
    expect(() => parseToolMeta(update)).not.toThrow();
    const meta = parseToolMeta(update);
    expect(meta.source).toBe("x.ai/tool");
    expect(meta.semanticKind).toBe("some_totally_unknown_kind_v99");
    expect(meta.namespace).toBe("mystery_namespace");
    expect(meta.readOnly).toBe(false);
  });

  it("does not throw and returns unknown source when _meta is present but malformed", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "call_5",
      _meta: { "x.ai/tool": "not an object" },
    } as unknown as SessionUpdate;
    expect(() => parseToolMeta(update)).not.toThrow();
  });
});

describe("toolContentOf", () => {
  it("reads the tool-call content array off the wire field", () => {
    const update = {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_6",
      content: [
        { type: "text", text: "hello" },
        { type: "diff", path: "a.ts", oldText: "x", newText: "y" },
      ],
    } as unknown as SessionUpdate;
    const content = toolContentOf(update);
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "hello" });
    expect(content[1]).toEqual({ type: "diff", path: "a.ts", oldText: "x", newText: "y" });
  });

  it("returns [] when content is absent", () => {
    const update: SessionUpdate = { sessionUpdate: "tool_call", toolCallId: "call_7" };
    expect(toolContentOf(update)).toEqual([]);
  });
});

describe("toolFieldsFromCall", () => {
  it("builds initial fields from a tool_call update", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "call_8",
      title: "Run tests",
      status: "in_progress",
      kind: "execute",
      rawInput: { command: "npm test" },
      locations: [{ path: "src/App.tsx", line: 12 }],
      _meta: {
        "x.ai/tool": { label: "Running tests", kind: "execute_command", read_only: false },
      },
    };
    const fields = toolFieldsFromCall(update);
    expect(fields.title).toBe("Run tests");
    expect(fields.status).toBe("in_progress");
    expect(fields.rawInput).toEqual({ command: "npm test" });
    expect(fields.rawOutput).toBeUndefined();
    expect(fields.content).toEqual([]);
    expect(fields.locations).toEqual([{ path: "src/App.tsx", line: 12 }]);
    expect(fields.meta.label).toBe("Running tests");
    expect(fields.meta.readOnly).toBe(false);
  });

  it("defaults status to pending-ish sensible value and content/locations to empty arrays when absent", () => {
    const update: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "call_9",
      title: "Mystery tool",
    };
    const fields = toolFieldsFromCall(update);
    expect(fields.title).toBe("Mystery tool");
    expect(fields.content).toEqual([]);
    expect(fields.locations).toEqual([]);
    expect(typeof fields.status).toBe("string");
    expect(fields.status.length).toBeGreaterThan(0);
  });
});

describe("mergeToolUpdate", () => {
  const base: SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: "call_10",
    title: "Edit file",
    status: "pending",
    kind: "edit",
    rawInput: { path: "src/App.tsx" },
  };

  it("updates status and title on a follow-up update", () => {
    const initial = toolFieldsFromCall(base);
    const updated = mergeToolUpdate(initial, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_10",
      status: "completed",
      title: "Edit file (done)",
    });
    expect(updated.status).toBe("completed");
    expect(updated.title).toBe("Edit file (done)");
    // Original object must not have been mutated in place.
    expect(initial.status).toBe("pending");
    expect(initial.title).toBe("Edit file");
  });

  it("merges canonicalInput, rawOutput, and content that only arrive on a later update", () => {
    const initial = toolFieldsFromCall(base);
    expect(initial.meta.canonicalInput).toBeUndefined();
    expect(initial.rawOutput).toBeUndefined();
    expect(initial.content).toEqual([]);

    const updated = mergeToolUpdate(initial, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_10",
      status: "completed",
      rawOutput: { ok: true },
      content: [{ type: "text", text: "Applied 1 edit" }] as unknown as SessionUpdate["content"],
      _meta: {
        "x.ai/tool": { canonical_input: { path: "src/App.tsx", normalized: true } },
      },
    });

    expect(updated.rawOutput).toEqual({ ok: true });
    expect(updated.content).toEqual([{ type: "text", text: "Applied 1 edit" }]);
    expect(updated.meta.canonicalInput).toEqual({ path: "src/App.tsx", normalized: true });
  });

  it("does not clobber existing fields when a later update omits them", () => {
    const initial = toolFieldsFromCall(base);
    const withOutput = mergeToolUpdate(initial, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_10",
      status: "in_progress",
      rawOutput: { partial: true },
      locations: [{ path: "src/App.tsx", line: 3 }],
    });
    expect(withOutput.rawOutput).toEqual({ partial: true });
    expect(withOutput.locations).toEqual([{ path: "src/App.tsx", line: 3 }]);

    // A later update with only a status change must not wipe out rawOutput/locations
    // that a previous update already attached.
    const final = mergeToolUpdate(withOutput, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call_10",
      status: "completed",
    });
    expect(final.status).toBe("completed");
    expect(final.rawOutput).toEqual({ partial: true });
    expect(final.locations).toEqual([{ path: "src/App.tsx", line: 3 }]);
    // rawInput from the very first call must also survive untouched.
    expect(final.rawInput).toEqual({ path: "src/App.tsx" });
  });
});
