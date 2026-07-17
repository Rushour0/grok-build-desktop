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
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Wake every caller blocked in `recv_timeout` on this session's pending map.
///
/// Killing the child does NOT do this on its own: the `Sender`s live INSIDE the
/// map, and the map (an Arc held by the Session and by every in-flight caller)
/// outlives the reader thread, so a dead agent drops nothing and the receiver
/// waits out its full timeout — 30s for `initialize`, 60s for `session/new`.
/// Every death path must call this, or Cancel leaves the UI stuck "connecting".
fn drain_pending(pending: &Pending, reason: &str) {
    // A poisoned map is still worth draining — the senders are the whole point.
    let waiters = match pending.lock() {
        Ok(mut p) => std::mem::take(&mut *p),
        Err(e) => std::mem::take(&mut *e.into_inner()),
    };
    for (_, tx) in waiters {
        let _ = tx.send(Err(reason.to_string()));
    }
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
        // The child is gone; anyone still waiting on it never gets an answer.
        drain_pending(&self.pending, "Cancelled.");
    }
}

/// Kill-on-drop ownership for a spawned child that has no owner yet.
///
/// Between `spawn` and the `Session` insert, a `Child` dropped by an early return
/// (a `?`, a panic) leaves grok running forever: `std::process::Child`'s Drop does
/// NOT kill. This is the same orphan class the connect-failure cleanup handles, on
/// the paths that cleanup can't reach. `into_inner` disarms it at the handoff.
struct ChildGuard(Option<Child>);

impl ChildGuard {
    /// Hand the child to its real owner; the guard stops being responsible for it.
    fn into_inner(mut self) -> Child {
        self.0.take().expect("ChildGuard::into_inner called twice")
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Default)]
struct AcpState {
    inner: Mutex<HashMap<String, Session>>,
}

/// `Default` is the JoinError fallback for the `auth_status` command: if the probe
/// thread dies we report "not installed, not signed in" rather than inventing state.
#[derive(Serialize, Default)]
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
        // EOF: grok's stdout is closed, so no pending request can ever be answered.
        // Wake the waiters here too — the agent crashing on its own has exactly the
        // same shape as Cancel, and this thread's own Arc clone dropping wakes nobody.
        drain_pending(&pending, "Grok stopped responding.");
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

/// `acp-connect {tabId, stage, sessionId?, message?}` — the text-only decoration for
/// the connect/open-session wait. The command's promise stays the source of truth for
/// state; these events only ever drive a status line.
fn emit_connect(
    app: &AppHandle,
    tab_id: &str,
    stage: &str,
    session_id: Option<&str>,
    message: Option<&str>,
) {
    let mut payload = json!({"tabId": tab_id, "stage": stage});
    if let Some(obj) = payload.as_object_mut() {
        if let Some(id) = session_id {
            obj.insert("sessionId".into(), Value::String(id.to_string()));
        }
        if let Some(m) = message {
            obj.insert("message".into(), Value::String(m.to_string()));
        }
    }
    let _ = app.emit("acp-connect", payload);
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

#[cfg(windows)]
const HOOK_SCRIPT_PS1: &str = r#"$ErrorActionPreference = "SilentlyContinue"
$payload = [Console]::In.ReadToEnd()
$bridge = Join-Path $env:USERPROFILE ".grok\gbd-bridge"

# Extract scalar fields from the prefix BEFORE "toolInput" so model-controlled
# content inside toolInput can't spoof toolName/sessionId.
$head = $payload
$cut = $payload.IndexOf('"toolInput"')
if ($cut -ge 0) { $head = $payload.Substring(0, $cut) }
function Get-Field($name) {
  $m = [regex]::Match($head, ('"' + $name + '":"([^"]*)"'))
  if ($m.Success) { return $m.Groups[1].Value }
  return ""
}
$sid  = Get-Field "sessionId"
$tool = Get-Field "toolName"
$tuid = Get-Field "toolUseId"

# Not an app-owned session -> never gate.
if ([string]::IsNullOrEmpty($sid) -or -not (Test-Path (Join-Path $bridge "live\$sid"))) {
  [Console]::Out.Write('{"decision":"allow"}'); exit 0
}
# Local read-only tools pass automatically. Keep in sync with READONLY_TOOLS.
$allow = @("read_file","list_dir","grep","search_tool","get_command_or_subagent_output","monitor_status")
if ($allow -contains $tool) { [Console]::Out.Write('{"decision":"allow"}'); exit 0 }

if ([string]::IsNullOrEmpty($tuid)) { $tuid = "req-$PID-" + [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
$req  = Join-Path $bridge "req\$tuid.json"
$resp = Join-Path $bridge "resp\$tuid.json"
[System.IO.File]::WriteAllText("$req.tmp", $payload)
Move-Item -Force "$req.tmp" $req

$i = 0
while ($i -lt 5000) {
  if (Test-Path $resp) {
    [Console]::Out.Write([System.IO.File]::ReadAllText($resp))
    Remove-Item -Force $resp, $req
    exit 0
  }
  Start-Sleep -Milliseconds 100
  $i++
}
Remove-Item -Force $req
[Console]::Out.Write('{"decision":"deny","reason":"Approval timed out (no answer from Grok Build Desktop)."}')
exit 0
"#;

fn bridge_root() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".grok/gbd-bridge"))
}

