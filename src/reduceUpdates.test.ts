import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { isPlan, isText, isTool, reduceUpdates, type Item } from "./App";
import type { SessionUpdate } from "./lib/bridge";

// `reduceUpdates` turns a replayed `session/load` stream into the transcript. It is
// the only place a stored conversation becomes something a user can read, so a
// regression here silently rewrites history rather than crashing.
//
// The reset rule these tests lean on: three kinds — `user_message_chunk`,
// `tool_call`, `plan` — return a fresh state WITHOUT spreading `...state`, which
// drops `answerId`/`thoughtId` and so starts a new bubble. `tool_call_update` and
// the chunk kinds DO spread it, and so continue the open bubble. That set matches
// the live `onUpdate` path's `openBubbles` resets exactly, which is what makes it
// intentional rather than incidental.

const answer = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const thought = (text: string): SessionUpdate => ({
  sessionUpdate: "agent_thought_chunk",
  content: { type: "text", text },
});
const user = (text: string): SessionUpdate => ({
  sessionUpdate: "user_message_chunk",
  content: { type: "text", text },
});
const toolCall = (over: Partial<SessionUpdate> = {}): SessionUpdate => ({
  sessionUpdate: "tool_call",
  toolCallId: "t1",
  title: "Reading src/App.tsx",
  ...over,
});
const toolUpdate = (over: Partial<SessionUpdate> = {}): SessionUpdate => ({
  sessionUpdate: "tool_call_update",
  toolCallId: "t1",
  ...over,
});
// A tool_call carrying grok's own `_meta["x.ai/tool"]` block — the richer,
// non-ACP metadata lib/toolMeta.ts's parseToolMeta() picks up (label, readOnly,
// kind, namespace) on top of the plain ACP title/kind fields every tool has.
const toolCallWithXaiMeta = (over: Partial<SessionUpdate> = {}): SessionUpdate =>
  toolCall({
    _meta: {
      "x.ai/tool": {
        kind: "read_file",
        namespace: "fs",
        label: "Reading App.tsx",
        readOnly: true,
      },
    },
    ...over,
  });

const texts = (items: Item[]) => items.filter(isText).map((i) => i.text);
const kinds = (items: Item[]) => items.map((i) => i.kind);

describe("reduceUpdates: empty and unknown input", () => {
  it("returns nothing for an empty stream", () => {
    expect(reduceUpdates([])).toEqual([]);
  });

  it("ignores an unknown sessionUpdate kind instead of throwing", () => {
    // grok can add kinds whenever it likes. An exception here would blank the
    // whole transcript rather than skip one line.
    const unknown = { sessionUpdate: "something_invented_later" } as unknown as SessionUpdate;
    expect(() => reduceUpdates([unknown])).not.toThrow();
    expect(reduceUpdates([unknown])).toEqual([]);
  });

  it("ignores available_commands_update — it is not a message", () => {
    // Seen twice in a real captured replay. It carries the slash-command list,
    // and rendering it as a bubble would put machinery in the user's transcript.
    const cmds = {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "init", description: "…" }],
    } as unknown as SessionUpdate;
    expect(reduceUpdates([cmds])).toEqual([]);
  });

  it("ignores a usage kind", () => {
    const usage = { sessionUpdate: "usage", totalTokens: 10 } as unknown as SessionUpdate;
    expect(reduceUpdates([usage])).toEqual([]);
  });

  it("keeps known items when unknown kinds are interleaved", () => {
    const unknown = { sessionUpdate: "future_kind" } as unknown as SessionUpdate;
    const items = reduceUpdates([unknown, answer("hi"), unknown]);
    expect(items).toHaveLength(1);
    expect(texts(items)).toEqual(["hi"]);
  });

  it("returns nothing for a stream of only unknown kinds", () => {
    const unknown = { sessionUpdate: "future_kind" } as unknown as SessionUpdate;
    expect(reduceUpdates([unknown, unknown, unknown])).toEqual([]);
  });
});

