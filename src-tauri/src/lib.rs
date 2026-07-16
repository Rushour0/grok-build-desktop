//! Grok Build Desktop — Rust host / ACP bridge.
//!
//! Spawns the open-source Grok Build CLI (`grok agent stdio`, from
//! github.com/xai-org/grok-build) as a child process and speaks the Agent Client
//! Protocol to it: newline-delimited JSON-RPC 2.0 over the child's stdin/stdout.
//!
//!   webview --invoke--> commands here --stdin--> grok
//!   webview <--emit---- reader thread <--stdout-- grok
//!
//! The webview never sees the process; it only sees `acp-*` events.
//!
//! Handshake, verified against grok 0.2.101:
//!   initialize -> {protocolVersion, agentCapabilities, authMethods:[{id:"grok.com",...}]}
//!   session/new -> -32000 "Authentication required" until `authenticate` succeeds
//!   authenticate {methodId} -> blocks while the user completes browser sign-in
//!   session/new {cwd} -> {sessionId}

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

/// Reply channels for client->agent requests we're still waiting on, keyed by JSON-RPC id.
type Pending = Arc<Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>>;

struct Session {
    tab_id: String,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    /// None until `session/new` succeeds — auth may be required first.
    session_id: Option<String>,
    next_id: Arc<AtomicI64>,
    pending: Pending,
    /// Set to stop this session's approval-hook watcher thread.
    approval_stop: Arc<AtomicBool>,
}

impl Session {
    fn kill(mut self) {
        // Stop the approval watcher and drop the live marker so the global hook
        // stops gating this session (and never gates the user's own terminal grok).
        self.approval_stop.store(true, Ordering::SeqCst);
        if let (Some(root), Some(sid)) = (bridge_root(), self.session_id.as_ref()) {
            let _ = std::fs::remove_file(root.join("live").join(sid));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct AcpState {
    inner: Mutex<HashMap<String, Session>>,
}

#[derive(Serialize)]
struct AuthStatus {
    grok_installed: bool,
    grok_path: Option<String>,
    has_login: bool,
}

#[derive(Serialize)]
struct ConnectResult {
    needs_auth: bool,
    auth_methods: Vec<Value>,
    session_id: Option<String>,
}

#[derive(Serialize)]
struct Project {
    path: String,
    name: String,
    /// Seconds since the epoch, from the session directory's mtime.
    last_used: u64,
}

#[derive(Serialize)]
struct SessionMeta {
    id: String,
    title: String,
    summary: String,
    cwd: String,
    created_at: String,
    updated_at: String,
    num_messages: u64,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Find the `grok` binary.
///
/// A GUI app launched from Finder/Explorer does NOT inherit the shell's PATH, so
/// a bare `Command::new("grok")` finds nothing even when the CLI is installed.
/// Check the installer's known locations before falling back to PATH.
fn resolve_grok() -> Option<PathBuf> {
    if let Some(home) = home_dir() {
        let candidates = [
            home.join(".grok/bin/grok"),
            home.join(".local/bin/grok"),
            home.join(".grok/bin/grok.exe"),
        ];
        for c in candidates {
            if c.exists() {
                return Some(c);
            }
        }
    }
    for c in ["/usr/local/bin/grok", "/opt/homebrew/bin/grok"] {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    // Last resort: let the OS search PATH (works when launched from a terminal).
    Command::new("grok")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .filter(|s| s.success())
        .map(|_| PathBuf::from("grok"))
}

fn write_msg(stdin: &Arc<Mutex<ChildStdin>>, msg: &Value) -> Result<(), String> {
    let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
    let mut guard = stdin.lock().map_err(|e| e.to_string())?;
    guard.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    guard.write_all(b"\n").map_err(|e| e.to_string())?;
    guard.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn with_tab_id(mut payload: Value, tab_id: &str) -> Value {
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("tabId".into(), Value::String(tab_id.to_string()));
        payload
    } else {
        json!({"tabId": tab_id, "payload": payload})
    }
}

/// Send a client->agent request and hand back the channel its response will arrive on.
fn request(
    stdin: &Arc<Mutex<ChildStdin>>,
    pending: &Pending,
    next_id: &Arc<AtomicI64>,
    method: &str,
    params: Value,
) -> Result<Receiver<Result<Value, String>>, String> {
    let id = next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = mpsc::channel();
    pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
    write_msg(
        stdin,
        &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}),
    )?;
    Ok(rx)
}

/// Pump the agent's stdout: route responses to waiters, forward notifications to the webview.
fn spawn_reader(
    app: AppHandle,
    tab_id: String,
    stdout: ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
) {
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let msg: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue, // not JSON-RPC (banner/noise) — ignore
            };

            // No `method` => it's a response to something we asked.
            if msg.get("method").is_none() {
                if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                    let waiter = pending.lock().ok().and_then(|mut p| p.remove(&id));
                    if let Some(tx) = waiter {
                        let payload = match msg.get("error") {
                            Some(err) => Err(err
                                .get("message")
                                .and_then(Value::as_str)
                                .map(str::to_string)
                                .unwrap_or_else(|| err.to_string())),
                            None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(payload);
                    }
                }
                continue;
            }

            let method = msg.get("method").and_then(Value::as_str).unwrap_or_default();
            let params = msg.get("params").cloned().unwrap_or(Value::Null);

            match method {
                // The live stream: agent_message_chunk / agent_thought_chunk / tool_call /
                // tool_call_update / plan. The webview decides how to render each.
                "session/update" => {
                    let _ = app.emit("acp-update", with_tab_id(params, &tab_id));
                }
                // The ACP way to ask for approval. In practice grok 0.2.101 never
                // sends this over `agent stdio` (verified), so this path is inert —
                // the live gate is the PreToolUse hook watcher (see start_approval).
                // Kept because it's correct and costs nothing if a future grok does
                // send it: we leave the request open and answer via `respond_permission`.
                "session/request_permission" => {
                    let mut payload = params.clone();
                    if let (Some(obj), Some(id)) = (payload.as_object_mut(), msg.get("id")) {
                        obj.insert("requestId".into(), id.clone());
                    }
                    let _ = app.emit("acp-permission", with_tab_id(payload, &tab_id));
                }
                // Notifications we don't model yet carry no id and need no reply.
                _ => {
                    if let Some(id) = msg.get("id") {
                        let _ = write_msg(
                            &stdin,
                            &json!({
                                "jsonrpc": "2.0", "id": id,
                                "error": {"code": -32601, "message": format!("method not implemented: {method}")}
                            }),
                        );
                    }
                }
            }
        }
        let _ = app.emit(
            "acp-closed",
            json!({"tabId": tab_id, "reason": "grok stopped"}),
        );
    });
}

