import { beforeEach, describe, expect, it, vi } from "vitest";

// The bridge is the only file that talks to Rust, so these tests exist to pin the
// *contract*: command names and argument keys. Tauri maps a camelCase JS key onto
// a snake_case Rust parameter, which means a typo here fails at runtime in a
// packaged app and nowhere earlier. Nothing below lets a real `invoke` or a real
// `listen` run.

const invoke = vi.fn();
const listen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ listen: (...args: unknown[]) => listen(...args) }),
}));

import {
  type AcpNotify,
  type AvailableCommand,
  authStatus,
  authenticate,
  busySessions,
  cancelRun,
  connect,
  grokVersion,
  installGrok,
  listProjectFiles,
  listSessions,
  loadSession,
  openProject,
  openSession,
  pendingResume,
  readonlyTools,
  recentProjects,
  respondHook,
  respondPermission,
  rewindExecute,
  rewindPoints,
  searchSessions,
  type SessionModelInfo,
  type SessionUpdate,
  sendPrompt,
  shutdownAll,
  subscribe,
  windowProject,
} from "./bridge";

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("commands: name and argument contract", () => {
  it("auth_status takes no arguments", async () => {
    await authStatus();
    expect(invoke).toHaveBeenCalledWith("auth_status");
  });

  it("install_grok takes no arguments", async () => {
    await installGrok();
    expect(invoke).toHaveBeenCalledWith("install_grok");
  });

  it("recent_projects takes no arguments", async () => {
    await recentProjects();
    expect(invoke).toHaveBeenCalledWith("recent_projects");
  });

  it("window_project takes no arguments", async () => {
    await windowProject();
    expect(invoke).toHaveBeenCalledWith("window_project");
  });

  it("pending_resume takes no arguments", async () => {
    await pendingResume();
    expect(invoke).toHaveBeenCalledWith("pending_resume");
  });

  it("busy_sessions takes no arguments", async () => {
    await busySessions();
    expect(invoke).toHaveBeenCalledWith("busy_sessions");
  });

  it("shutdown_all takes no arguments", async () => {
    await shutdownAll();
    expect(invoke).toHaveBeenCalledWith("shutdown_all");
  });

  it("open_project passes cwd", async () => {
    await openProject("/repo/app");
    expect(invoke).toHaveBeenCalledWith("open_project", { cwd: "/repo/app" });
  });

  it("list_sessions passes the cwd it was given", async () => {
    await listSessions("/repo/app");
    expect(invoke).toHaveBeenCalledWith("list_sessions", { cwd: "/repo/app" });
  });

  it("list_sessions sends cwd: undefined for the every-conversation case", async () => {
    // `undefined` is the None arm of Rust's `Option<String>` — the sidebar's
    // "every conversation on this machine" query. Sending null or "" instead
    // would ask for the sessions of a folder that doesn't exist.
    await listSessions();
    expect(invoke).toHaveBeenCalledWith("list_sessions", { cwd: undefined });
  });

  it("search_sessions passes query and cwd", async () => {
    await searchSessions("migrate", "/repo/app");
    expect(invoke).toHaveBeenCalledWith("search_sessions", { query: "migrate", cwd: "/repo/app" });
  });

  it("search_sessions scopes to every folder when cwd is omitted", async () => {
    await searchSessions("migrate");
    expect(invoke).toHaveBeenCalledWith("search_sessions", { query: "migrate", cwd: undefined });
  });

  it("connect passes tabId and cwd", async () => {
    await connect("tab-1", "/repo/app");
    expect(invoke).toHaveBeenCalledWith("connect", { tabId: "tab-1", cwd: "/repo/app" });
  });

  it("authenticate passes tabId and methodId", async () => {
    await authenticate("tab-1", "oauth");
    expect(invoke).toHaveBeenCalledWith("authenticate", { tabId: "tab-1", methodId: "oauth" });
  });

  it("open_session passes tabId and cwd", async () => {
    await openSession("tab-1", "/repo/app");
    expect(invoke).toHaveBeenCalledWith("open_session", { tabId: "tab-1", cwd: "/repo/app" });
  });

  it("load_session passes tabId, cwd and sessionId", async () => {
    await loadSession("tab-1", "/repo/app", "sess-9");
    expect(invoke).toHaveBeenCalledWith("load_session", {
      tabId: "tab-1",
      cwd: "/repo/app",
      sessionId: "sess-9",
    });
  });

  it("send_prompt passes tabId and text", async () => {
    await sendPrompt("tab-1", "fix the build");
    expect(invoke).toHaveBeenCalledWith("send_prompt", { tabId: "tab-1", text: "fix the build" });
  });

  it("cancelRun invokes the command named `cancel`, not `cancel_run`", async () => {
    // The JS name and the Rust name genuinely differ here; that's the whole
    // reason this one is worth a test.
    await cancelRun("tab-1");
    expect(invoke).toHaveBeenCalledWith("cancel", { tabId: "tab-1" });
  });

  it("respond_permission passes tabId, requestId and optionId", async () => {
    await respondPermission("tab-1", 42, "allow");
    expect(invoke).toHaveBeenCalledWith("respond_permission", {
      tabId: "tab-1",
      requestId: 42,
      optionId: "allow",
    });
  });

  it("respond_permission sends optionId: null to reject", async () => {
    // null is the rejection, and it must survive as null rather than being
    // coerced to undefined and read as "no answer".
    await respondPermission("tab-1", 42, null);
    expect(invoke).toHaveBeenCalledWith("respond_permission", {
      tabId: "tab-1",
      requestId: 42,
      optionId: null,
    });
  });

  it("respond_permission preserves requestId 0", async () => {
    // A falsy-but-real JSON-RPC id. Any `||` in this path would turn it into
    // something else and answer the wrong request.
    await respondPermission("tab-1", 0, "allow");
    expect(invoke).toHaveBeenCalledWith("respond_permission", {
      tabId: "tab-1",
      requestId: 0,
      optionId: "allow",
    });
  });

  it("respond_hook passes allow: true for an approval", async () => {
    await respondHook("tab-1", "toolu_01", true);
    expect(invoke).toHaveBeenCalledWith("respond_hook", {
      tabId: "tab-1",
      toolUseId: "toolu_01",
      allow: true,
    });
  });

  it("respond_hook passes allow: false for a denial", async () => {
    // This is the gate. A denial that arrives as anything other than `false`
    // is an edit the user refused and got anyway.
    await respondHook("tab-1", "toolu_01", false);
    expect(invoke).toHaveBeenCalledWith("respond_hook", {
      tabId: "tab-1",
      toolUseId: "toolu_01",
      allow: false,
    });
  });

  it("list_project_files passes cwd", async () => {
    await listProjectFiles("/repo/app");
    expect(invoke).toHaveBeenCalledWith("list_project_files", { cwd: "/repo/app" });
  });

  it("grok_version takes no arguments", async () => {
    await grokVersion();
    expect(invoke).toHaveBeenCalledWith("grok_version");
  });

  it("readonly_tools takes no arguments", async () => {
    await readonlyTools();
    expect(invoke).toHaveBeenCalledWith("readonly_tools");
  });

  it("rewind_points passes tabId", async () => {
    await rewindPoints("tab-1");
    expect(invoke).toHaveBeenCalledWith("rewind_points", { tabId: "tab-1" });
  });

  it("rewind_execute passes tabId, pointId and mode", async () => {
    await rewindExecute("tab-1", "point-9", "conversation");
    expect(invoke).toHaveBeenCalledWith("rewind_execute", {
      tabId: "tab-1",
      pointId: "point-9",
      mode: "conversation",
    });
  });

  it("rewind_execute passes the files and both destructive modes through untouched", async () => {
    // "files"/"both" are the destructive scopes — a bridge that coerced or
    // dropped this argument would silently downgrade a destructive restore to
    // the safe conversation-only one, or vice versa.
    await rewindExecute("tab-1", "point-9", "files");
    expect(invoke).toHaveBeenCalledWith("rewind_execute", {
      tabId: "tab-1",
      pointId: "point-9",
      mode: "files",
    });

    await rewindExecute("tab-1", "point-9", "both");
    expect(invoke).toHaveBeenCalledWith("rewind_execute", {
      tabId: "tab-1",
      pointId: "point-9",
      mode: "both",
    });
  });
});

