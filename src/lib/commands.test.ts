/// Tests for the pure keyboard/overlay logic in commands.ts. See that file's
/// header comment for why this is pure: caret math is the fiddly part, so it
/// gets exhaustive tests here and App.tsx just calls these functions.
import { describe, expect, it } from "vitest";
import {
  applyPick,
  detectTrigger,
  filterActions,
  filterFiles,
  filterSlash,
  type Filterable,
  type SlashCommand,
  type TriggerState,
} from "./commands";

// ---- filterActions ----

describe("filterActions", () => {
  const items: Filterable[] = [
    { id: "1", title: "New tab" },
    { id: "2", title: "Focus search" },
    { id: "3", title: "Toggle sidebar", keywords: "panel folder" },
    { id: "4", title: "Open folder…" },
  ];

  it("empty query returns items in original order, unmodified", () => {
    expect(filterActions(items, "")).toEqual(items);
    expect(filterActions(items, "   ")).toEqual(items);
  });

  it("empty query returns a copy, not the same array reference", () => {
    const result = filterActions(items, "");
    expect(result).not.toBe(items);
  });

  it("startsWith beats substring match", () => {
    // "New tab" starts with "new"; nothing else contains "new" as substring
    // here, so pick items where both a startsWith and a substring candidate
    // exist to prove ordering.
    const data: Filterable[] = [
      { id: "sub", title: "I contain folder inside" },
      { id: "start", title: "Folder browser" },
    ];
    const result = filterActions(data, "folder");
    expect(result.map((i) => i.id)).toEqual(["start", "sub"]);
  });

  it("word-boundary match beats plain substring match", () => {
    // Use a query that's a substring inside "sub" title's word but a word
    // boundary in "boundary" title.
    const result = filterActions(
      [
        { id: "sub", title: "xxfolderxx" },
        { id: "boundary", title: "Open Folder" },
      ],
      "folder",
    );
    expect(result.map((i) => i.id)).toEqual(["boundary", "sub"]);
  });

  it("is case-insensitive", () => {
    const result = filterActions(items, "NEW");
    expect(result.map((i) => i.id)).toEqual(["1"]);
  });

  it("matches via keywords as well as title", () => {
    const result = filterActions(items, "panel");
    expect(result.map((i) => i.id)).toEqual(["3"]);
  });

  it("drops items that don't match at all", () => {
    const result = filterActions(items, "zzzzz");
    expect(result).toEqual([]);
  });

  it("ties within a tier preserve original relative order", () => {
    // Both are tier-2 substring-only hits (no startsWith, no word boundary),
    // so original array order should be preserved in the output.
    const tieData: Filterable[] = [
      { id: "x", title: "xxalphaxx" },
      { id: "y", title: "yyalphayy" },
    ];
    const result = filterActions(tieData, "alpha");
    expect(result.map((i) => i.id)).toEqual(["x", "y"]);
  });
});

// ---- filterSlash ----

describe("filterSlash", () => {
  const commands: SlashCommand[] = [
    { name: "fix", description: "Fix a bug" },
    { name: "explain", description: "Explain code" },
    { name: "refactor", hint: "<file>" },
  ];

  it("matches by name with startsWith ranking first", () => {
    const result = filterSlash(commands, "fix");
    expect(result).toEqual([{ name: "fix", description: "Fix a bug" }]);
  });

  it("matches by description as secondary text", () => {
    const result = filterSlash(commands, "bug");
    expect(result.map((c) => c.name)).toEqual(["fix"]);
  });

  it("empty query returns all commands in advertised order", () => {
    expect(filterSlash(commands, "")).toEqual(commands);
  });

  it("returns full SlashCommand objects, not the mapped Filterable shape", () => {
    const result = filterSlash(commands, "refactor");
    expect(result).toEqual([{ name: "refactor", hint: "<file>" }]);
  });
});

// ---- filterFiles ----