/// Drain stderr so a chatty agent can't fill the pipe buffer and wedge itself.
fn spawn_stderr_drain(app: AppHandle, tab_id: String, stderr: ChildStderr) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = app.emit("acp-stderr", json!({"tabId": tab_id, "line": line}));
            }
        }
    });
}

fn is_auth_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("authentication required") || m.contains("auth method") || m.contains("unauthorized")
}

// ---- Approval bridge (default-deny PreToolUse hook) --------------------------
//
// `grok agent stdio` never emits `session/request_permission` (verified against
// grok 0.2.101, with and without `[features] support_permission`), so the ACP
// permission path above is inert. The real gate is a global `PreToolUse` hook.
//
// A denylist does NOT hold: told to edit a file with `write`/`search_replace`/
// shell all denied, grok routes around it via `monitor` (an undocumented
// background-shell tool) in a single turn. Only a DEFAULT-DENY ALLOWLIST holds:
// the hook auto-allows a fixed read-only tool set and asks the user about
// everything else. This is best-effort, not a hard boundary — grok's hook runner
// FAILS OPEN if the hook process times out or crashes.
//
// Transport is files under `~/.grok/gbd-bridge/` (no ports, per the README):
//   live/<sessionId>  marker: this session is app-owned, so the hook gates it.
//   req/<toolUseId>.json   the hook drops a pending tool call here.
//   resp/<toolUseId>.json  we write {"decision": ...} here; the hook reads it.
// The hook script (installed below) speaks this protocol; we parse the JSON.