describe("commands: results and failures pass through untouched", () => {
  it("resolves with the value Rust returned", async () => {
    const status = { grok_installed: true, grok_path: "/usr/local/bin/grok", has_login: true };
    invoke.mockResolvedValue(status);
    await expect(authStatus()).resolves.toEqual(status);
  });

  it("passes a null window_project through rather than defaulting it", async () => {
    // null means "launcher window" and is load-bearing; a bridge that turned it
    // into a folder would make every window claim a project.
    invoke.mockResolvedValue(null);
    await expect(windowProject()).resolves.toBeNull();
  });

  it("passes a null pending_resume through", async () => {
    invoke.mockResolvedValue(null);
    await expect(pendingResume()).resolves.toBeNull();
  });

  it("passes busy_sessions 0 through as 0", async () => {
    invoke.mockResolvedValue(0);
    await expect(busySessions()).resolves.toBe(0);
  });

  it("rejects when Rust rejects, without swallowing the error", async () => {
    // Callers in App.tsx decide what a failure means (`.catch(() => null)` in
    // some places, an error card in others). The bridge must not decide for them.
    invoke.mockRejectedValue(new Error("That window was closed."));
    await expect(connect("tab-1", "/repo/app")).rejects.toThrow("That window was closed.");
  });

  it("resolves grok_version with the trimmed version string", async () => {
    invoke.mockResolvedValue("grok 0.2.101");
    await expect(grokVersion()).resolves.toBe("grok 0.2.101");
  });

  it("rejects grok_version rather than returning empty on failure (HANDOFF #3)", async () => {
    invoke.mockRejectedValue(new Error("grok not found"));
    await expect(grokVersion()).rejects.toThrow("grok not found");
  });

  it("resolves readonly_tools with the allowlist Rust returned", async () => {
    const tools = ["read_file", "list_dir", "grep"];
    invoke.mockResolvedValue(tools);
    await expect(readonlyTools()).resolves.toEqual(tools);
  });

  it("resolves rewind_points with whatever shape Rust returned, untouched", async () => {
    // The wire shape is unverified headlessly (raw serde_json::Value on the
    // Rust side) — the bridge must not guess at [points] vs {points:[...]}.
    // Normalizing is rewind.ts's job, not the bridge's.
    const raw = { points: [{ id: "p1", promptText: "fix the build" }] };
    invoke.mockResolvedValue(raw);
    await expect(rewindPoints("tab-1")).resolves.toEqual(raw);
  });

  it("rejects rewind_points when Rust rejects", async () => {
    invoke.mockRejectedValue(new Error("No session yet — sign in and pick a folder first."));
    await expect(rewindPoints("tab-1")).rejects.toThrow("No session yet");
  });

  it("rejects rewind_execute when Rust rejects", async () => {
    invoke.mockRejectedValue(new Error("No folder open yet — pick a project folder first."));
    await expect(rewindExecute("tab-1", "point-9", "both")).rejects.toThrow("No folder open yet");
  });
});