describe("reduceUpdates: agent message chunks accumulate", () => {
  it("renders a single chunk as one answer bubble", () => {
    const items = reduceUpdates([answer("hello")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "answer", text: "hello" });
  });

  it("joins two consecutive chunks into one bubble", () => {
    // Confirmed against a real capture: consecutive agent chunks do occur.
    const items = reduceUpdates([answer("Hello, "), answer("world")]);
    expect(items).toHaveLength(1);
    expect(texts(items)).toEqual(["Hello, world"]);
  });

  it("joins many consecutive chunks in order", () => {
    const items = reduceUpdates([answer("a"), answer("b"), answer("c"), answer("d")]);
    expect(items).toHaveLength(1);
    expect(texts(items)).toEqual(["abcd"]);
  });

  it("treats a chunk with no content as empty text, not undefined", () => {
    const items = reduceUpdates([{ sessionUpdate: "agent_message_chunk" }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "answer", text: "" });
  });

  it("does not let a contentless chunk erase text already accumulated", () => {
    const items = reduceUpdates([answer("kept"), { sessionUpdate: "agent_message_chunk" }]);
    expect(texts(items)).toEqual(["kept"]);
  });

  it("gives the bubble a stable id across its chunks", () => {
    const items = reduceUpdates([answer("a"), answer("b")]);
    expect(items[0].id).toBe("ans-0");
  });
});

describe("reduceUpdates: agent thought chunks accumulate separately", () => {
  it("renders a thought chunk as a thought bubble, not an answer", () => {
    const items = reduceUpdates([thought("hmm")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "thought", text: "hmm" });
  });

  it("joins consecutive thought chunks into one bubble", () => {
    const items = reduceUpdates([thought("let me "), thought("think")]);
    expect(items).toHaveLength(1);
    expect(texts(items)).toEqual(["let me think"]);
  });

  it("treats a thought chunk with no content as empty text", () => {
    const items = reduceUpdates([{ sessionUpdate: "agent_thought_chunk" }]);
    expect(items[0]).toMatchObject({ kind: "thought", text: "" });
  });

  it("keeps a thought bubble distinct from an answer bubble opened after it", () => {
    // thought-then-answer is the ordinary shape: reason, then reply.
    const items = reduceUpdates([thought("reasoning"), answer("reply")]);
    expect(kinds(items)).toEqual(["thought", "answer"]);
    expect(texts(items)).toEqual(["reasoning", "reply"]);
  });
});

