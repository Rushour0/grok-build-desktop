import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import {
  CONNECT_COPY,
  INSTALL_COPY,
  authLine,
  connectLineFor,
  folderName,
  isAsk,
  isFiniteNumber,
  isImagePath,
  isPlan,
  isText,
  isTool,
  isUsage,
  sessionDate,
  sessionRows,
  splitSnippet,
  type Item,
  type Tab,
} from "./App";
import type { SearchHit, SessionMeta } from "./lib/bridge";

/// A tab in its resting state. Each test overrides only the fields it is about.
function tab(over: Partial<Tab> = {}): Tab {
  return {
    id: "tab-1",
    cwd: "/repo/app",
    sessionId: null,
    loadingSessionId: null,
    title: null,
    items: [],
    busy: false,
    draft: "",
    attachments: [],
    usageTokens: 0,
    needsAuth: false,
    authMethods: [],
    connecting: false,
    connectLine: null,
    connectShowLine: false,
    connectShowCancel: false,
    authPending: null,
    error: null,
    ...over,
  };
}

// ---- connectLineFor ----

describe("connectLineFor: the 400ms line gate", () => {
  it("says nothing when nothing is in flight", () => {
    expect(connectLineFor(tab())).toBeNull();
  });

  it("says nothing before the gate opens, even with a line ready", () => {
    // The whole point of the gate: a warm connect beats it, and a line that
    // appears and vanishes inside 400ms reads as a glitch rather than progress.
    expect(connectLineFor(tab({ connecting: true, connectShowLine: false, connectLine: "Starting Grok Build…" })))
      .toBeNull();
  });

  it("falls back to generic copy once the gate opens with no stage yet", () => {
    // `acp-connect` is decoration and may never arrive; the wait still needs words.
    expect(connectLineFor(tab({ connecting: true, connectShowLine: true }))).toBe("Connecting to your project…");
  });

  it("shows the stage line once the gate is open and a stage has landed", () => {
    expect(
      connectLineFor(tab({ connecting: true, connectShowLine: true, connectLine: "Opening your project…" })),
    ).toBe("Opening your project…");
  });

  it("says nothing once the promise has settled, even if the gate stayed open", () => {
    // `endConnect` clears `connecting` first; a stale line must not outlive it.
    expect(
      connectLineFor(tab({ connecting: false, connectShowLine: true, connectLine: "Almost ready…" })),
    ).toBeNull();
  });

  it("ignores the cancel gate — the two gates are independent", () => {
    expect(connectLineFor(tab({ connecting: true, connectShowLine: false, connectShowCancel: true }))).toBeNull();
  });
});

// ---- authLine ----

describe("authLine: the sign-in state machine", () => {
  it("says nothing when no sign-in is pending", () => {
    expect(authLine(tab())).toBeNull();
  });

  it("says nothing while contacting — under 1.5s there is nothing to report", () => {
    // The `contacting` vs `browser` split is the app's own 1.5s timer. A warm
    // sign-in returns before it fires, so promising a browser window would be a
    // promise about something that never happens.
    expect(authLine(tab({ authPending: "contacting" }))).toBeNull();
  });

  it("promises the browser window once the 1.5s timer has fired", () => {
    expect(authLine(tab({ authPending: "browser" }))).toBe(
      "A browser window will open — finish signing in there.",
    );
  });

  it("keeps the browser copy even while a connect is somehow in flight", () => {
    // `browser` is checked first and wins; it is the more specific thing to say.
    expect(
      authLine(tab({ authPending: "browser", connecting: true, connectShowLine: true, connectLine: "Almost ready…" })),
    ).toBe("A browser window will open — finish signing in there.");
  });

  it("shows the connect stage during the post-auth openSession wait", () => {
    expect(
      authLine(tab({ authPending: "opening", connecting: true, connectShowLine: true, connectLine: "Almost ready…" })),
    ).toBe("Almost ready…");
  });

  it("covers the 400ms before the connect gate opens with its own fallback", () => {
    // `finishSignIn` arms `beginConnect` in the same breath as `opening`, so for
    // 400ms `connectLineFor` returns null and this fallback is all there is.
    expect(authLine(tab({ authPending: "opening", connecting: true, connectShowLine: false }))).toBe(
      "Connecting to your project…",
    );
  });

  it("still speaks during `opening` if no connect was armed at all", () => {
    expect(authLine(tab({ authPending: "opening" }))).toBe("Connecting to your project…");
  });

  it("does not rename the wait when the connect gate opens", () => {
    // The invariant the source comment calls out: authLine's fallback must be the
    // exact line connectLineFor then falls back to. If these two strings ever
    // drift apart, the wait silently renames itself mid-flight.
    const beforeGate = authLine(tab({ authPending: "opening", connecting: true, connectShowLine: false }));
    const afterGate = authLine(tab({ authPending: "opening", connecting: true, connectShowLine: true }));
    expect(beforeGate).toBe(afterGate);
  });
});

