import { describe, expect, it, vi } from "vitest";

// App.tsx pulls in the Tauri plugins at module scope, so importing it for one pure
// function means stubbing them. None of these are called by `toMention`; they exist
// so the import doesn't reach a real Tauri runtime that isn't there.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { toMention } from "./App";

// `toMention` turns a dropped absolute path into the @-mention that goes into the
// prompt. It is the only pure function App.tsx exports today; the reducer and the
// loader copy functions are module-private and unreachable from here.
describe("toMention: paths inside the project", () => {
  it("makes a path under the cwd relative to it", () => {
    expect(toMention("/repo/app", "/repo/app/src/main.ts")).toBe("@src/main.ts");
  });

  it("relativizes a file directly in the cwd", () => {
    expect(toMention("/repo/app", "/repo/app/README.md")).toBe("@README.md");
  });

  it("relativizes a deeply nested path", () => {
    expect(toMention("/repo/app", "/repo/app/a/b/c/d/e.ts")).toBe("@a/b/c/d/e.ts");
  });

  it("keeps a nested directory path relative", () => {
    expect(toMention("/repo/app", "/repo/app/src/lib")).toBe("@src/lib");
  });
});

describe("toMention: paths outside the project", () => {
  it("leaves an unrelated absolute path absolute", () => {
    expect(toMention("/repo/app", "/etc/hosts")).toBe("@/etc/hosts");
  });

  it("leaves a sibling folder's path absolute", () => {
    expect(toMention("/repo/app", "/repo/other/file.ts")).toBe("@/repo/other/file.ts");
  });

  it("does not relativize a sibling whose name merely starts with the cwd", () => {
    // The guard is `startsWith(`${cwd}/`)`, not `startsWith(cwd)`. Without the
    // separator "/repo/app-legacy" would become "@legacy/x.ts" — a path that
    // resolves to a real, different file inside the project.
    expect(toMention("/repo/app", "/repo/app-legacy/x.ts")).toBe("@/repo/app-legacy/x.ts");
  });

  it("does not relativize a sibling that shares the cwd's last segment prefix", () => {
    expect(toMention("/repo/app", "/repo/application/x.ts")).toBe("@/repo/application/x.ts");
  });

  it("leaves a parent-directory path absolute", () => {
    expect(toMention("/repo/app", "/repo/package.json")).toBe("@/repo/package.json");
  });
});

describe("toMention: no project", () => {
  it("leaves the path absolute when cwd is null", () => {
    expect(toMention(null, "/repo/app/src/main.ts")).toBe("@/repo/app/src/main.ts");
  });

  it("treats an empty-string cwd as no project", () => {
    // "" is falsy, so the whole relativizing branch is skipped. Worth pinning:
    // if it weren't, `"".length` slicing would silently pass the path through
    // by luck rather than by intent.
    expect(toMention("", "/repo/app/src/main.ts")).toBe("@/repo/app/src/main.ts");
  });
});

describe("toMention: quoting", () => {
  it("quotes a relative path containing a space", () => {
    // Unquoted, "@my file.ts" reads to the agent as a mention of "my" followed
    // by loose text.
    expect(toMention("/repo/app", "/repo/app/my file.ts")).toBe('@"my file.ts"');
  });

  it("quotes an absolute path containing a space", () => {
    expect(toMention("/repo/app", "/other dir/x.ts")).toBe('@"/other dir/x.ts"');
  });

  it("quotes when the space is in a parent segment", () => {
    expect(toMention("/repo/app", "/repo/app/my dir/x.ts")).toBe('@"my dir/x.ts"');
  });

  it("quotes a path with several spaces", () => {
    expect(toMention("/repo/app", "/repo/app/a b c.ts")).toBe('@"a b c.ts"');
  });

  it("does not quote a path with no space", () => {
    expect(toMention("/repo/app", "/repo/app/a-b_c.ts")).toBe("@a-b_c.ts");
  });

  it("does not quote a path whose only space was in the cwd it stripped", () => {
    // The space lives in "/my repo", which is removed. What's left needs no quotes.
    expect(toMention("/my repo/app", "/my repo/app/src/main.ts")).toBe("@src/main.ts");
  });
});