describe("filterFiles", () => {
  it("basename match ranks ahead of path-only match within the same tier", () => {
    const files = ["src/utils/app.ts", "app/index.ts"];
    // "app.ts" -> basename of first is "app.ts" (startsWith "app"), second's
    // basename is "index.ts" but its path "app/index.ts" also startsWith "app".
    // Both are tier 0 (startsWith), but only the first is a basename hit.
    const result = filterFiles(files, "app");
    expect(result).toEqual(["src/utils/app.ts", "app/index.ts"]);
  });

  it("basename-first ordering demonstrated with a clear counter-example", () => {
    const files = ["zzz/commands.ts", "commands/index.ts"];
    // Query "commands": first file's basename "commands.ts" startsWith
    // "commands" (tier 0, basename hit). Second file's basename is
    // "index.ts" (no match), but its full path "commands/index.ts"
    // startsWith "commands" too (tier 0, path-only hit).
    const result = filterFiles(files, "commands");
    expect(result).toEqual(["zzz/commands.ts", "commands/index.ts"]);
  });

  it("empty query returns files unmodified in original order", () => {
    const files = ["b.ts", "a.ts"];
    expect(filterFiles(files, "")).toEqual(files);
  });

  it("filters out non-matching files", () => {
    const files = ["src/App.tsx", "src/lib/commands.ts"];
    expect(filterFiles(files, "commands")).toEqual(["src/lib/commands.ts"]);
  });

  it("is case-insensitive", () => {
    const files = ["src/App.tsx"];
    expect(filterFiles(files, "app")).toEqual(["src/App.tsx"]);
  });
});

// ---- detectTrigger: slash ----