describe("reduceUpdates: what closes an open bubble", () => {
  it("a tool_call closes the answer bubble, so later text starts a new one", () => {
    const items = reduceUpdates([answer("before"), toolCall(), answer("after")]);
    expect(kinds(items)).toEqual(["answer", "tool", "answer"]);
    expect(texts(items)).toEqual(["before", "after"]);
  });

  it("a plan closes the answer bubble", () => {
    const items = reduceUpdates([
      answer("before"),
      { sessionUpdate: "plan", entries: [{ content: "step" }] },
      answer("after"),
    ]);
    expect(kinds(items)).toEqual(["answer", "plan", "answer"]);
    expect(texts(items)).toEqual(["before", "after"]);
  });

  it("a user message closes the answer bubble", () => {
    const items = reduceUpdates([answer("turn one"), user("next question"), answer("turn two")]);
    expect(kinds(items)).toEqual(["answer", "you", "answer"]);
    expect(texts(items)).toEqual(["turn one", "next question", "turn two"]);
  });

  it("a tool_call closes the thought bubble too", () => {
    const items = reduceUpdates([thought("before"), toolCall(), thought("after")]);
    expect(kinds(items)).toEqual(["thought", "tool", "thought"]);
    expect(texts(items)).toEqual(["before", "after"]);
  });

  it("a tool_call_update does NOT close the answer bubble", () => {
    // A status change is not a content interruption: it spreads `...state` and so
    // keeps the bubble open. The live path agrees — it doesn't reset `openBubbles`
    // on tool_call_update either.
    const items = reduceUpdates([toolCall(), answer("still "), toolUpdate({ status: "completed" }), answer("me")]);
    expect(kinds(items)).toEqual(["tool", "answer"]);
    expect(texts(items)).toEqual(["still me"]);
  });

  it("reopens with a fresh id after a close, not the previous bubble's id", () => {
    const items = reduceUpdates([answer("a"), toolCall(), answer("b")]);
    const ids = items.filter(isText).map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("reduceUpdates: user messages", () => {
  it("renders a whole user message as one bubble", () => {
    // Real captures show user messages arriving whole — the longest consecutive
    // run of user_message_chunk observed was 1. That single-chunk case is what
    // this pins. The multi-chunk case is deliberately NOT tested here: the code
    // would emit one bubble per chunk, and that is an open question, not a
    // decided behaviour worth locking in. See the report.
    const items = reduceUpdates([user("fix the build")]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "you", text: "fix the build" });
  });

  it("treats a user chunk with no content as empty text", () => {
    const items = reduceUpdates([{ sessionUpdate: "user_message_chunk" }]);
    expect(items[0]).toMatchObject({ kind: "you", text: "" });
  });

  it("keeps separate user turns as separate bubbles", () => {
    const items = reduceUpdates([user("first"), answer("ok"), user("second")]);
    expect(kinds(items)).toEqual(["you", "answer", "you"]);
    expect(texts(items)).toEqual(["first", "ok", "second"]);
  });
});

describe("reduceUpdates: tool calls", () => {
  it("renders a tool call with its id, title and status", () => {
    // toMatchObject, not toEqual: ToolFields (lib/toolMeta.ts) also carries
    // meta/content/locations/rawInput/rawOutput now. This test's job is only to
    // pin id/kind/title/status — the x.ai/tool _meta cases below pin the rest.
    const items = reduceUpdates([toolCall({ status: "in_progress" })]);
    expect(items[0]).toMatchObject({
      id: "t1",
      kind: "tool",
      title: "Reading src/App.tsx",
      status: "in_progress",
    });
  });

  it("defaults a replayed tool call to completed", () => {
    // Replay is the past: a stored tool call without a status has finished. The
    // live path deliberately defaults the SAME field to "in_progress", because
    // live is the present. Both are pinned so a refactor can't quietly unify them.
    const items = reduceUpdates([toolCall()]);
    expect(items[0]).toMatchObject({ status: "completed" });
  });

  it("falls back to the tool kind when there is no title", () => {
    const items = reduceUpdates([toolCall({ title: undefined, kind: "read" })]);
    expect(items[0]).toMatchObject({ title: "read" });
  });

  it("falls back to 'Working' when there is neither title nor kind", () => {
    const items = reduceUpdates([toolCall({ title: undefined, kind: undefined })]);
    expect(items[0]).toMatchObject({ title: "Working" });
  });

  it("synthesises an id from the stream position when toolCallId is absent", () => {
    const items = reduceUpdates([answer("x"), toolCall({ toolCallId: undefined })]);
    expect(items[1]).toMatchObject({ kind: "tool", id: "tool-1" });
  });

  it("keeps two distinct tool calls as two items", () => {
    const items = reduceUpdates([toolCall({ toolCallId: "t1" }), toolCall({ toolCallId: "t2" })]);
    expect(items.filter(isTool)).toHaveLength(2);
  });
});

describe("reduceUpdates: tool_call_update mutates in place", () => {
  it("advances the status of the matching tool call", () => {
    const items = reduceUpdates([toolCall({ status: "pending" }), toolUpdate({ status: "completed" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "t1", status: "completed" });
  });

  it("revises the title of the matching tool call", () => {
    const items = reduceUpdates([toolCall(), toolUpdate({ title: "Read 120 lines" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: "Read 120 lines" });
  });

  it("keeps the existing status when the update omits one", () => {
    const items = reduceUpdates([toolCall({ status: "in_progress" }), toolUpdate({ title: "New title" })]);
    expect(items[0]).toMatchObject({ status: "in_progress", title: "New title" });
  });

  it("keeps the existing title when the update omits one", () => {
    const items = reduceUpdates([toolCall({ title: "Original" }), toolUpdate({ status: "failed" })]);
    expect(items[0]).toMatchObject({ title: "Original", status: "failed" });
  });

  it("does nothing for a toolCallId that was never opened", () => {
    const items = reduceUpdates([toolCall({ toolCallId: "t1" }), toolUpdate({ toolCallId: "ghost" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "t1", title: "Reading src/App.tsx" });
  });

  it("does nothing when it arrives before its tool_call", () => {
    // Out of order: the update lands first and has nothing to mutate. It must
    // not conjure a tool item out of an update.
    const items = reduceUpdates([toolUpdate({ status: "completed" })]);
    expect(items).toEqual([]);
  });

  it("only touches the tool call it names", () => {
    const items = reduceUpdates([
      toolCall({ toolCallId: "t1", status: "pending" }),
      toolCall({ toolCallId: "t2", status: "pending" }),
      toolUpdate({ toolCallId: "t2", status: "completed" }),
    ]);
    expect(items.filter(isTool).map((i) => i.status)).toEqual(["pending", "completed"]);
  });

  it("does not mistake a text bubble for the tool it names", () => {
    const items = reduceUpdates([answer("a"), toolUpdate({ toolCallId: "ans-0", status: "failed" })]);
    expect(items[0]).toMatchObject({ kind: "answer", text: "a" });
  });
});

describe("reduceUpdates: x.ai/tool _meta flows through to the ToolItem", () => {
  // grok's ACP stream carries a richer, non-standard `_meta["x.ai/tool"]` block
  // alongside the plain ACP title/kind fields. reduceUpdates must not just read
  // title/status — it has to go through toolFieldsFromCall/mergeToolUpdate
  // (lib/toolMeta.ts) so that block's label/readOnly survive into the item the
  // card renders, and survive a later tool_call_update that completes the call.

  it("carries meta.source, meta.label and meta.readOnly off the initial tool_call", () => {
    const items = reduceUpdates([toolCallWithXaiMeta({ status: "in_progress" })]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "t1",
      kind: "tool",
      status: "in_progress",
      meta: { source: "x.ai/tool", label: "Reading App.tsx", readOnly: true },
    });
  });

  it("keeps meta.readOnly and meta.label, and merges status/content, once a tool_call_update completes it", () => {
    const items = reduceUpdates([
      toolCallWithXaiMeta({ status: "in_progress" }),
      // The wire's tool_call_update `content` is an ARRAY of ToolCallContent,
      // not the single ContentBlock bridge.ts types SessionUpdate.content as for
      // message chunks — toolMeta.ts casts through that mismatch on purpose
      // (see bridge.ts's ToolCallContent doc comment), so this fixture must too.
      toolUpdate({
        status: "completed",
        content: [{ type: "text", text: "export function App() {}" }],
      } as unknown as Partial<SessionUpdate>),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "t1",
      kind: "tool",
      status: "completed",
      meta: { source: "x.ai/tool", label: "Reading App.tsx", readOnly: true },
      content: [{ type: "text", text: "export function App() {}" }],
    });
  });

  it("does not let a plain-ACP tool_call_update erase the readOnly/label the tool_call established", () => {
    // The update below revises only the title — mergeToolUpdate must not
    // overwrite meta with something that has lost readOnly/label just because
    // this particular update carries no x.ai/tool block of its own.
    const items = reduceUpdates([
      toolCallWithXaiMeta({ status: "in_progress" }),
      toolUpdate({ title: "Read 40 lines" }),
    ]);
    expect(items[0]).toMatchObject({
      title: "Read 40 lines",
      meta: { readOnly: true, label: "Reading App.tsx" },
    });
  });
});

describe("reduceUpdates: the plan is one card, updated in place", () => {
  it("renders a plan with its entries", () => {
    const entries = [{ content: "Read the file", status: "completed" }, { content: "Edit it", status: "pending" }];
    const items = reduceUpdates([{ sessionUpdate: "plan", entries }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "plan", entries });
  });

  it("replaces the plan rather than stacking a second card", () => {
    // grok resends the whole plan as steps advance. Two cards would be two plans.
    const items = reduceUpdates([
      { sessionUpdate: "plan", entries: [{ content: "step", status: "pending" }] },
      { sessionUpdate: "plan", entries: [{ content: "step", status: "completed" }] },
    ]);
    expect(items.filter(isPlan)).toHaveLength(1);
    expect(items[0]).toMatchObject({ entries: [{ content: "step", status: "completed" }] });
  });

  it("keeps the plan in its original position when it is replaced", () => {
    const items = reduceUpdates([
      { sessionUpdate: "plan", entries: [{ content: "v1" }] },
      answer("working on it"),
      { sessionUpdate: "plan", entries: [{ content: "v2" }] },
    ]);
    expect(kinds(items)).toEqual(["plan", "answer"]);
    expect(items[0]).toMatchObject({ entries: [{ content: "v2" }] });
  });

  it("survives a plan with no entries", () => {
    const items = reduceUpdates([{ sessionUpdate: "plan" }]);
    expect(items[0]).toMatchObject({ kind: "plan", entries: [] });
  });

  it("survives an empty entries array", () => {
    const items = reduceUpdates([{ sessionUpdate: "plan", entries: [] }]);
    expect(items[0]).toMatchObject({ kind: "plan", entries: [] });
  });
});

describe("reduceUpdates: a whole replayed conversation", () => {
  // The shape a real `session/load` replays: the user asks, the agent thinks,
  // plans, works, and answers — then the next turn does it again.
  const stream: SessionUpdate[] = [
    user("add a README"),
    thought("I should "),
    thought("look first"),
    { sessionUpdate: "plan", entries: [{ content: "Inspect repo", status: "in_progress" }] },
    toolCall({ toolCallId: "t1", title: "Listing files", status: "in_progress" }),
    toolUpdate({ toolCallId: "t1", status: "completed" }),
    answer("I'll add "),
    answer("a README."),
    toolCall({ toolCallId: "t2", title: "Writing README.md" }),
    answer("Done."),
    user("thanks"),
    answer("Any time."),
  ];

  it("produces the transcript in stream order", () => {
    expect(kinds(reduceUpdates(stream))).toEqual([
      "you",
      "thought",
      "plan",
      "tool",
      "answer",
      "tool",
      "answer",
      "you",
      "answer",
    ]);
  });

  it("accumulates each bubble's text correctly", () => {
    expect(texts(reduceUpdates(stream))).toEqual([
      "add a README",
      "I should look first",
      "I'll add a README.",
      "Done.",
      "thanks",
      "Any time.",
    ]);
  });

  it("leaves every rendered item with a unique id", () => {
    // Ids become React keys. Duplicates silently drop or reorder rows.
    const items = reduceUpdates(stream);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries the tool_call_update through to the finished tool", () => {
    // toMatchObject for the same reason as above: the tool items also carry
    // meta/content/locations now, which this test isn't about.
    const items = reduceUpdates(stream);
    const tools = items.filter(isTool);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ id: "t1", kind: "tool", title: "Listing files", status: "completed" });
    expect(tools[1]).toMatchObject({ id: "t2", kind: "tool", title: "Writing README.md", status: "completed" });
  });

  it("is a pure function of its input", () => {
    // It runs on every conversation open; a reducer that mutated its input would
    // corrupt the replay buffer it was handed.
    const snapshot = JSON.parse(JSON.stringify(stream));
    reduceUpdates(stream);
    expect(stream).toEqual(snapshot);
  });

  it("gives the same answer twice for the same input", () => {
    expect(reduceUpdates(stream)).toEqual(reduceUpdates(stream));
  });
});
