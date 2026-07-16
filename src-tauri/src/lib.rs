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
use std::sync::atomic::{AtomicI64, Ordering};
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
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    /// None until `session/new` succeeds — auth may be required first.
    session_id: Option<String>,
    next_id: Arc<AtomicI64>,
    pending: Pending,
}

impl Session {
    fn kill(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct AcpState {
    inner: Mutex<Option<Session>>,
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
fn spawn_reader(app: AppHandle, stdout: ChildStdout, stdin: Arc<Mutex<ChildStdin>>, pending: Pending) {
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
                    let _ = app.emit("acp-update", params);
                }
                // The agent wants approval before touching a file. We deliberately do
                // NOT answer here: the JSON-RPC request stays open while the user looks
                // at the diff, and `respond_permission` sends their actual decision.
                // Nothing is written to disk until they say so.
                "session/request_permission" => {
                    let mut payload = params.clone();
                    if let (Some(obj), Some(id)) = (payload.as_object_mut(), msg.get("id")) {
                        obj.insert("requestId".into(), id.clone());
                    }
                    let _ = app.emit("acp-permission", payload);
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
        let _ = app.emit("acp-closed", json!({"reason": "grok stopped"}));
    });
}

/// Drain stderr so a chatty agent can't fill the pipe buffer and wedge itself.
fn spawn_stderr_drain(app: AppHandle, stderr: ChildStderr) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = app.emit("acp-stderr", json!({ "line": line }));
            }
        }
    });
}

fn is_auth_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("authentication required") || m.contains("auth method") || m.contains("unauthorized")
}

/// Ask the live agent for a session in `cwd`. Separated so it can be retried after sign-in.
fn new_session(state: &State<AcpState>, cwd: &str) -> Result<Result<String, String>, String> {
    let (stdin, pending, next_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard.as_ref().ok_or("not connected to grok")?;
        (s.stdin.clone(), s.pending.clone(), s.next_id.clone())
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
            if let Ok(mut guard) = state.inner.lock() {
                if let Some(s) = guard.as_mut() {
                    s.session_id = Some(id.clone());
                }
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
    projects.truncate(8);
    projects
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
fn connect(app: AppHandle, state: State<AcpState>, cwd: String) -> Result<ConnectResult, String> {
    if let Ok(mut g) = state.inner.lock() {
        if let Some(existing) = g.take() {
            existing.kill();
        }
    }

    let grok = resolve_grok().ok_or(
        "Grok Build isn't installed yet. Click \"Install Grok Build\" and we'll set it up for you.",
    )?;

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
        spawn_stderr_drain(app.clone(), stderr);
    }

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicI64::new(1));
    spawn_reader(app.clone(), stdout, stdin.clone(), pending.clone());

    // We don't advertise fs capabilities: grok uses its own file tools (which it
    // asks permission for) rather than asking us to read/write on its behalf.
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

    *state.inner.lock().map_err(|e| e.to_string())? = Some(Session {
        child,
        stdin,
        session_id: None,
        next_id,
        pending,
    });

    // Try for a session; a fresh install will bounce us to sign-in instead.
    match new_session(&state, &cwd)? {
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
fn authenticate(state: State<AcpState>, method_id: String) -> Result<(), String> {
    let (stdin, pending, next_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard.as_ref().ok_or("not connected to grok")?;
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
fn open_session(state: State<AcpState>, cwd: String) -> Result<String, String> {
    new_session(&state, &cwd)?
}

/// Answer an open `session/request_permission`. `option_id` of None means "the user
/// walked away / rejected", which cancels the tool call rather than approving it.
#[tauri::command]
fn respond_permission(
    state: State<AcpState>,
    request_id: i64,
    option_id: Option<String>,
) -> Result<(), String> {
    let stdin = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard.as_ref().ok_or("not connected to grok")?.stdin.clone()
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
fn send_prompt(app: AppHandle, state: State<AcpState>, text: String) -> Result<(), String> {
    let (stdin, pending, next_id, session_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard.as_ref().ok_or("No folder open yet — pick a project folder first.")?;
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
        let _ = app.emit(event, payload);
    });
    Ok(())
}

#[tauri::command]
fn cancel(state: State<AcpState>) -> Result<(), String> {
    let session = state.inner.lock().map_err(|e| e.to_string())?.take();
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AcpState::default())
        .invoke_handler(tauri::generate_handler![
            grok_installed,
            auth_status,
            install_grok,
            recent_projects,
            connect,
            authenticate,
            open_session,
            respond_permission,
            send_prompt,
            cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