fn basename(path: &str) -> String {
    path.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(path).to_string()
}

/// Install (or refresh) the global PreToolUse hook. Best-effort: a failure here
/// just means no gate, which is the pre-existing behavior.
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

#[cfg(windows)]
fn install_approval_hook() -> Result<(), String> {
    let hooks = home_dir().ok_or("no home dir")?.join(".grok/hooks");
    std::fs::create_dir_all(&hooks).map_err(|e| e.to_string())?;
    let script = hooks.join("gbd-approval.ps1");
    std::fs::write(&script, HOOK_SCRIPT_PS1).map_err(|e| e.to_string())?;
    // Run the .ps1 via PowerShell; JSON-encode the whole command string so the
    // path's backslashes/spaces are escaped correctly in the hook config.
    let command = format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        script.to_string_lossy()
    );
    let cfg = format!(
        r#"{{"hooks":{{"PreToolUse":[{{"hooks":[{{"type":"command","command":{},"timeout":600}}]}}]}}}}"#,
        serde_json::to_string(&command).map_err(|e| e.to_string())?
    );
    std::fs::write(hooks.join("gbd-approval.json"), cfg).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn install_approval_hook() -> Result<(), String> { Ok(()) }

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
/// The sharpest hazard in the file: it stats arbitrary historical user paths (a stale
/// network mount can hang forever) and re-fires on every `stage -> "ready"`. On the
/// blocking pool a hang costs one of 512 pool threads; on a tokio worker it would
/// permanently retire one of `num_cpus`, and N cycles kill every other command.
#[tauri::command]
async fn recent_projects() -> Vec<Project> {
    // JoinError -> empty list keeps the infallible signature the frontend expects.
    tauri::async_runtime::spawn_blocking(recent_projects_inner)
        .await
        .unwrap_or_default()
}

fn recent_projects_inner() -> Vec<Project> {
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
async fn list_sessions(cwd: Option<String>) -> Vec<SessionMeta> {
    tauri::async_runtime::spawn_blocking(move || list_sessions_inner(cwd))
        .await
        .unwrap_or_default()
}

fn list_sessions_inner(cwd: Option<String>) -> Vec<SessionMeta> {
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
async fn load_session_updates(cwd: String, session_id: String) -> Vec<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || load_session_updates_inner(cwd, session_id))
        .await
        .unwrap_or_default()
}

fn load_session_updates_inner(cwd: String, session_id: String) -> Vec<serde_json::Value> {
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
async fn search_sessions(query: String, cwd: Option<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || search_sessions_inner(query, cwd))
        .await
        .unwrap_or_default()
}