// ---- copy tables ----

describe("CONNECT_COPY", () => {
  it("names every stage Rust actually emits", () => {
    expect(Object.keys(CONNECT_COPY).sort()).toEqual(
      ["handshaking", "needs_auth", "ready", "session", "spawning"].sort(),
    );
  });

  it("has no copy for `failed` — the rejected promise owns every error", () => {
    // Deliberate absence. `onConnect` skips unrecognized stages, so adding copy
    // here would put a second, competing error message on the screen.
    expect(CONNECT_COPY.failed).toBeUndefined();
  });

  it("gives an unknown stage no copy, so the previous line survives", () => {
    expect(CONNECT_COPY.some_future_stage).toBeUndefined();
  });

  it("has non-empty copy for every stage", () => {
    for (const [stage, line] of Object.entries(CONNECT_COPY)) {
      expect(line, `stage "${stage}"`).not.toBe("");
    }
  });
});

describe("INSTALL_COPY", () => {
  it("names every installer stage", () => {
    expect(Object.keys(INSTALL_COPY).sort()).toEqual(
      ["configuring", "downloading", "installing", "resolving"].sort(),
    );
  });

  it("keeps `installing` present — onInstall uses it as the fallback", () => {
    // `INSTALL_COPY[event.stage ?? ""] ?? INSTALL_COPY.installing`. Remove this
    // key and an unrecognized stage renders `undefined` as the status line.
    expect(INSTALL_COPY.installing).toBeTruthy();
  });

  it("has no copy for an unknown stage, so the fallback takes over", () => {
    expect(INSTALL_COPY.some_future_stage).toBeUndefined();
  });

  it("promises no percentage anywhere — nothing reports a total", () => {
    // Any number here would be invented. This is a claim about honesty, not style.
    for (const line of Object.values(INSTALL_COPY)) {
      expect(line).not.toMatch(/%|\d+\s*(of|\/)\s*\d+/);
    }
  });
});

// ---- sessionDate ----

describe("sessionDate", () => {
  it("formats a valid ISO timestamp as a date", () => {
    const out = sessionDate("2026-07-17T10:30:00Z");
    expect(out).not.toBe("2026-07-17T10:30:00Z");
    expect(out).toMatch(/\d/);
  });

  it("shows a date only, never a time", () => {
    // `toLocaleDateString`, not `toLocaleString`. Swapping them would put a clock
    // on every sidebar row. No date locale uses a colon; every time format does.
    expect(sessionDate("2026-07-17T10:30:00Z")).not.toMatch(/:/);
  });

  it("returns unparseable input verbatim rather than 'Invalid Date'", () => {
    expect(sessionDate("not a date")).toBe("not a date");
  });

  it("returns an empty string unchanged", () => {
    expect(sessionDate("")).toBe("");
  });

  it("returns a nonsense timestamp unchanged", () => {
    expect(sessionDate("2026-13-45T99:99:99Z")).toBe("2026-13-45T99:99:99Z");
  });

  it("is stable for the same input", () => {
    expect(sessionDate("2026-07-17T10:30:00Z")).toBe(sessionDate("2026-07-17T10:30:00Z"));
  });
});

// ---- folderName ----

describe("folderName", () => {
  it("takes the last segment of a posix path", () => {
    expect(folderName("/repo/app")).toBe("app");
  });

  it("ignores a trailing slash", () => {
    expect(folderName("/repo/app/")).toBe("app");
  });

  it("collapses repeated separators", () => {
    expect(folderName("/repo//app")).toBe("app");
  });

  it("handles a bare name with no separator", () => {
    expect(folderName("app")).toBe("app");
  });

  it("takes the last segment of a windows path", () => {
    expect(folderName("C:\\repo\\app")).toBe("app");
  });

  it("handles mixed separators", () => {
    expect(folderName("C:/repo\\app")).toBe("app");
  });

  it("returns the filename when given a file path", () => {
    // It doubles as the basename for attachment chips, not just for folders.
    expect(folderName("/repo/app/src/main.ts")).toBe("main.ts");
  });

  it("falls back to the input when there are no segments", () => {
    expect(folderName("/")).toBe("/");
  });

  it("returns an empty string for an empty path", () => {
    expect(folderName("")).toBe("");
  });
});

// ---- isImagePath ----