// ---- subscribe ----

type Handler = (event: { payload: unknown }) => void;

/// Register `listen` so each call records its event name and handler, and hand
/// back a way to fire an event and a per-listener unlisten spy.
function captureListeners() {
  const handlers = new Map<string, Handler>();
  const unlisteners: ReturnType<typeof vi.fn>[] = [];
  listen.mockImplementation((name: string, handler: Handler) => {
    handlers.set(name, handler);
    const off = vi.fn();
    unlisteners.push(off);
    return Promise.resolve(off);
  });
  return {
    emit: (name: string, payload: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`no listener registered for "${name}"`);
      handler({ payload });
    },
    names: () => [...handlers.keys()],
    unlisteners,
  };
}

/// Every handler `subscribe` accepts, each a spy. Optional ones included.
function spyHandlers() {
  return {
    onUpdate: vi.fn(),
    onPermission: vi.fn(),
    onTurnEnd: vi.fn(),
    onError: vi.fn(),
    onClosed: vi.fn(),
    onAuth: vi.fn(),
    onConnect: vi.fn(),
    onInstall: vi.fn(),
    onSessionInfo: vi.fn(),
    onNotify: vi.fn(),
  };
}

describe("subscribe: wiring", () => {
  it("listens on the window, never on the app-global event bus", async () => {
    // The boundary: Rust routes per-window events with `emit_to(&key.window, ..)`.
    // A global listener would show one window another window's stream. This test
    // fails if `listen` is ever imported from `@tauri-apps/api/event` directly —
    // that module is mocked to nothing here, so a global call would throw.
    const capture = captureListeners();
    await subscribe(spyHandlers());
    expect(listen).toHaveBeenCalledTimes(10);
    expect(capture.names()).toHaveLength(10);
  });

  it("registers exactly the ten known event names", async () => {
    const capture = captureListeners();
    await subscribe(spyHandlers());
    expect(capture.names().sort()).toEqual(
      [
        "acp-auth",
        "acp-closed",
        "acp-connect",
        "acp-error",
        "acp-install",
        "acp-notify",
        "acp-permission",
        "acp-session-info",
        "acp-turn-end",
        "acp-update",
      ].sort(),
    );
  });

  it("returns a disposer that detaches every listener", async () => {
    const capture = captureListeners();
    const off = await subscribe(spyHandlers());
    off();
    expect(capture.unlisteners).toHaveLength(10);
    for (const unlisten of capture.unlisteners) expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("subscribe: event routing", () => {
  it("routes acp-update with its tabId and update", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } };
    capture.emit("acp-update", { tabId: "tab-1", sessionId: "s1", update });
    expect(h.onUpdate).toHaveBeenCalledWith("tab-1", update);
  });

  it("routes an available_commands_update, typing accepts availableCommands", async () => {
    // Compile-time contract: SessionUpdateKind includes "available_commands_update"
    // and SessionUpdate carries an optional AvailableCommand[] under
    // `availableCommands`. If either typing regresses this literal stops
    // type-checking; the runtime assertion below pins that it still flows
    // through `subscribe` untouched, same as any other update.
    const commands: AvailableCommand[] = [
      { name: "plan", description: "Draft a plan", input: { hint: "<goal>" } },
      { name: "review" },
    ];
    const update: SessionUpdate = {
      sessionUpdate: "available_commands_update",
      availableCommands: commands,
    };
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-update", { tabId: "tab-1", sessionId: "s1", update });
    expect(h.onUpdate).toHaveBeenCalledWith("tab-1", update);
  });

  it("drops an acp-update carrying no update", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-update", { tabId: "tab-1", sessionId: "s1" });
    expect(h.onUpdate).not.toHaveBeenCalled();
  });

  it("routes acp-permission with the whole request, tabId included", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    const req = { tabId: "tab-1", requestId: 7, options: [{ optionId: "allow", name: "Allow" }] };
    capture.emit("acp-permission", req);
    expect(h.onPermission).toHaveBeenCalledWith("tab-1", req);
  });

  it("routes acp-turn-end with its payload", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    const end = { tabId: "tab-1", stopReason: "end_turn", _meta: { totalTokens: 120 } };
    capture.emit("acp-turn-end", end);
    expect(h.onTurnEnd).toHaveBeenCalledWith("tab-1", end);
  });

  it("routes acp-error with its message", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-error", { tabId: "tab-1", message: "grok exited" });
    expect(h.onError).toHaveBeenCalledWith("tab-1", "grok exited");
  });

  it("substitutes generic copy for an acp-error with no message", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-error", { tabId: "tab-1" });
    expect(h.onError).toHaveBeenCalledWith("tab-1", "Something went wrong");
  });

  it("keeps an empty-string error message rather than replacing it", async () => {
    // `??` and not `||`: "" is a message Rust chose to send. This asserts the
    // nullish-coalescing behaviour the source actually has.
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-error", { tabId: "tab-1", message: "" });
    expect(h.onError).toHaveBeenCalledWith("tab-1", "");
  });

  it("routes acp-closed with just the tabId", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-closed", { tabId: "tab-1" });
    expect(h.onClosed).toHaveBeenCalledWith("tab-1");
  });

  it("routes acp-auth with the outcome", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    const auth = { tabId: "tab-1", status: "ok", email: "a@b.c" };
    capture.emit("acp-auth", auth);
    expect(h.onAuth).toHaveBeenCalledWith("tab-1", auth);
  });

  it("routes acp-connect with the stage payload", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    const conn = { tabId: "tab-1", stage: "handshaking" };
    capture.emit("acp-connect", conn);
    expect(h.onConnect).toHaveBeenCalledWith("tab-1", conn);
  });

  it("routes acp-install without a tabId — the install is machine-wide", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    const install = { status: "stage", stage: "downloading", detail: "12%" };
    capture.emit("acp-install", install);
    expect(h.onInstall).toHaveBeenCalledWith(install);
  });

  it("routes acp-session-info's model to onSessionInfo, typing accepts SessionModelInfo", async () => {
    // Compile-time contract: SessionModelInfo's fields all stay optional and
    // nested under `model`, matching what Rust's parse_session_model extracts.
    const model: SessionModelInfo = {
      currentModelId: "grok-4",
      model: {
        name: "Grok 4",
        description: "Fast, general-purpose",
        totalContextTokens: 256000,
        supportsReasoningEffort: true,
        reasoningEffort: "high",
        reasoningEfforts: ["low", "medium", "high"],
      },
    };
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-session-info", { tabId: "tab-1", model });
    expect(h.onSessionInfo).toHaveBeenCalledWith("tab-1", model);
  });

  it("drops an acp-session-info carrying no model", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-session-info", { tabId: "tab-1" });
    expect(h.onSessionInfo).not.toHaveBeenCalled();
  });

  it("routes acp-notify with its tabId and the whole payload", async () => {
    // AcpNotify is a loose, x.ai-only shape (see bridge.ts) — subscribe must not
    // pick fields out of it, just forward the raw payload alongside the tabId.
    const notify: AcpNotify = {
      tabId: "tab-1",
      sessionUpdate: "subagent_spawned",
      subagentId: "sub-1",
      name: "researcher",
    };
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-notify", notify);
    expect(h.onNotify).toHaveBeenCalledWith("tab-1", notify);
  });

  it("drops an acp-notify carrying no tabId", async () => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    capture.emit("acp-notify", { sessionUpdate: "monitor_event" });
    expect(h.onNotify).not.toHaveBeenCalled();
  });
});