fn search_sessions_inner(query: String, cwd: Option<String>) -> Vec<String> {
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

/// Both of these call `resolve_grok`, whose PATH fallback is an UNBOUNDED
/// `grok --version` wait on a child process. The frontend calls `auth_status` at
/// startup, so on the main thread a hung grok on PATH freezes the app on launch.
#[tauri::command]
async fn grok_installed() -> bool {
    // JoinError -> false: if we couldn't even run the probe, we can't claim it's there.
    tauri::async_runtime::spawn_blocking(grok_installed_inner)
        .await
        .unwrap_or_default()
}

fn grok_installed_inner() -> bool {
    resolve_grok().is_some()
}

#[tauri::command]
async fn auth_status() -> AuthStatus {
    tauri::async_runtime::spawn_blocking(auth_status_inner)
        .await
        .unwrap_or_default()
}

fn auth_status_inner() -> AuthStatus {
    let grok = resolve_grok();
    AuthStatus {
        grok_installed: grok.is_some(),
        grok_path: grok.map(|p| p.to_string_lossy().into_owned()),
        has_login: home_dir()
            .map(|h| h.join(".grok/auth.json").exists())
            .unwrap_or(false),
    }
}

// ---- CLI install -------------------------------------------------------------

/// One install at a time. `acp-install` is a global, uncorrelated event, so a second
/// concurrent install would narrate over the first one's UI.
static INSTALLING: AtomicBool = AtomicBool::new(false);

/// Clears `INSTALLING` on every exit path, including `?` and panics.
struct InstallGuard;
impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

/// How many trailing installer lines to keep for a failure report.
const INSTALL_TAIL_LINES: usize = 40;

/// The marker after which install.sh's output is genuinely about installing. Lines
/// before it are the shell's own noise and belong in the tail buffer, never in the
/// status line the user reads.
const INSTALL_MARKER: &str = "fetching latest";

/// Decorative only — a coarse bucket for the status line's label. Never load-bearing:
/// the honest content is `detail`, which is the installer's own line, verbatim.
/// Bucket an install.sh stderr line into a coarse stage label.
///
/// Every arm below is matched against a line install.sh actually prints — checked
/// against the real script, not inferred:
///   "Fetching latest ${CHANNEL} version..."          -> resolving
///   "  Downloading grok ${version}..."               -> downloading
///   "  Updated $BIN_DIR in PATH in $config_file."    -> configuring
///   "  Binary linked to ...", "Grok $v installed to" -> installing (the fallback)
///
/// Deliberately NO verifying/extracting arms: install.sh prints no such line (it
/// downloads a bare binary — there is nothing to unpack, and its only integrity
/// check is a silent `--version` smoke test). A bucket that can never fire is a
/// stage we would be claiming exists. The label is decoration anyway — `detail`
/// carries the script's real line verbatim — so the honest fallback is "installing".
fn install_stage(line: &str) -> &'static str {
    let l = line.to_lowercase();
    if l.contains("fetching latest") {
        "resolving"
    } else if l.contains("downloading") {
        "downloading"
    } else if l.contains("path") {
        "configuring"
    } else {
        "installing"
    }
}

/// Emit `failed` with the tail as its detail, and hand back the error string. The
/// three arms that OWN a running install share this; the reentrancy guard must not
/// use it (see `install_grok_inner`).
fn install_fail(app: &AppHandle, tail: &Arc<Mutex<Vec<String>>>, msg: &str) -> String {
    let detail = tail
        .lock()
        .map(|t| t.join("\n"))
        .unwrap_or_default();
    let _ = app.emit("acp-install", json!({"status": "failed", "detail": detail}));
    if detail.is_empty() {
        msg.to_string()
    } else {
        format!("{msg}\n{detail}")
    }
}

/// Pump one of the installer's pipes: everything lands in the shared tail buffer;
/// only the rendering reader (stderr) turns lines into `acp-install` stage events.
fn spawn_install_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    stream: R,
    tail: Arc<Mutex<Vec<String>>>,
    render: bool,
    seen_marker: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            if let Ok(mut t) = tail.lock() {
                t.push(line.clone());
                let overflow = t.len().saturating_sub(INSTALL_TAIL_LINES);
                if overflow > 0 {
                    t.drain(0..overflow);
                }
            }
            if !render {
                continue;
            }
            if line.to_lowercase().contains(INSTALL_MARKER) {
                seen_marker.store(true, Ordering::SeqCst);
            }
            // Nothing before the marker is trustworthy as "install progress".
            if !seen_marker.load(Ordering::SeqCst) {
                continue;
            }
            let _ = app.emit(
                "acp-install",
                json!({"status": "stage", "stage": install_stage(&line), "detail": line}),
            );
        }
    })
}

/// Download and install the Grok Build CLI via xAI's official installer.
/// The user should never have to open a terminal to get started.
#[tauri::command]
async fn install_grok(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || install_grok_inner(app))
        .await
        .map_err(|e| e.to_string())?
}

