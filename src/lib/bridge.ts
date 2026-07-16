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

export const authStatus = () => invoke<AuthStatus>("auth_status");
export const installGrok = () => invoke<string>("install_grok");
/// Recent projects, read out of the Grok CLI's own session store.
export const recentProjects = () => invoke<Project[]>("recent_projects");
export const connect = (cwd: string) => invoke<ConnectResult>("connect", { cwd });
export const authenticate = (methodId: string) => invoke<void>("authenticate", { methodId });
export const openSession = (cwd: string) => invoke<string>("open_session", { cwd });
export const sendPrompt = (text: string) => invoke<void>("send_prompt", { text });
export const cancelRun = () => invoke<void>("cancel");

/// Answer an open ACP permission request. `optionId: null` rejects it.
export const respondPermission = (requestId: number, optionId: string | null) =>
  invoke<void>("respond_permission", { requestId, optionId });

/// Answer a hook-gated tool call (the default-deny PreToolUse bridge). This is
/// the path that actually fires today; `respondPermission` is the inert ACP one.
export const respondHook = (toolUseId: string, allow: boolean) =>
  invoke<void>("respond_hook", { toolUseId, allow });

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
  onUpdate: (u: SessionUpdate) => void;
  onPermission: (req: PermissionRequest) => void;
  onTurnEnd: (result: { stopReason?: string }) => void;
  onError: (message: string) => void;
  onClosed: () => void;
};

/// Subscribe to the agent stream. Returns a disposer that detaches every listener.
export async function subscribe(h: Handlers): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<AcpUpdate>("acp-update", (e) => e.payload?.update && h.onUpdate(e.payload.update)),
    listen<PermissionRequest>("acp-permission", (e) => e.payload && h.onPermission(e.payload)),
    listen<{ stopReason?: string }>("acp-turn-end", (e) => h.onTurnEnd(e.payload ?? {})),
    listen<{ message?: string }>("acp-error", (e) => h.onError(e.payload?.message ?? "Something went wrong")),
    listen("acp-closed", () => h.onClosed()),
  ]);
  return () => offs.forEach((off) => off());
}
