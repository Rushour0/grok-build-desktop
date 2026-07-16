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

export const authStatus = () => invoke<AuthStatus>("auth_status");
export const installGrok = () => invoke<string>("install_grok");
export const connect = (cwd: string) => invoke<ConnectResult>("connect", { cwd });
export const authenticate = (methodId: string) => invoke<void>("authenticate", { methodId });
export const openSession = (cwd: string) => invoke<string>("open_session", { cwd });
export const sendPrompt = (text: string) => invoke<void>("send_prompt", { text });
export const cancelRun = () => invoke<void>("cancel");

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

// ---- events (Rust -> webview) ----

type Handlers = {
  onUpdate: (u: SessionUpdate) => void;
  onTurnEnd: (result: { stopReason?: string }) => void;
  onError: (message: string) => void;
  onClosed: () => void;
};

/// Subscribe to the agent stream. Returns a disposer that detaches every listener.
export async function subscribe(h: Handlers): Promise<UnlistenFn> {
  const offs = await Promise.all([
    listen<AcpUpdate>("acp-update", (e) => e.payload?.update && h.onUpdate(e.payload.update)),
    listen<{ stopReason?: string }>("acp-turn-end", (e) => h.onTurnEnd(e.payload ?? {})),
    listen<{ message?: string }>("acp-error", (e) => h.onError(e.payload?.message ?? "Something went wrong")),
    listen("acp-closed", () => h.onClosed()),
  ]);
  return () => offs.forEach((off) => off());
}