/// The read-only tools the hook auto-allows. Everything else needs approval.
/// Kept in sync with the allowlist embedded in `HOOK_SCRIPT`. Local reads only —
/// network egress (web_search/web_fetch) is intentionally excluded so it prompts.
const READONLY_TOOLS: &[&str] = &[
    "read_file",
    "list_dir",
    "grep",
    "search_tool",
    "get_command_or_subagent_output",
    "monitor_status",
];

/// The POSIX-sh hook. Uses only grep/sed (no jq) so it runs on a bare machine;
/// the real JSON parsing happens Rust-side. It default-denies by asking us.
const HOOK_SCRIPT: &str = r#"#!/bin/sh
# Installed by Grok Build Desktop. Gates only sessions the app marks live.
BRIDGE="$HOME/.grok/gbd-bridge"
INPUT=$(cat)

# Extract scalar fields from the payload prefix BEFORE "toolInput" only. grok
# emits sessionId/toolName/toolUseId ahead of toolInput, so model-controlled
# content inside toolInput (a file's bytes, a command) can never spoof them —
# e.g. writing a file whose content contains '"toolName":"read_file"'.
HEAD=${INPUT%%\"toolInput\"*}
field() { printf '%s' "$HEAD" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed "s/\"$1\":\"//;s/\"\$//"; }
SID=$(field sessionId)
TOOL=$(field toolName)
TUID=$(field toolUseId)

# Not an app-owned session (e.g. the user's own terminal grok) -> never gate.
if [ -z "$SID" ] || [ ! -f "$BRIDGE/live/$SID" ]; then
  printf '{"decision":"allow"}\n'; exit 0
fi

# Local read-only tools pass automatically. Network egress (web_search/web_fetch)
# is deliberately NOT here: it needs approval so a read+exfiltrate path can't run
# unattended. Keep in sync with READONLY_TOOLS.
case "$TOOL" in
  read_file|list_dir|grep|search_tool|get_command_or_subagent_output|monitor_status)
    printf '{"decision":"allow"}\n'; exit 0 ;;
esac

[ -n "$TUID" ] || TUID="req-$$-$(date +%s)"
REQ="$BRIDGE/req/$TUID.json"
RESP="$BRIDGE/resp/$TUID.json"
printf '%s' "$INPUT" > "$REQ.tmp" 2>/dev/null && mv "$REQ.tmp" "$REQ" 2>/dev/null

# Wait for the user's decision. Internal deadline (~500s of sleeps, plus per-loop
# overhead) stays comfortably under the hook's 600s timeout, so we return an
# explicit deny rather than being force-killed (which would fail open).
i=0
while [ "$i" -lt 5000 ]; do
  if [ -f "$RESP" ]; then
    cat "$RESP"
    rm -f "$RESP" "$REQ" 2>/dev/null
    exit 0
  fi
  sleep 0.1
  i=$((i + 1))
done
rm -f "$REQ" 2>/dev/null
printf '{"decision":"deny","reason":"Approval timed out (no answer from Grok Build Desktop)."}\n'
exit 0
"#;

fn bridge_root() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".grok/gbd-bridge"))
}

fn basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(path).to_string()
}

/// Install (or refresh) the global PreToolUse hook. Unix only for now — the sh
/// script needs a POSIX shell; Windows approval is a follow-up. Best-effort:
/// a failure here just means no gate, which is the pre-existing behavior.
#[cfg(unix)]
fn install_approval_hook() -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let hooks = home_dir().ok_or("no home dir")?.join(".grok/hooks");
    std::fs::create_dir_all(&hooks).map_err(|e| e.to_string())?;
    let script = hooks.join("gbd-approval.sh");
    std::fs::write(&script, HOOK_SCRIPT).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| e.to_string())?;
    // `{:?}` debug-formats the path as a valid, escaped JSON string.
    let cfg = format!(
        r#"{{"hooks":{{"PreToolUse":[{{"hooks":[{{"type":"command","command":{:?},"timeout":600}}]}}]}}}}"#,
        script.to_string_lossy()
    );
    std::fs::write(hooks.join("gbd-approval.json"), cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(unix))]
