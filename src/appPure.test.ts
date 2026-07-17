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
  type Item,
  type Tab,
} from "./App";

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
