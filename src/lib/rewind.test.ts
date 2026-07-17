import { describe, expect, it } from "vitest";
import type { RewindPoint } from "./bridge";
import { describeRewind, isDestructiveMode, normalizeRewindPoints } from "./rewind";

describe("normalizeRewindPoints", () => {
  it("passes through a bare array", () => {
    const points: RewindPoint[] = [{ id: "a" }, { id: "b" }];
    expect(normalizeRewindPoints(points)).toEqual(points);
  });

  it("unwraps a { points: [...] } envelope", () => {
    const points: RewindPoint[] = [{ id: "a" }];
    expect(normalizeRewindPoints({ points })).toEqual(points);
  });

  it("returns [] for null", () => {
    expect(normalizeRewindPoints(null)).toEqual([]);
  });

  it("returns [] for undefined", () => {
    expect(normalizeRewindPoints(undefined)).toEqual([]);
  });

  it("returns [] for a string", () => {
    expect(normalizeRewindPoints("junk")).toEqual([]);
  });

  it("returns [] for a number", () => {
    expect(normalizeRewindPoints(42)).toEqual([]);
  });

  it("returns [] for an unrelated object", () => {
    expect(normalizeRewindPoints({ foo: "bar" })).toEqual([]);
  });

  it("returns [] when points is present but not an array", () => {
    expect(normalizeRewindPoints({ points: "nope" })).toEqual([]);
  });

  it("filters out non-object entries inside an otherwise valid array", () => {
    const result = normalizeRewindPoints([{ id: "a" }, null, "junk", 5, { id: "b" }]);
    expect(result).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("never throws on deeply malformed input", () => {
    expect(() => normalizeRewindPoints([[1, 2], () => {}, Symbol("x")])).not.toThrow();
  });
});

describe("isDestructiveMode", () => {
  it("is false for conversation-only", () => {
    expect(isDestructiveMode("conversation")).toBe(false);
  });

  it("is true for files", () => {
    expect(isDestructiveMode("files")).toBe(true);
  });

  it("is true for both", () => {
    expect(isDestructiveMode("both")).toBe(true);
  });
});

describe("describeRewind", () => {
  it("describes a conversation-only restore as non-destructive", () => {
    const sentence = describeRewind({}, "conversation");
    expect(sentence).toContain("removes later messages");
    expect(sentence).not.toContain("can't be undone");
    expect(sentence).toContain("won't be touched");
  });

  it("describes a files restore with a known file count", () => {
    const sentence = describeRewind({ fileChangeCount: 3 }, "files");
    expect(sentence).toContain("restores 3 file changes");
    expect(sentence).toContain("can't be undone");
  });

  it("uses singular 'change' for a count of 1", () => {
    const sentence = describeRewind({ fileChangeCount: 1 }, "both");
    expect(sentence).toContain("restores 1 file change ");
  });

  it("degrades gracefully when fileChangeCount is missing", () => {
    const sentence = describeRewind({}, "files");
    expect(sentence).toContain("may restore files");
    expect(sentence).toContain("can't be undone");
  });

  it("degrades gracefully when promptText is missing", () => {
    const sentence = describeRewind({}, "both");
    expect(sentence).toContain("this point");
  });

  it("includes a truncated prompt preview when promptText is present", () => {
    const sentence = describeRewind({ promptText: "fix the login bug please" }, "conversation");
    expect(sentence).toContain("fix the login bug please");
  });

  it("truncates a very long promptText", () => {
    const longPrompt = "x".repeat(200);
    const sentence = describeRewind({ promptText: longPrompt }, "conversation");
    expect(sentence).toContain("…");
    expect(sentence.length).toBeLessThan(longPrompt.length + 100);
  });

  it("never throws when fields are unexpected types", () => {
    const junky = { fileChangeCount: "three", promptText: 12345 } as unknown as RewindPoint;
    expect(() => describeRewind(junky, "both")).not.toThrow();
  });

  it("treats mode='both' as destructive with the same wording as 'files'", () => {
    const both = describeRewind({ fileChangeCount: 2 }, "both");
    const files = describeRewind({ fileChangeCount: 2 }, "files");
    expect(both).toBe(files);
  });
});