fn install_approval_hook() -> Result<(), String> {
    Ok(()) // Windows: edit approval is a follow-up (the sh hook needs a POSIX shell).
}

/// Turn a raw hook payload into the `acp-permission` shape the webview already
/// renders (PermissionCard). Mutating tools get a diff or command preview.
/// `tuid` is the request file's stem — the identity the hook script polls on, so
/// the answer always routes back even when the JSON `toolUseId` is absent.
fn build_permission_payload(req: &Value, tuid: &str, tab_id: &str) -> Value {
    let tool = req.get("toolName").and_then(Value::as_str).unwrap_or("");
    let input = req.get("toolInput").cloned().unwrap_or(Value::Null);
    let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("").to_string();

    let (title, content) = match tool {
        "search_replace" => (
            format!("Edit {}", basename(&s("file_path"))),
            json!([{"type": "diff", "path": s("file_path"), "oldText": s("old_string"), "newText": s("new_string")}]),
        ),
        "write" | "create_file" => (
            format!("Write {}", basename(&s("file_path"))),
            json!([{"type": "diff", "path": s("file_path"), "oldText": "", "newText": s("content")}]),
        ),
        "run_terminal_command" | "monitor" => (
            "Run a shell command".to_string(),
            json!([{"type": "command", "text": s("command")}]),
        ),
        other => (
            format!("Grok wants to use {other}"),
            json!([{"type": "command", "text": serde_json::to_string_pretty(&input).unwrap_or_default()}]),
        ),
    };

    json!({
        "tabId": tab_id,
        "requestId": 0,
        "hookToolUseId": tuid,
        "toolCall": {"title": title, "content": content},
        "options": [
            {"optionId": "allow", "name": "Allow", "kind": "allow"},
            {"optionId": "deny",  "name": "Deny",  "kind": "reject"}
        ]
    })
}

/// Prepare the bridge for a freshly-opened session: install the hook, mark this
/// session live, and start its tab-scoped approval watcher. Other sessions' bridge
/// files and live markers must remain intact while their tabs are connected.
fn start_approval(app: &AppHandle, tab_id: &str, session_id: &str, stop: Arc<AtomicBool>) {
    let Some(root) = bridge_root() else { return };
    for sub in ["req", "resp", "live"] {
        let _ = std::fs::create_dir_all(root.join(sub));
    }
    let _ = install_approval_hook(); // idempotent; also installed pre-spawn in connect()
    let _ = std::fs::write(root.join("live").join(session_id), b"1");

    let app = app.clone();
    let tab_id = tab_id.to_string();
    let session_id = session_id.to_string();
    thread::spawn(move || {
        let req_dir = root.join("req");
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        while !stop.load(Ordering::SeqCst) {
            if let Ok(entries) = std::fs::read_dir(&req_dir) {
                for e in entries.flatten() {
                    let path = e.path();
                    if path.extension().and_then(|x| x.to_str()) != Some("json") {
                        continue;
                    }
                    let name = match path.file_name().and_then(|n| n.to_str()) {
                        Some(n) if !seen.contains(n) => n.to_string(),
                        _ => continue,
                    };
                    // The file stem is the id the hook script polls its response on
                    // (`<TUID>.json`). Key everything on it, never the JSON field —
                    // the two can differ when grok omits `toolUseId`.
                    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
                    let Ok(text) = std::fs::read_to_string(&path) else { continue };
                    let Ok(reqv) = serde_json::from_str::<Value>(&text) else { continue };
                    if reqv.get("sessionId").and_then(Value::as_str) != Some(session_id.as_str()) {
                        continue;
                    }
                    seen.insert(name);
                    // Defense in depth: never prompt for a read-only tool, even if
                    // the hook script's allowlist ever drifts from READONLY_TOOLS.
                    let tool = reqv.get("toolName").and_then(Value::as_str).unwrap_or("");
                    if READONLY_TOOLS.contains(&tool) {
                        let _ = write_decision(&stem, true);
                        continue;
                    }
                    let _ = app.emit(
                        "acp-permission",
                        build_permission_payload(&reqv, &stem, &tab_id),
                    );
                }
            }
            thread::sleep(Duration::from_millis(200));
        }
    });
}

