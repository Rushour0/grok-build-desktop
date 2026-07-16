// The only file that talks to the Rust host. Everything else works in terms of
// the types below, so the transport stays swappable.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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

export const authStatus = () => invoke<AuthStatus>("auth_status");
export const installGrok = () => invoke<string>("install_grok");
/// Recent projects, read out of the Grok CLI's own session store.
export const recentProjects = () => invoke<Project[]>("recent_projects");
export const listSessions = (cwd?: string) => invoke<SessionMeta[]>("list_sessions", { cwd });
export const loadSessionUpdates = (cwd: string, sessionId: string) =>
  invoke<SessionUpdate[]>("load_session_updates", { cwd, sessionId });
export const searchSessions = (query: string, cwd?: string) =>
  invoke<string[]>("search_sessions", { query, cwd });
export const connect = (tabId: string, cwd: string) => invoke<ConnectResult>("connect", { tabId, cwd });
export const authenticate = (tabId: string, methodId: string) =>
  invoke<void>("authenticate", { tabId, methodId });
export const openSession = (tabId: string, cwd: string) => invoke<string>("open_session", { tabId, cwd });
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

// ---- events (Rust -> webview) ----

type Handlers = {
  onUpdate: (tabId: string, u: SessionUpdate) => void;
  onPermission: (tabId: string, req: PermissionRequest) => void;
  onTurnEnd: (tabId: string, result: { stopReason?: string }) => void;
  onError: (tabId: string, message: string) => void;
  onClosed: (tabId: string) => void;
};

/// Subscribe to the agent stream. Returns a disposer that detaches every listener.
export async function subscribe(h: Handlers): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<AcpUpdate>("acp-update", (e) =>
      e.payload?.update && h.onUpdate(e.payload.tabId, e.payload.update),
    ),
    listen<PermissionRequest & { tabId: string }>("acp-permission", (e) =>
      e.payload && h.onPermission(e.payload.tabId, e.payload),
    ),
    listen<{ tabId: string; stopReason?: string }>("acp-turn-end", (e) =>
      e.payload && h.onTurnEnd(e.payload.tabId, e.payload),
    ),
    listen<{ tabId: string; message?: string }>("acp-error", (e) =>
      e.payload && h.onError(e.payload.tabId, e.payload.message ?? "Something went wrong"),
    ),
    listen<{ tabId: string }>("acp-closed", (e) => e.payload && h.onClosed(e.payload.tabId)),
  ]);
  return () => offs.forEach((off) => off());
}
