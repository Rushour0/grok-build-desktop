// The only file that talks to the Rust host. Everything else works in terms of
// the types below, so the transport stays swappable.
import { invoke } from "@tauri-apps/api/core";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export interface AuthStatus {
  grok_installed: boolean;
  grok_path: string | null;
  has_login: boolean;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

export interface ConnectResult {
  needs_auth: boolean;
  auth_methods: AuthMethod[];
  session_id: string | null;
}

// ---- commands (webview -> Rust) ----

export interface Project {
  path: string;
  name: string;
  last_used: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  summary: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  num_messages: number;
}

/// One conversation that matched a search, and WHY it matched.
export interface SearchHit {
  id: string;
  /// The matched text in context, with `[`/`]` around the hit terms (FTS5's
  /// `snippet()` output). The sidebar renders those as emphasis, never as literal
  /// brackets — see `splitSnippet`. `null` for a title hit: the title is already
  /// the row's headline, so repeating it underneath says nothing.
  snippet: string | null;
  /// The row's visible title contains the query. These sort above content hits.
  from_title: boolean;
}

/// The answer to one search. `content_error` is the whole reason this isn't just an
/// array: title matching is done locally from data we already have, but content
/// matching reads an index owned by the grok CLI which can be missing, locked, or a
/// schema we don't know. When that half can't run, the title hits are still real and
/// still returned — so a degraded search is a SHORTER answer plus a warning, never an
/// empty list. Rendering `hits: []` with a `content_error` as "No matches" would be a
/// lie about conversations sitting on disk.
export interface SearchResults {
  hits: SearchHit[];
  content_error: string | null;
}

/// What `openProject` did with the folder. Only `"adopted"` is actionable by the
/// caller — it means *this* window had no project and has just taken this one, so
/// it should render it. `"focused"` (already open elsewhere; that window was
/// raised) and `"opened"` (a new window was built) both mean another window owns
/// the project and this one does nothing further.
export interface OpenOutcome {
  kind: "focused" | "adopted" | "opened";
  label: string;
}

export const authStatus = () => invoke<AuthStatus>("auth_status");
export const installGrok = () => invoke<string>("install_grok");
/// Recent projects, read out of the Grok CLI's own session store.
export const recentProjects = () => invoke<Project[]>("recent_projects");

/// Give a folder a window: focus the one that already has it, adopt it into this
/// window if this window has no project yet, or build a new one. Rust owns the
/// decision — the webview never picks a window label.
export const openProject = (cwd: string) => invoke<OpenOutcome>("open_project", { cwd });
/// This window's project folder, or null while it's still a launcher. We *ask*
/// rather than being told: a cwd handed to the webview and trusted back is not
/// an identity, it's a suggestion.
export const windowProject = () => invoke<string | null>("window_project");
/// The conversation this window was launched to resume (`<app> --resume <id>`), or
/// null — which is the overwhelmingly common case and means nothing at all, not an
/// error. Ask-don't-tell for the same reason as `windowProject`: the command line
/// is resolved before there is any webview to push an event to.
///
/// CONSUMING — Rust hands the id over once and forgets it. Call this exactly once,
/// on mount; polling it, or calling it from anything that remounts, gets you null
/// and a resume that silently never happens.
export const pendingResume = () => invoke<string | null>("pending_resume");

/// How many agent sessions are alive across every window. The updater's gate.
export const busySessions = () => invoke<number>("busy_sessions");
/// Tear down every session in every window, without quitting.
export const shutdownAll = () => invoke<void>("shutdown_all");

/// Omit `cwd` for every conversation on this machine; pass one to get only the
/// conversations made in that folder.
export const listSessions = (cwd?: string) => invoke<SessionMeta[]>("list_sessions", { cwd });
/// Search conversations: titles (local, 100% coverage) unioned with content (grok's
/// FTS5 index), title hits ranked first. Omit `cwd` to search every folder.
export const searchSessions = (query: string, cwd?: string) =>
  invoke<SearchResults>("search_sessions", { query, cwd });
export const connect = (tabId: string, cwd: string) => invoke<ConnectResult>("connect", { tabId, cwd });
export const authenticate = (tabId: string, methodId: string) =>
  invoke<void>("authenticate", { tabId, methodId });
export const openSession = (tabId: string, cwd: string) => invoke<string>("open_session", { tabId, cwd });
export const loadSession = (tabId: string, cwd: string, sessionId: string) =>
  invoke<string>("load_session", { tabId, cwd, sessionId });
export const sendPrompt = (tabId: string, text: string) => invoke<void>("send_prompt", { tabId, text });
export const cancelRun = (tabId: string) => invoke<void>("cancel", { tabId });

/// Answer an open ACP permission request. `optionId: null` rejects it.
export const respondPermission = (tabId: string, requestId: number, optionId: string | null) =>
  invoke<void>("respond_permission", { tabId, requestId, optionId });

/// Answer a hook-gated tool call (the default-deny PreToolUse bridge). This is
/// the path that actually fires today; `respondPermission` is the inert ACP one.
export const respondHook = (tabId: string, toolUseId: string, allow: boolean) =>
  invoke<void>("respond_hook", { tabId, toolUseId, allow });

// ---- ACP session/update payloads (Rust -> webview) ----
// Shapes verified against grok 0.2.101's `initialize` response.

export type SessionUpdateKind =
  | "agent_message_chunk"
  | "agent_thought_chunk"
  | "tool_call"
  | "tool_call_update"
  | "plan"
  | "user_message_chunk";

export interface ContentBlock {
  type: string;
  text?: string;
}

export interface SessionUpdate {
  sessionUpdate: SessionUpdateKind;
  content?: ContentBlock;
  // tool_call / tool_call_update
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  // plan
  entries?: { content: string; status?: string; priority?: string }[];
}

export interface AcpUpdate {
  tabId: string;
  sessionId: string;
  update: SessionUpdate;
}

/// A `session/request_permission` the agent is blocked on. `requestId` is the
/// JSON-RPC id the Rust host stamped on, so we can answer the exact request.
export interface PermissionRequest {
  requestId: number;
  sessionId?: string;
  /// Present when the request came from the PreToolUse hook bridge rather than
  /// ACP. Answer it with `respondHook(hookToolUseId, allow)`, not `respondPermission`.
  hookToolUseId?: string;
  toolCall?: {
    toolCallId?: string;
    title?: string;
    kind?: string;
    content?: { type: string; path?: string; oldText?: string; newText?: string; text?: string }[];
  };
  options: { optionId: string; name: string; kind?: string }[];
}

export interface TurnEnd {
  stopReason?: string;
  _meta?: {
    modelId?: string;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cachedReadTokens?: number;
    usage?: { apiDurationMs?: number };
  };
}

/// Terminal outcome of a sign-in attempt. `authenticate` resolves immediately now,
/// so this event — not the promise — is the completion signal. The wire enum is
/// exactly these three: the in-flight `contacting`/`browser` states are owned by
/// the frontend's own timer, never emitted by Rust.
export interface AcpAuth {
  tabId: string;
  status: "ok" | "failed" | "timed_out";
  message?: string;
  email?: string;
  subscriptionTier?: string;
}

/// Text-only decoration for a connect/open-session in flight. The `connect` and
/// `openSession` promises remain the source of truth; `stage` is a verbatim,
/// non-exhaustive label and must never be switched on for state.
export interface AcpConnect {
  tabId: string;
  stage: string;
  sessionId?: string;
  message?: string;
}

/// Install progress. Unlike the other two this is **global** — there is at most
/// one install and it carries no `tabId`. `detail` is a verbatim installer line;
/// `stage` is decorative.
export interface InstallEvent {
  status: "started" | "stage" | "done" | "failed";
  stage?: string;
  detail?: string;
}

// ---- events (Rust -> webview) ----

type Handlers = {
  onUpdate: (tabId: string, u: SessionUpdate) => void;
  onPermission: (tabId: string, req: PermissionRequest) => void;
  onTurnEnd: (tabId: string, result: TurnEnd) => void;
  onError: (tabId: string, message: string) => void;
  onClosed: (tabId: string) => void;
  onAuth?: (tabId: string, a: AcpAuth) => void;
  onConnect?: (tabId: string, c: AcpConnect) => void;
  onInstall?: (e: InstallEvent) => void;
};

/// Subscribe to the agent stream. Returns a disposer that detaches every listener.
///
/// Listeners are scoped to *this* window, not the app: Rust routes per-window
/// events with `emit_to(&key.window, ..)`, so a window must never see another
/// window's stream. Window-scoped listeners still receive app-wide broadcasts
/// (`acp-install` is one), so scoping costs nothing and gains the boundary.
export async function subscribe(h: Handlers): Promise<UnlistenFn> {
  const win = getCurrentWebviewWindow();
  const offs = await Promise.all([
    win.listen<AcpUpdate>("acp-update", (e) =>
      e.payload?.update && h.onUpdate(e.payload.tabId, e.payload.update),
    ),
    win.listen<PermissionRequest & { tabId: string }>("acp-permission", (e) =>
      e.payload && h.onPermission(e.payload.tabId, e.payload),
    ),
    win.listen<TurnEnd & { tabId: string }>("acp-turn-end", (e) =>
      e.payload && h.onTurnEnd(e.payload.tabId, e.payload),
    ),
    win.listen<{ tabId: string; message?: string }>("acp-error", (e) =>
      e.payload && h.onError(e.payload.tabId, e.payload.message ?? "Something went wrong"),
    ),
    win.listen<{ tabId: string }>("acp-closed", (e) => e.payload && h.onClosed(e.payload.tabId)),
    win.listen<AcpAuth>("acp-auth", (e) => e.payload && h.onAuth?.(e.payload.tabId, e.payload)),
    win.listen<AcpConnect>("acp-connect", (e) => e.payload && h.onConnect?.(e.payload.tabId, e.payload)),
    win.listen<InstallEvent>("acp-install", (e) => e.payload && h.onInstall?.(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}