/// Write the decision the hook script is polling for (atomic via tmp+rename).
fn write_decision(tool_use_id: &str, allow: bool) -> Result<(), String> {
    let resp_dir = bridge_root().ok_or("no home dir")?.join("resp");
    std::fs::create_dir_all(&resp_dir).map_err(|e| e.to_string())?;
    let decision = if allow {
        json!({"decision": "allow"})
    } else {
        json!({"decision": "deny", "reason": "Denied in Grok Build Desktop."})
    };
    let tmp = resp_dir.join(format!("{tool_use_id}.json.tmp"));
    let final_path = resp_dir.join(format!("{tool_use_id}.json"));
    std::fs::write(&tmp, decision.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &final_path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Answer a hook-gated tool call from the webview (Allow/Deny).
#[tauri::command]
fn respond_hook(tab_id: String, tool_use_id: String, allow: bool) -> Result<(), String> {
    let _ = tab_id;
    write_decision(&tool_use_id, allow)
}

/// Ask the live agent for a session in `cwd`. Separated so it can be retried after sign-in.
fn new_session(
    app: &AppHandle,
    state: &State<AcpState>,
    tab_id: &str,
    cwd: &str,
) -> Result<Result<String, String>, String> {
    let (stdin, pending, next_id, session_tab_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard.get(tab_id).ok_or("not connected to grok")?;
        (
            s.stdin.clone(),
            s.pending.clone(),
            s.next_id.clone(),
            s.tab_id.clone(),
        )
    };
    let rx = request(
        &stdin,
        &pending,
        &next_id,
        "session/new",
        json!({"cwd": cwd, "mcpServers": []}),
    )?;
    let outcome = rx
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "grok didn't answer `session/new` in time".to_string())?;

    match outcome {
        Ok(result) => {
            let id = result
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or("grok didn't return a sessionId")?
                .to_string();
            let stop = if let Ok(mut guard) = state.inner.lock() {
                guard.get_mut(tab_id).map(|s| {
                    s.session_id = Some(id.clone());
                    s.approval_stop.clone()
                })
            } else {
                None
            };
            // Arm the approval gate for this session before the user can prompt.
            if let Some(stop) = stop {
                start_approval(app, &session_tab_id, &id, stop);
            }
            Ok(Ok(id))
        }
        Err(e) => Ok(Err(e)),
    }
}

/// Percent-decode a session directory name back into a filesystem path.
/// The CLI stores each project as `~/.grok/sessions/<percent-encoded cwd>/`.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The projects you've worked on before, read straight out of the Grok CLI's own
/// session store — we keep no list of our own, so it can never drift from reality.
#[tauri::command]
fn recent_projects() -> Vec<Project> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(home.join(".grok/sessions")) else {
        return Vec::new();
    };

    let mut projects: Vec<Project> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let path = percent_decode(&e.file_name().to_string_lossy());
            // A folder the user has since deleted or moved isn't worth offering.
            if !std::path::Path::new(&path).is_dir() {
                return None;
            }
            let last_used = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let name = std::path::Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.clone());
            Some(Project { path, name, last_used })
        })
        .collect();

    projects.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    // The list scrolls, so keep more than fits on screen.
    projects.truncate(50);
    projects
}