fn install_grok_inner(app: AppHandle) -> Result<String, String> {
    // First statement, strictly before the `started` emit. A rejected second click
    // must NOT emit `failed`: `acp-install` carries no correlation id, so the
    // rejection would tear down the UI of the install that IS running.
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("An install is already running.".to_string());
    }
    let _guard = InstallGuard;

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
        // `bash -c`, NOT `-lc`: a login shell sources the user's dotfiles, and their
        // shell banners would be streamed to the user as "install progress".
        // `set -o pipefail`: without it `curl … | bash` exits 0 when curl 404s,
        // because the pipeline's status is bash's, and bash happily runs nothing.
        c.args(["-c", "set -o pipefail; curl -fsSL https://x.ai/cli/install.sh | bash"]);
        c
    };

    let tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let mut child = match cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return Err(install_fail(
                &app,
                &tail,
                &format!("Couldn't run the Grok installer: {e}"),
            ))
        }
    };

    let seen_marker = Arc::new(AtomicBool::new(false));
    // Every user-facing line install.sh prints goes to stderr — streaming stdout
    // would give a permanently empty status line. stdout is drained anyway so a
    // full pipe buffer can't wedge the installer, and kept for diagnostics.
    let stdout_reader = child.stdout.take().map(|s| {
        spawn_install_reader(app.clone(), s, tail.clone(), false, seen_marker.clone())
    });
    let stderr_reader = child.stderr.take().map(|s| {
        spawn_install_reader(app.clone(), s, tail.clone(), true, seen_marker.clone())
    });

    // Single-owner poll loop: two threads cannot both hold `&mut Child`, and an
    // `Arc<Mutex<Child>>` deadlocks because `wait()` would hold the guard.
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    let mut timed_out = false;
    let mut wait_err: Option<String> = None;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(e) => {
                wait_err = Some(format!("Lost track of the Grok installer: {e}"));
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
        if std::time::Instant::now() >= deadline {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(100));
    };

    // The kill/exit EOFs both pipes, so the readers finish on their own.
    if let Some(h) = stdout_reader {
        let _ = h.join();
    }
    if let Some(h) = stderr_reader {
        let _ = h.join();
    }

    match status {
        Some(s) if s.success() => {}
        Some(_) => return Err(install_fail(&app, &tail, "The Grok installer failed:")),
        None if timed_out => {
            return Err(install_fail(
                &app,
                &tail,
                "The Grok installer didn't finish within 10 minutes, so we stopped waiting. \
                 We only stopped the shell we started — the download itself may still be \
                 finishing in the background. Give it a minute, then try again.",
            ))
        }
        None => {
            return Err(install_fail(
                &app,
                &tail,
                &wait_err.unwrap_or_else(|| "The Grok installer stopped unexpectedly.".to_string()),
            ))
        }
    }

    match resolve_grok() {
        Some(p) => {
            let _ = app.emit("acp-install", json!({"status": "done"}));
            Ok(p.to_string_lossy().into_owned())
        }
        // This arm owns the install and used to fail silently — no `failed` event,
        // so the UI kept pulsing forever.
        None => Err(install_fail(
            &app,
            &tail,
            "The installer finished but `grok` still isn't where we expect it.",
        )),
    }
}