describe("isImagePath", () => {
  it.each(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"])("recognizes .%s", (ext) => {
    expect(isImagePath(`/repo/app/shot.${ext}`)).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isImagePath("/repo/app/SHOT.PNG")).toBe(true);
  });

  it("accepts a mixed-case extension", () => {
    expect(isImagePath("/repo/app/shot.JpEg")).toBe(true);
  });

  it("rejects a non-image extension", () => {
    expect(isImagePath("/repo/app/notes.txt")).toBe(false);
  });

  it("rejects a source file", () => {
    expect(isImagePath("/repo/app/src/main.ts")).toBe(false);
  });

  it("rejects an extensionless path", () => {
    expect(isImagePath("/repo/app/README")).toBe(false);
  });

  it("rejects an empty path", () => {
    expect(isImagePath("")).toBe(false);
  });

  it("anchors at the end — an image name inside a text file is not an image", () => {
    expect(isImagePath("/repo/app/photo.png.txt")).toBe(false);
  });

  it("requires the dot", () => {
    expect(isImagePath("/repo/app/png")).toBe(false);
  });

  it("rejects a truncated extension", () => {
    expect(isImagePath("/repo/app/a.jpe")).toBe(false);
  });

  it("accepts a dotfile that is an image", () => {
    expect(isImagePath("/repo/app/.icon.png")).toBe(true);
  });
});

// ---- isFiniteNumber ----

describe("isFiniteNumber", () => {
  it("accepts zero", () => {
    // The one that matters: 0 is falsy but is a real token count. A `||` here
    // would drop a legitimate zero and the usage line would lie.
    expect(isFiniteNumber(0)).toBe(true);
  });

  it("accepts a positive number", () => {
    expect(isFiniteNumber(1234)).toBe(true);
  });

  it("accepts a negative number", () => {
    expect(isFiniteNumber(-1)).toBe(true);
  });

  it("rejects undefined", () => {
    expect(isFiniteNumber(undefined)).toBe(false);
  });

  it("rejects NaN", () => {
    expect(isFiniteNumber(NaN)).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(isFiniteNumber(Infinity)).toBe(false);
  });

  it("rejects -Infinity", () => {
    expect(isFiniteNumber(-Infinity)).toBe(false);
  });
});

// ---- type guards ----

describe("item type guards", () => {
  const tool: Item = { id: "t", kind: "tool", title: "Reading", status: "completed" };
  const ask: Item = {
    id: "p",
    kind: "ask",
    req: { requestId: 1, options: [] },
    decided: null,
    failed: null,
  };
  const plan: Item = { id: "plan", kind: "plan", entries: [] };
  const usage: Item = { id: "u", kind: "usage", totalTokens: 10 };
  const answer: Item = { id: "a", kind: "answer", text: "hi" };
  const thoughtItem: Item = { id: "th", kind: "thought", text: "hmm" };
  const you: Item = { id: "y", kind: "you", text: "do it" };
  const error: Item = { id: "e", kind: "error", text: "boom" };
  const all = [tool, ask, plan, usage, answer, thoughtItem, you, error];

  it("isTool matches only tool items", () => {
    expect(all.filter(isTool)).toEqual([tool]);
  });

  it("isAsk matches only ask items", () => {
    expect(all.filter(isAsk)).toEqual([ask]);
  });

  it("isPlan matches only plan items", () => {
    expect(all.filter(isPlan)).toEqual([plan]);
  });

  it("isUsage matches only usage items", () => {
    expect(all.filter(isUsage)).toEqual([usage]);
  });

  it("isText matches every text-bearing kind and nothing else", () => {
    // isText is defined as the negative space of the other four, so it is the one
    // that silently changes meaning when a new Item variant is added.
    expect(all.filter(isText)).toEqual([answer, thoughtItem, you, error]);
  });

  it("the five guards partition every item exactly once", () => {
    // TranscriptItems dispatches on these in order. An item matching two guards
    // would render twice; one matching none would vanish.
    for (const item of all) {
      const hits = [isTool, isAsk, isPlan, isUsage, isText].filter((guard) => guard(item));
      expect(hits, `kind "${item.kind}"`).toHaveLength(1);
    }
  });
});

// ---- splitSnippet ----
//
// Rust marks matched terms with STX/ETX (U+0002/U+0003) rather than brackets, because a
// snippet is verbatim transcript text and transcripts are full of real brackets. These
// tests pin that contract from the reading end: the markers must never reach the DOM,
// and text that merely looks like a marker must never be emphasised.

const OPEN = "";
const CLOSE = "";