#[tauri::command]
fn list_sessions(cwd: Option<String>) -> Vec<SessionMeta> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let Ok(project_entries) = std::fs::read_dir(home.join(".grok/sessions")) else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    for project_entry in project_entries.flatten().filter(|entry| entry.path().is_dir()) {
        let folder_cwd = percent_decode(&project_entry.file_name().to_string_lossy());
        if cwd
            .as_deref()
            .is_some_and(|filter| filter != folder_cwd.as_str())
        {
            continue;
        }

        let Ok(session_entries) = std::fs::read_dir(project_entry.path()) else {
            continue;
        };
        for session_entry in session_entries.flatten().filter(|entry| entry.path().is_dir()) {
            let Ok(text) = std::fs::read_to_string(session_entry.path().join("summary.json")) else {
                continue;
            };
            let Ok(summary_json) = serde_json::from_str::<Value>(&text) else {
                continue;
            };

            let session_dir_name = session_entry.file_name().to_string_lossy().into_owned();
            let session_summary = summary_json
                .get("session_summary")
                .and_then(Value::as_str)
                .unwrap_or("");
            let title = summary_json
                .get("generated_title")
                .and_then(Value::as_str)
                .or_else(|| summary_json.get("session_summary").and_then(Value::as_str))
                .unwrap_or("(untitled)")
                .to_string();
            let info = summary_json.get("info");

            sessions.push(SessionMeta {
                id: info
                    .and_then(|value| value.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or(&session_dir_name)
                    .to_string(),
                title,
                summary: session_summary.to_string(),
                cwd: info
                    .and_then(|value| value.get("cwd"))
                    .and_then(Value::as_str)
                    .unwrap_or(&folder_cwd)
                    .to_string(),
                created_at: summary_json
                    .get("created_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                updated_at: summary_json
                    .get("updated_at")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                num_messages: summary_json
                    .get("num_chat_messages")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            });
        }
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

#[tauri::command]
fn load_session_updates(cwd: String, session_id: String) -> Vec<serde_json::Value> {
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let Ok(project_entries) = std::fs::read_dir(home.join(".grok/sessions")) else {
        return Vec::new();
    };
    let Some(project_dir) = project_entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .find(|entry| percent_decode(&entry.file_name().to_string_lossy()) == cwd)
        .map(|entry| entry.path())
    else {
        return Vec::new();
    };
    let Ok(file) = std::fs::File::open(project_dir.join(session_id).join("updates.jsonl")) else {
        return Vec::new();
    };

    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter(|message| message.get("method").and_then(Value::as_str) == Some("session/update"))
        .filter_map(|message| message.get("params")?.get("update").cloned())
        .collect()
}

#[tauri::command]
fn search_sessions(query: String, cwd: Option<String>) -> Vec<String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }

    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let Ok(project_entries) = std::fs::read_dir(home.join(".grok/sessions")) else {
        return Vec::new();
    };

    let mut matches = Vec::new();
    for project_entry in project_entries.flatten().filter(|entry| entry.path().is_dir()) {
        let folder_cwd = percent_decode(&project_entry.file_name().to_string_lossy());
        if cwd
            .as_deref()
            .is_some_and(|filter| filter != folder_cwd.as_str())
        {
            continue;
        }

        let Ok(session_entries) = std::fs::read_dir(project_entry.path()) else {
            continue;
        };
        for session_entry in session_entries.flatten().filter(|entry| entry.path().is_dir()) {
            let Ok(text) = std::fs::read_to_string(session_entry.path().join("summary.json")) else {
                continue;
            };
            let Ok(summary_json) = serde_json::from_str::<Value>(&text) else {
                continue;
            };

            let title_matches = summary_json
                .get("generated_title")
                .and_then(Value::as_str)
                .is_some_and(|title| title.to_lowercase().contains(&query));
            let summary_matches = summary_json
                .get("session_summary")
                .and_then(Value::as_str)
                .is_some_and(|summary| summary.to_lowercase().contains(&query));
            let history_matches = if title_matches || summary_matches {
                false
            } else {
                std::fs::read_to_string(session_entry.path().join("chat_history.jsonl"))
                    .map(|history| history.to_lowercase().contains(&query))
                    .unwrap_or(false)
            };

            if title_matches || summary_matches || history_matches {
                let session_dir_name = session_entry.file_name().to_string_lossy().into_owned();
                matches.push(
                    summary_json
                        .get("info")
                        .and_then(|value| value.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or(&session_dir_name)
                        .to_string(),
                );
            }
        }
    }

    matches
}

#[tauri::command]
fn grok_installed() -> bool {
    resolve_grok().is_some()
}

#[tauri::command]
fn auth_status() -> AuthStatus {
    let grok = resolve_grok();
    AuthStatus {
        grok_installed: grok.is_some(),
        grok_path: grok.map(|p| p.to_string_lossy().into_owned()),
        has_login: home_dir()
            .map(|h| h.join(".grok/auth.json").exists())
            .unwrap_or(false),
    }
}

/// Download and install the Grok Build CLI via xAI's official installer.
/// The user should never have to open a terminal to get started.
#[tauri::command]
fn install_grok(app: AppHandle) -> Result<String, String> {
    let _ = app.emit("acp-install", json!({"status": "started"}));

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command", "irm https://x.ai/cli/install.ps1 | iex"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("bash");
        c.args(["-lc", "curl -fsSL https://x.ai/cli/install.sh | bash"]);
        c
    };

    let out = cmd
        .output()
        .map_err(|e| format!("Couldn't run the Grok installer: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    if !out.status.success() {
        let _ = app.emit("acp-install", json!({"status": "failed", "detail": stderr}));
        return Err(format!("The Grok installer failed:\n{stderr}"));
    }
    match resolve_grok() {
        Some(p) => {
            let _ = app.emit("acp-install", json!({"status": "done"}));
            Ok(p.to_string_lossy().into_owned())
        }
        None => Err(format!(
            "The installer finished but `grok` still isn't where we expect it.\n{stdout}"
        )),
    }
}

/// Spawn `grok agent stdio` in `cwd`, do the ACP handshake, and try to open a session.
/// If the agent demands sign-in, report that instead of failing — the UI drives `authenticate`.
#[tauri::command]
fn connect(
    app: AppHandle,
    state: State<AcpState>,
    tab_id: String,
    cwd: String,
) -> Result<ConnectResult, String> {
    let existing = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&tab_id);
    if let Some(existing) = existing {
        existing.kill();
    }

    let grok = resolve_grok().ok_or(
        "Grok Build isn't installed yet. Click \"Install Grok Build\" and we'll set it up for you.",
    )?;

    // Install the approval hook BEFORE spawning grok: grok loads its hook config
    // at startup, so a hook written afterwards would miss this process's session.
    let _ = install_approval_hook();

    let mut child = Command::new(&grok)
        .arg("agent")
        .arg("stdio")
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start `grok agent stdio` ({e})."))?;

    let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("grok gave us no stdin")?));
    let stdout = child.stdout.take().ok_or("grok gave us no stdout")?;
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_drain(app.clone(), tab_id.clone(), stderr);
    }

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicI64::new(1));
    spawn_reader(
        app.clone(),
        tab_id.clone(),
        stdout,
        stdin.clone(),
        pending.clone(),
    );

    // We don't advertise fs capabilities: grok uses its own file tools rather than
    // asking us to read/write on its behalf. It does NOT ask permission over ACP —
    // approval is enforced out-of-band by our PreToolUse hook (see start_approval).
    let rx = request(
        &stdin,
        &pending,
        &next_id,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}}
        }),
    )?;
    let init = rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "grok didn't answer `initialize` in time".to_string())??;

    let auth_methods = init
        .get("authMethods")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    state.inner.lock().map_err(|e| e.to_string())?.insert(
        tab_id.clone(),
        Session {
            tab_id: tab_id.clone(),
            child,
            stdin,
            session_id: None,
            next_id,
            pending,
            approval_stop: Arc::new(AtomicBool::new(false)),
        },
    );

    // Try for a session; a fresh install will bounce us to sign-in instead.
    match new_session(&app, &state, &tab_id, &cwd)? {
        Ok(session_id) => Ok(ConnectResult {
            needs_auth: false,
            auth_methods,
            session_id: Some(session_id),
        }),
        Err(e) if is_auth_error(&e) => Ok(ConnectResult {
            needs_auth: true,
            auth_methods,
            session_id: None,
        }),
        Err(e) => Err(e),
    }
}