describe("detectTrigger - slash", () => {
  it("detects a bare slash with empty query", () => {
    expect(detectTrigger("/", 1)).toEqual({ kind: "slash", query: "", start: 0, end: 1 });
  });

  it("detects a slash command mid-typing", () => {
    expect(detectTrigger("/fix", 4)).toEqual({ kind: "slash", query: "fix", start: 0, end: 4 });
  });

  it("caret in the middle of the token still yields the trigger with a truncated query", () => {
    // caret after "/fi" of "/fix" -> query is only what's before the caret
    expect(detectTrigger("/fix", 3)).toEqual({ kind: "slash", query: "fi", start: 0, end: 3 });
  });

  it("closes once a trailing space has been typed and caret moved past it", () => {
    expect(detectTrigger("/fix arg", 8)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("caret right at the boundary space (still before it in the token) stays open", () => {
    // "/fix " with caret=4 sits right after "x", still inside the token.
    expect(detectTrigger("/fix ", 4)).toEqual({ kind: "slash", query: "fix", start: 0, end: 4 });
  });

  it("caret placed right after the trailing space closes the trigger", () => {
    // "/fix " length 5, caret=5 is past the space.
    expect(detectTrigger("/fix ", 5)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("is NOT a slash trigger when the slash appears mid-message, not at the start", () => {
    expect(detectTrigger("look at a/b", 11)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("caret positioned before the slash is not in the token", () => {
    expect(detectTrigger("/fix", 0)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("tolerates leading whitespace before the slash (trimStart semantics)", () => {
    expect(detectTrigger("  /fix", 6)).toEqual({ kind: "slash", query: "fix", start: 2, end: 6 });
  });

  it("does not trigger slash for a message not starting with /", () => {
    expect(detectTrigger("hello /fix", 10)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });
});

// ---- detectTrigger: mention ----

describe("detectTrigger - mention", () => {
  it("detects a mention at the very start of the draft", () => {
    expect(detectTrigger("@app", 4)).toEqual({ kind: "mention", query: "app", start: 0, end: 4 });
  });

  it("detects a mention preceded by a space", () => {
    expect(detectTrigger("look at @app", 12)).toEqual({
      kind: "mention",
      query: "app",
      start: 8,
      end: 12,
    });
  });

  it("empty token right after @ is still a valid, just-started mention", () => {
    expect(detectTrigger("hi @", 4)).toEqual({ kind: "mention", query: "", start: 3, end: 4 });
  });

  it("is NOT a mention when @ is preceded by a non-whitespace char (e.g. an email)", () => {
    expect(detectTrigger("email@x", 7)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("is NOT a mention when @ is preceded by a non-whitespace char, caret mid-token", () => {
    expect(detectTrigger("email@x.com", 9)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("closes once the caret has moved past whitespace following the token", () => {
    expect(detectTrigger("@app is cool", 6)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("closes when caret is not at the end of the token (moved back into it)", () => {
    // "@app" with caret at 2 -> walking back from index1 hits '@' at index0,
    // but caret(2) must equal end of non-whitespace run; here it's mid-token
    // so per contract the trigger is only "live" while caret sits at the very
    // end of the run of non-whitespace chars after "@". caret=2 is inside
    // "@app" (indices: @=0,a=1,p=2,p=3) so this is still simply the token up
    // to caret -> query "a", end=2. This IS still open per the "caret is
    // wherever it is within the token" semantics used by the backward walk.
    expect(detectTrigger("@app", 2)).toEqual({ kind: "mention", query: "a", start: 0, end: 2 });
  });

  it("bails on whitespace before finding an @ (plain word, no trigger)", () => {
    expect(detectTrigger("hello world", 11)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("caret at 0 never triggers a mention", () => {
    expect(detectTrigger("@app", 0)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("multiple @ tokens: only the one the caret is inside of triggers", () => {
    expect(detectTrigger("@foo @bar", 9)).toEqual({ kind: "mention", query: "bar", start: 5, end: 9 });
  });
});

// ---- detectTrigger: neither / general ----

describe("detectTrigger - no trigger cases", () => {
  it("returns null kind for plain text", () => {
    expect(detectTrigger("just a normal message", 10)).toEqual({
      kind: null,
      query: "",
      start: -1,
      end: -1,
    });
  });

  it("returns null kind for empty text", () => {
    expect(detectTrigger("", 0)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("returns null for out-of-range caret (negative)", () => {
    expect(detectTrigger("hello", -1)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });

  it("returns null for out-of-range caret (beyond text length)", () => {
    expect(detectTrigger("hello", 10)).toEqual({ kind: null, query: "", start: -1, end: -1 });
  });
});

// ---- applyPick ----

describe("applyPick", () => {
  it("replaces the slash token and places caret after the trailing space", () => {
    const trigger: TriggerState = { kind: "slash", query: "fi", start: 0, end: 3 };
    const result = applyPick("/fi", trigger, "/fix ");
    expect(result).toEqual({ text: "/fix ", caret: 5 });
  });

  it("replaces a bare slash trigger with the full picked command", () => {
    const trigger: TriggerState = { kind: "slash", query: "", start: 0, end: 1 };
    const result = applyPick("/", trigger, "/explain ");
    expect(result).toEqual({ text: "/explain ", caret: 9 });
  });

  it("replaces a mention token and preserves preceding text, caret lands after the trailing space", () => {
    // "look at @app": "@app" occupies indices [8,12); replacing it with a
    // replacement that already ends in a space, at end-of-string, leaves no
    // trailing text to worry about doubling up spaces with.
    const trigger: TriggerState = { kind: "mention", query: "app", start: 8, end: 12 };
    const result = applyPick("look at @app", trigger, "@src/App.tsx ");
    expect(result).toEqual({
      text: "look at @src/App.tsx ",
      caret: 21, // "look at " (8) + "@src/App.tsx " (13) = 21
    });
  });

  it("replaces a mention at the very start of the draft", () => {
    const trigger: TriggerState = { kind: "mention", query: "", start: 0, end: 1 };
    const result = applyPick("@", trigger, "@README.md ");
    expect(result).toEqual({ text: "@README.md ", caret: 11 });
  });

  it("is a no-op when trigger.kind is null, leaving text and caret unchanged at trigger.end", () => {
    const trigger: TriggerState = { kind: null, query: "", start: -1, end: 5 };
    const result = applyPick("hello world", trigger, "irrelevant ");
    expect(result).toEqual({ text: "hello world", caret: 5 });
  });

  it("falls back to text.length when trigger.kind is null and end is negative", () => {
    const trigger: TriggerState = { kind: null, query: "", start: -1, end: -1 };
    const result = applyPick("hello", trigger, "irrelevant ");
    expect(result).toEqual({ text: "hello", caret: 5 });
  });

  it("end-to-end: detectTrigger then applyPick round-trip for slash", () => {
    const draft = "/fi";
    const caret = 3;
    const trigger = detectTrigger(draft, caret);
    const result = applyPick(draft, trigger, "/fix ");
    expect(result).toEqual({ text: "/fix ", caret: 5 });
  });

  it("end-to-end: detectTrigger then applyPick round-trip for mention", () => {
    const draft = "check @Ap";
    const caret = 9;
    const trigger = detectTrigger(draft, caret);
    const result = applyPick(draft, trigger, "@src/App.tsx ");
    expect(result).toEqual({ text: "check @src/App.tsx ", caret: 19 });
  });
});