/// Spawn `grok agent stdio` in `cwd`, do the ACP handshake, and try to open a session.
/// If the agent demands sign-in, report that instead of failing — the UI drives `authenticate`.
#[tauri::command]
async fn connect(app: AppHandle, tab_id: String, cwd: String) -> Result<ConnectResult, String> {
    tauri::async_runtime::spawn_blocking(move || connect_blocking(app, tab_id, cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn connect_blocking(app: AppHandle, tab_id: String, cwd: String) -> Result<ConnectResult, String> {
    // First statement, before the reconnect kill and before resolve_grok(): every
    // slow case (gatekeeper, a cold binary, the unbounded `grok --version` probe in
    // resolve_grok) happens inside or before resolve, so emitting later would make
    // this stage unreachable exactly when it's the one worth showing.
    emit_connect(&app, &tab_id, "spawning", None, None);

    let state = app.state::<AcpState>();

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

    // `Child` has no killing `Drop`, so ANY early return between here and the
    // Session insert below would leak a live grok — including the `?` on a poisoned
    // state lock, which no explicit cleanup arm can cover. The guard owns the child
    // until `into_inner` hands it to the one owner that can kill it: the Session.
    let stdio = (child.stdin.take(), child.stdout.take(), child.stderr.take());
    let guard = ChildGuard(Some(child));
    let (stdin, stdout, stderr) = match stdio {
        (Some(i), Some(o), e) => (i, o, e),
        _ => {
            drop(guard); // kills and reaps
            let msg = "grok gave us no stdio".to_string();
            emit_connect(&app, &tab_id, "failed", None, Some(&msg));
            return Err(msg);
        }
    };

    let stdin = Arc::new(Mutex::new(stdin));
    if let Some(stderr) = stderr {
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

    // Insert the Session the moment the process and its reader exist, so every
    // failure below has exactly one owner that can kill it. The Arcs are CLONED —
    // `child` moves, but stdin/pending/next_id are still needed for the handshake.
    {
        // If this `?` fires, `guard` is still alive and its Drop kills the child.
        let mut map = state.inner.lock().map_err(|e| e.to_string())?;
        // Non-destructive: a racing connect for the same tab must not orphan the
        // session it displaces (double-click the folder button).
        if let Some(old) = map.insert(
            tab_id.clone(),
            Session {
                tab_id: tab_id.clone(),
                child: guard.into_inner(),
                stdin: stdin.clone(),
                session_id: None,
                next_id: next_id.clone(),
                pending: pending.clone(),
                approval_stop: Arc::new(AtomicBool::new(false)),
            },
        ) {
            drop(map);
            old.kill();
        }
    }

    let handshake = || -> Result<ConnectResult, String> {
        emit_connect(&app, &tab_id, "handshaking", None, None);

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

        emit_connect(&app, &tab_id, "session", None, None);

        // Try for a session; a fresh install will bounce us to sign-in instead.
        match new_session(&app, &state, &tab_id, &cwd)? {
            Ok(session_id) => {
                emit_connect(&app, &tab_id, "ready", Some(&session_id), None);
                Ok(ConnectResult {
                    needs_auth: false,
                    auth_methods,
                    session_id: Some(session_id),
                })
            }
            Err(e) if is_auth_error(&e) => {
                emit_connect(&app, &tab_id, "needs_auth", None, None);
                Ok(ConnectResult {
                    needs_auth: true,
                    auth_methods,
                    session_id: None,
                })
            }
            Err(e) => Err(e),
        }
    };

    let outcome = handshake();
    match outcome {
        Ok(result) => Ok(result),
        Err(e) => {
            // The one cleanup path: a failed connect must not leave grok running.
            let orphan = state.inner.lock().ok().and_then(|mut g| g.remove(&tab_id));
            if let Some(orphan) = orphan {
                orphan.kill();
            }
            emit_connect(&app, &tab_id, "failed", None, Some(&e));
            Err(e)
        }
    }
}

/// Kick off the agent's sign-in flow (grok opens the browser itself). Returns as soon
/// as the request is on the wire; the outcome arrives as one `acp-auth` event.
///
/// Fire-and-forget rather than `spawn_blocking`, because this is an unbounded
/// human-in-the-loop wait on a channel a thread we already own feeds — the exact
/// shape `send_prompt` uses. Resolving the promise here would mean "sent", not
/// "signed in", so the frontend MUST key success off `acp-auth {status:"ok"}`.
#[tauri::command]
fn authenticate(
    app: AppHandle,
    state: State<AcpState>,
    tab_id: String,
    method_id: String,
) -> Result<(), String> {
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

    thread::spawn(move || {
        // 11 minutes, deliberately LONGER than grok's own 10-minute device-code
        // deadline. Anything shorter invents a divergent state: the user signs in at
        // minute 6, grok writes auth.json, and we tell them it timed out. We'd rather
        // outlive grok's deadline and report the answer it actually gives.
        //
        // (Note: on the timeout arm the pending entry for this id is never removed —
        // the same tx leak `request` has everywhere. Bounded by process lifetime; see
        // c10, deferred.)
        let payload = match rx.recv_timeout(Duration::from_secs(11 * 60)) {
            // Constructed, not forwarded: grok answers `{}` plus a `_meta` bag, and
            // the wire contract is ours, not its. snake_case -> camelCase here.
            Ok(Ok(result)) => json!({
                "status": "ok",
                "email": result["_meta"]["email"],
                "subscriptionTier": result["_meta"]["subscription_tier"],
            }),
            Ok(Err(e)) => json!({"status": "failed", "message": e}),
            Err(_) => json!({"status": "timed_out", "message": "Sign-in timed out. Try again?"}),
        };
        let _ = app.emit("acp-auth", with_tab_id(payload, &tab_id));
    });
    Ok(())
}

/// Open a session after a successful sign-in.
#[tauri::command]
async fn open_session(app: AppHandle, tab_id: String, cwd: String) -> Result<String, String> {
    // Both Result levels stay inside the closure; flatten at the await boundary.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        emit_connect(&app, &tab_id, "session", None, None);
        let state = app.state::<AcpState>();
        let outcome = new_session(&app, &state, &tab_id, &cwd);
        match &outcome {
            Ok(Ok(id)) => emit_connect(&app, &tab_id, "ready", Some(id), None),
            Ok(Err(e)) | Err(e) => emit_connect(&app, &tab_id, "failed", None, Some(e)),
        }
        outcome
    })
    .await
    .map_err(|e| e.to_string())?;
    outcome?
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

/// Tear a tab's session down. `Session::kill` reaps the child with a blocking
/// `wait()`, so this must never run on the main thread — it is the escape hatch
/// from a wait, and would otherwise freeze the UI it exists to unfreeze.
#[tauri::command]
async fn cancel(app: AppHandle, tab_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AcpState>();
        cancel_blocking(&state, &tab_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cancel_blocking(state: &State<AcpState>, tab_id: &str) -> Result<(), String> {
    let session = state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .remove(tab_id);
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
