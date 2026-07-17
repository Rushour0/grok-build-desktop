import { describe, expect, it } from "vitest";
import { mergeTask, parseNotify, type TaskItem } from "./notify";

describe("parseNotify", () => {
  it("returns null for non-object payloads", () => {
    expect(parseNotify(null)).toBeNull();
    expect(parseNotify(undefined)).toBeNull();
    expect(parseNotify("string")).toBeNull();
    expect(parseNotify(42)).toBeNull();
    expect(parseNotify([1, 2, 3])).toBeNull();
  });

  it("returns null when no tag field is present", () => {
    expect(parseNotify({ id: "abc", name: "no tag here" })).toBeNull();
  });

  it("returns null for an unknown/irrelevant tag", () => {
    expect(parseNotify({ sessionUpdate: "some_future_thing" })).toBeNull();
    expect(parseNotify({ type: "chat_message" })).toBeNull();
  });

  it("parses subagent_spawned into a running task, reading tag from sessionUpdate", () => {
    const rec = parseNotify({
      sessionUpdate: "subagent_spawned",
      subagentId: "sub-1",
      name: "Refactor bot",
    });
    expect(rec).toEqual({
      id: "sub-1",
      kind: "subagent_spawned",
      title: "Refactor bot",
      status: "running",
      detail: undefined,
    });
  });

  it("falls back to type then kind for the tag field", () => {
    const viaType = parseNotify({ type: "subagent_finished", taskId: "t1" });
    expect(viaType?.status).toBe("completed");

    const viaKind = parseNotify({ kind: "task_backgrounded", id: "t2" });
    expect(viaKind?.status).toBe("backgrounded");
  });

  it("maps all documented tags to their statuses", () => {
    const cases: [string, string][] = [
      ["subagent_spawned", "running"],
      ["subagent_progress", "running"],
      ["subagent_finished", "completed"],
      ["subagent_failed", "failed"],
      ["task_backgrounded", "backgrounded"],
      ["task_completed", "completed"],
      ["task_failed", "failed"],
      ["scheduled_task_created", "scheduled"],
      ["scheduled_task_fired", "scheduled"],
      ["scheduled_task_deleted", "scheduled"],
      ["monitor_event", "monitoring"],
    ];
    for (const [tag, status] of cases) {
      const rec = parseNotify({ sessionUpdate: tag, id: "x" });
      expect(rec?.status).toBe(status);
    }
  });

  it("falls back through id sources: subagentId, taskId, id, then synthesized", () => {
    expect(parseNotify({ sessionUpdate: "subagent_spawned", subagentId: "a", taskId: "b", id: "c" })?.id).toBe("a");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", taskId: "b", id: "c" })?.id).toBe("b");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "c" })?.id).toBe("c");

    const synthesized = parseNotify({ sessionUpdate: "subagent_spawned" });
    expect(synthesized?.id).toMatch(/^subagent_spawned-\d+$/);
  });

  it("falls back through title sources: name, description, label, title, promptText, prompt, tag", () => {
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", name: "N" })?.title).toBe("N");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", description: "D" })?.title).toBe("D");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", label: "L" })?.title).toBe("L");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", title: "T" })?.title).toBe("T");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", promptText: "P" })?.title).toBe("P");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", prompt: "PP" })?.title).toBe("PP");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1" })?.title).toBe("subagent_spawned");
  });

  it("reads an optional detail string from detail, message, or status", () => {
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", detail: "extra" })?.detail).toBe("extra");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", message: "msg" })?.detail).toBe("msg");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1", status: "at 50%" })?.detail).toBe("at 50%");
    expect(parseNotify({ sessionUpdate: "subagent_spawned", id: "1" })?.detail).toBeUndefined();
  });

  it("never throws on malformed/nested-garbage payloads", () => {
    expect(() => parseNotify({ sessionUpdate: 123 })).not.toThrow();
    expect(() => parseNotify({ sessionUpdate: {} })).not.toThrow();
    expect(() => parseNotify({ sessionUpdate: "subagent_spawned", id: {} })).not.toThrow();
    expect(parseNotify({ sessionUpdate: 123 })).toBeNull();
  });
});

describe("mergeTask", () => {
  it("stamps startedAt on first sighting", () => {
    const rec = { id: "1", kind: "subagent_spawned", title: "A", status: "running", detail: undefined };
    const tasks = mergeTask([], rec, 1000);
    expect(tasks).toEqual([{ id: "1", kind: "subagent_spawned", title: "A", status: "running", detail: undefined, startedAt: 1000 }]);
  });

  it("does not clobber startedAt on later sightings", () => {
    const first = mergeTask([], { id: "1", kind: "subagent_spawned", title: "A", status: "running" }, 1000);
    const second = mergeTask(first, { id: "1", kind: "subagent_progress", title: "A", status: "running", detail: "50%" }, 2000);
    expect(second[0].startedAt).toBe(1000);
    expect(second[0].detail).toBe("50%");
  });

  it("updates kind/title/status/detail on later sightings", () => {
    const first = mergeTask([], { id: "1", kind: "subagent_spawned", title: "A", status: "running" }, 1000);
    const second = mergeTask(first, { id: "1", kind: "subagent_finished", title: "A done", status: "completed" }, 2000);
    expect(second[0]).toEqual({
      id: "1",
      kind: "subagent_finished",
      title: "A done",
      status: "completed",
      detail: undefined,
      startedAt: 1000,
    });
  });

  it("is immutable: does not mutate the input array or its items", () => {
    const original: TaskItem[] = [{ id: "1", kind: "k", title: "t", status: "running", startedAt: 5 }];
    const snapshot = JSON.parse(JSON.stringify(original));
    const result = mergeTask(original, { id: "1", kind: "k2", title: "t2", status: "completed" }, 999);
    expect(original).toEqual(snapshot);
    expect(result).not.toBe(original);
    expect(result[0]).not.toBe(original[0]);
  });

  it("appends independent rows for distinct ids, most sightings preserving order", () => {
    let tasks: TaskItem[] = [];
    tasks = mergeTask(tasks, { id: "1", kind: "k", title: "t1", status: "running" }, 100);
    tasks = mergeTask(tasks, { id: "2", kind: "k", title: "t2", status: "running" }, 200);
    expect(tasks.map((t) => t.id)).toEqual(["1", "2"]);
    expect(tasks[0].startedAt).toBe(100);
    expect(tasks[1].startedAt).toBe(200);
  });
});