describe("splitSnippet", () => {
  it("marks the matched run and leaves the rest plain", () => {
    expect(splitSnippet(`store the ${OPEN}data${CLOSE} somewhere`)).toEqual([
      { text: "store the ", mark: false },
      { text: "data", mark: true },
      { text: " somewhere", mark: false },
    ]);
  });

  it("marks every matched run, not just the first", () => {
    expect(splitSnippet(`${OPEN}data${CLOSE} and more ${OPEN}data${CLOSE}`)).toEqual([
      { text: "data", mark: true },
      { text: " and more ", mark: false },
      { text: "data", mark: true },
    ]);
  });

  it("never emits a marker into the output", () => {
    // The one thing that must not happen: a control character reaching the DOM.
    for (const part of splitSnippet(`a ${OPEN}b${CLOSE} c ${OPEN}d${CLOSE}`)) {
      expect(part.text).not.toContain(OPEN);
      expect(part.text).not.toContain(CLOSE);
    }
  });

  it("leaves brackets in the transcript alone", () => {
    // The whole reason the delimiters aren't `[`/`]`. This is prose, not a match.
    expect(splitSnippet("see [the docs](url) about it")).toEqual([
      { text: "see [the docs](url) about it", mark: false },
    ]);
  });

  it("handles a snippet with no match markers at all", () => {
    expect(splitSnippet("plain text")).toEqual([{ text: "plain text", mark: false }]);
    expect(splitSnippet("")).toEqual([]);
  });

  it("marks a run that opens the snippet or closes it", () => {
    expect(splitSnippet(`${OPEN}data${CLOSE} trails`)).toEqual([
      { text: "data", mark: true },
      { text: " trails", mark: false },
    ]);
    expect(splitSnippet(`leads ${OPEN}data${CLOSE}`)).toEqual([
      { text: "leads ", mark: false },
      { text: "data", mark: true },
    ]);
  });

  it("survives unbalanced markers rather than throwing", () => {
    // A snippet is quoted prose from a file we don't control. The renderer must never be
    // the thing that breaks the sidebar, so a malformed run degrades to readable text.
    expect(() => splitSnippet(`open ${OPEN}but never closed`)).not.toThrow();
    expect(splitSnippet(`open ${OPEN}but never closed`)).toEqual([
      { text: "open ", mark: false },
      { text: "but never closed", mark: true },
    ]);
    // A stray close with nothing open: keep the words, drop the marker.
    const stray = splitSnippet(`stray ${CLOSE} close`);
    expect(stray.map((part) => part.text).join("")).toBe("stray  close");
    expect(stray.every((part) => !part.mark)).toBe(true);
  });
});

// ---- sessionRows ----

function meta(id: string, title: string): SessionMeta {
  return {
    id,
    title,
    summary: "",
    cwd: "/repo",
    created_at: "",
    updated_at: "",
    num_messages: 0,
  };
}

function hit(id: string, over: Partial<SearchHit> = {}): SearchHit {
  return { id, snippet: null, from_title: true, ...over };
}

describe("sessionRows", () => {
  const sessions = [meta("a", "Alpha"), meta("b", "Beta"), meta("c", "Gamma")];

  it("shows every conversation when there is no query", () => {
    expect(sessionRows(sessions, null, "").map((row) => row.session.id)).toEqual(["a", "b", "c"]);
    expect(sessionRows(sessions, null, "   ").map((row) => row.session.id)).toEqual(["a", "b", "c"]);
  });

  it("renders hits in the order Rust ranked them, not the list's order", () => {
    // Rust owns relevance (title hits first, then bm25). Re-sorting here would be a
    // second opinion that could quietly disagree with the half that did the searching.
    const rows = sessionRows(sessions, [hit("c"), hit("a")], "x");
    expect(rows.map((row) => row.session.id)).toEqual(["c", "a"]);
  });

  it("carries each hit's snippet onto its row", () => {
    const rows = sessionRows(sessions, [hit("a"), hit("b", { snippet: "the [x]", from_title: false })], "x");
    expect(rows[0].snippet).toBeNull();
    expect(rows[1].snippet).toBe("the [x]");
  });

  it("drops a hit for a conversation this window doesn't know", () => {
    // The content index can name a session whose summary.json we couldn't read. There is
    // no title or date to draw a row with, so it can't be rendered.
    expect(sessionRows(sessions, [hit("ghost"), hit("b")], "x").map((row) => row.session.id)).toEqual(["b"]);
  });

  it("an empty hit list is a real 'nothing matched', not a fallback", () => {
    // `[]` from Rust means the search ran and found nothing. Falling back to the local
    // title filter here would resurrect rows the backend deliberately excluded.
    expect(sessionRows(sessions, [], "alpha")).toEqual([]);
  });

  it("falls back to a local title filter only when the search itself failed", () => {
    // `null` = no usable answer from the backend. The sidebar must still work; the caller
    // shows the error alongside, because a short list passed off as the whole answer is
    // the deceptive case.
    const rows = sessionRows(sessions, null, "alpha");
    expect(rows.map((row) => row.session.id)).toEqual(["a"]);
    expect(rows[0].snippet).toBeNull();
  });

  it("the local fallback filter is case-insensitive", () => {
    expect(sessionRows(sessions, null, "ALPHA").map((row) => row.session.id)).toEqual(["a"]);
    expect(sessionRows(sessions, null, "lph").map((row) => row.session.id)).toEqual(["a"]);
  });
});