describe("subscribe: absent payloads and optional handlers", () => {
  it.each([
    "acp-update",
    "acp-permission",
    "acp-turn-end",
    "acp-error",
    "acp-closed",
    "acp-auth",
    "acp-connect",
    "acp-install",
    "acp-session-info",
    "acp-notify",
  ])("survives a null payload on %s", async (event) => {
    const capture = captureListeners();
    const h = spyHandlers();
    await subscribe(h);
    expect(() => capture.emit(event, null)).not.toThrow();
    for (const spy of Object.values(h)) expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["acp-auth", { tabId: "tab-1", status: "ok" }],
    ["acp-connect", { tabId: "tab-1", stage: "ready" }],
    ["acp-install", { status: "done" }],
    ["acp-session-info", { tabId: "tab-1", model: { currentModelId: "grok-4" } }],
    ["acp-notify", { tabId: "tab-1", sessionUpdate: "monitor_event" }],
  ])("survives %s when the optional handler is omitted", async (event, payload) => {
    // onAuth/onConnect/onInstall/onSessionInfo/onNotify are optional in
    // `Handlers`. A caller that wants only the core five must not crash on an
    // event it never asked about.
    const capture = captureListeners();
    const {
      onAuth: _a,
      onConnect: _c,
      onInstall: _i,
      onSessionInfo: _s,
      onNotify: _n,
      ...core
    } = spyHandlers();
    await subscribe(core);
    expect(() => capture.emit(event, payload)).not.toThrow();
  });
});