/// Run the agent's sign-in flow (opens the browser). Blocks until the user finishes.
#[tauri::command]
fn authenticate(state: State<AcpState>, tab_id: String, method_id: String) -> Result<(), String> {
    let (stdin, pending, next_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard.get(&tab_id).ok_or("not connected to grok")?;
        (s.stdin.clone(), s.pending.clone(), s.next_id.clone())
    };
    let rx = request(
        &stdin,
        &pending,
        &next_id,
        "authenticate",
        json!({"methodId": method_id}),
    )?;
    // Browser round-trip: the user has to actually sign in, so wait generously.
    rx.recv_timeout(Duration::from_secs(5 * 60))
        .map_err(|_| "Sign-in timed out. Try again?".to_string())??;
    Ok(())
}

/// Open a session after a successful sign-in.
#[tauri::command]
fn open_session(
    app: AppHandle,
    state: State<AcpState>,
    tab_id: String,
    cwd: String,
) -> Result<String, String> {
    new_session(&app, &state, &tab_id, &cwd)?
}

/// Answer an open `session/request_permission`. `option_id` of None means "the user
/// walked away / rejected", which cancels the tool call rather than approving it.
#[tauri::command]
fn respond_permission(
    state: State<AcpState>,
    tab_id: String,
    request_id: i64,
    option_id: Option<String>,
) -> Result<(), String> {
    let stdin = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard
            .get(&tab_id)
            .ok_or("not connected to grok")?
            .stdin
            .clone()
    };
    let outcome = match option_id {
        Some(id) => json!({"outcome": "selected", "optionId": id}),
        None => json!({"outcome": "cancelled"}),
    };
    write_msg(
        &stdin,
        &json!({"jsonrpc": "2.0", "id": request_id, "result": {"outcome": outcome}}),
    )
}

/// Send one user turn. Returns immediately — output arrives as `acp-update` events.
#[tauri::command]
fn send_prompt(
    app: AppHandle,
    state: State<AcpState>,
    tab_id: String,
    text: String,
) -> Result<(), String> {
    let (stdin, pending, next_id, session_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard
            .get(&tab_id)
            .ok_or("No folder open yet — pick a project folder first.")?;
        let id = s
            .session_id
            .clone()
            .ok_or("No session yet — sign in and pick a folder first.")?;
        (s.stdin.clone(), s.pending.clone(), s.next_id.clone(), id)
    };

    let rx = request(
        &stdin,
        &pending,
        &next_id,
        "session/prompt",
        json!({"sessionId": session_id, "prompt": [{"type": "text", "text": text}]}),
    )?;

    // The turn's stopReason lands after the update stream drains; don't block the UI on it.
    thread::spawn(move || {
        let (event, payload) = match rx.recv_timeout(Duration::from_secs(30 * 60)) {
            Ok(Ok(result)) => ("acp-turn-end", result),
            Ok(Err(e)) => ("acp-error", json!({"message": e})),
            Err(_) => ("acp-error", json!({"message": "grok stopped responding"})),
        };
        let _ = app.emit(event, with_tab_id(payload, &tab_id));
    });
    Ok(())
}

#[tauri::command]
fn cancel(state: State<AcpState>, tab_id: String) -> Result<(), String> {
    let session = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&tab_id);
    if let Some(s) = session {
        if let Some(id) = s.session_id.clone() {
            // Best-effort protocol cancel, then make sure the process is really gone.
            let _ = write_msg(
                &s.stdin,
                &json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": id}}),
            );
        }
        s.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let builder = builder
        .manage(AcpState::default())
        .invoke_handler(tauri::generate_handler![
            grok_installed,
            auth_status,
            install_grok,
            recent_projects,
            list_sessions,
            load_session_updates,
            search_sessions,
            connect,
            authenticate,
            open_session,
            respond_permission,
            respond_hook,
            send_prompt,
            cancel
        ]);

    #[cfg(desktop)]
    let builder = builder.setup(|app| {
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
        use tauri::Manager;

        let show = MenuItem::with_id(app, "show", "Show Grok Build", true, None::<&str>)?;
        let new_chat = MenuItem::with_id(app, "newchat", "New chat", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &new_chat, &quit])?;

        let mut tray = TrayIconBuilder::new()
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                "quit" => app.exit(0),
                "show" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                "newchat" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    let _ = app.emit("tray-new-chat", ());
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            });

        if let Some(icon) = app.default_window_icon().cloned() {
            tray = tray.icon(icon);
        }
        let _ = tray.build(app)?;
        Ok(())
    });

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
