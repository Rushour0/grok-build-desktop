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

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// Reply channels for client->agent requests we're still waiting on, keyed by JSON-RPC id.
type Pending = Arc<Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>>;

/// The identity of one conversation: which OS window it lives in, and which tab
/// inside that window.
///
/// The `window` half is NOT frontend input. It comes from `WebviewWindow::label()`,
/// which Tauri fills in from the IPC message itself (`CommandArg for WebviewWindow`),
/// so a webview cannot name a window other than its own. That unforgeability is the
/// whole safety argument for this type: with `window` pinned by the runtime, a tab id
/// minted by window A's JS can never collide with, address, or answer for window B —
/// no matter what the webview sends.
///
/// Consequently this type deliberately does NOT implement `Deserialize` or
/// `From<String>`: either one would let a frontend-supplied string become an identity
/// and quietly undo the property above. The sole constructor is `for_window`, named so
/// it can never be mistaken for a `From` impl.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct SessionKey {
    window: String,
    tab: String,
}

impl SessionKey {
    /// The only way to make a `SessionKey`. `window` is taken from the runtime-injected
    /// window label; only the tab half is caller-supplied.
    fn for_window(window: &WebviewWindow, tab: String) -> Self {
        Self {
            window: window.label().to_string(),
            tab,
        }
    }

    /// The one route a session's events take to its webview, and the ONLY writer of
    /// `tabId` in this file.
    ///
    /// `emit_to` rather than `emit`: a broadcast delivers project Q's diff into project
    /// P's window and asks the JS to be disciplined about ignoring it. Routing here means
    /// the other window never receives the bytes at all — a boundary instead of a
    /// convention. Note this does not by itself close the approval steal (a window can
    /// still *answer* for a card it never saw); `respond_hook`'s ownership check is the
    /// sufficient half. Both are load-bearing.
    ///
    /// The discarded `Result` is deliberate: `emit_to` on a label that no longer exists
    /// returns `Ok(())`, so there is no error here to handle. A window that closed
    /// mid-stream is the teardown path's problem, not this one's.
    fn emit(&self, app: &AppHandle, event: &str, payload: Value) {
        let _ = app.emit_to(&self.window, event, with_tab_id(payload, &self.tab));
    }
}

struct Session {
    key: SessionKey,
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    /// None until `session/new` succeeds — auth may be required first.
    session_id: Option<String>,
    next_id: Arc<AtomicI64>,
    pending: Pending,
    /// Set to stop this session's approval-hook watcher thread.
    approval_stop: Arc<AtomicBool>,
    /// Tool-use ids this session has actually shown the user an approval card for.
    ///
    /// This is the answer to "is this decision yours to make?". The bridge's `resp/`
    /// directory is keyed only by tool-use id, so without this set ANY window can write
    /// ANY decision for ANY session — `respond_hook` would take a `tool_use_id` off the
    /// wire and write it straight through. Membership here is the proof that this
    /// session emitted that card, and `respond_hook` consumes it (`remove`), which also
    /// closes the same-window double-answer and keeps the set bounded.
    ///
    /// **Lock order is AcpState -> emitted, everywhere, no exceptions.** Clone this Arc
    /// out from under the AcpState guard, drop that guard, and only then lock it.
    emitted: Arc<Mutex<HashSet<String>>>,
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
    inner: Mutex<HashMap<SessionKey, Session>>,
}

/// Move every value belonging to window `label` OUT of the map, by value.
///
/// `HashMap::retain` cannot do this — it only ever hands the predicate a `&mut V`, so
/// the values it drops are destroyed in place rather than surrendered. We need them
/// alive and owned, because the only thing a caller ever does with a drained `Session`
/// is `Session::kill`, which blocks in `child.wait()` (see `Session::kill`). Killing
/// under the `AcpState` guard would hold the whole app's session map hostage to one
/// dying child — every other command blocks behind it, which is precisely the freeze
/// `cancel` exists to escape.
///
/// So the seam is: this function returns OWNED values and the guard is already gone by
/// the time the caller can touch them. **Callers MUST move the return value to a thread
/// (or to an exit path, where a blocking kill on the main thread is the correct thing)
/// before calling `kill`.** Returning `Vec<T>` rather than killing internally is what
/// makes that structural instead of a comment.
///
/// Generic over the value type so the drain property is testable with a plain `T` —
/// a real `Session` owns a live child process and cannot be constructed in a test.
fn take_window<T>(map: &mut HashMap<SessionKey, T>, label: &str) -> Vec<T> {
    map.extract_if(|k, _| k.window == label)
        .map(|(_, v)| v)
        .collect()
}

/// Teardown threads spawned by the per-window `Destroyed` handler, kept JOINABLE.
///
/// The handler cannot detach them. On last-window close `Destroyed` fires and *then*
/// `ExitRequested` -> `RunEvent::Exit` (verified in tauri-runtime-wry), so a detached
/// teardown thread is killed mid-`child.wait()` by the process exiting — reintroducing
/// the orphaned grok that the exit drain exists to prevent. The two features would
/// silently defeat each other. Pushing every handle here instead lets `RunEvent::Exit`
/// join them all before it returns.
static TEARDOWN: Mutex<Vec<thread::JoinHandle<()>>> = Mutex::new(Vec::new());

/// Kill every live session everywhere, then wait for every in-flight teardown.
///
/// Order matters: drain `AcpState` and kill what is in it, THEN join `TEARDOWN` — a
/// window that closed a moment before quit has its sessions in a teardown thread, not in
/// the map, and joining first would race the thread that is still moving them out.
///
/// This is the one place a blocking kill on the main thread is correct. There is nothing
/// left to keep responsive, and returning before the children are reaped is precisely
/// what orphans them: today's tray `app.exit(0)` does exactly that, leaving every grok
/// child running and every `live/` marker in place, after which the hook gates dead
/// sessions for ~500s each.
fn shutdown_everything(app: &AppHandle) {
    let state = app.state::<AcpState>();
    let sessions: Vec<Session> = {
        let mut guard = match state.inner.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        std::mem::take(&mut *guard).into_values().collect()
    };

    // Kill all, then wait for all. `Session::kill` is kill-then-wait per session, so
    // doing this serially would add up every child's death in turn; a thread each lets
    // them overlap. Going through `Session::kill` (rather than `child.kill()` here) is
    // deliberate — it is what stops the watcher, drops the `live/` marker, and runs
    // `drain_pending` so nothing is left blocked on an answer that can't come.
    let killers: Vec<_> = sessions
        .into_iter()
        .map(|session| thread::spawn(move || session.kill()))
        .collect();
    for killer in killers {
        let _ = killer.join();
    }

    let handles = {
        let mut guard = match TEARDOWN.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        std::mem::take(&mut *guard)
    };
    for handle in handles {
        let _ = handle.join();
    }
}

/// Delete every `live/` marker left over from a previous run.
///
/// A marker means "this session is app-owned — gate it". If the app dies without
/// clearing one (which, until the exit drain above, was every single quit), the hook
/// keeps gating a session that no longer exists: the next tool call in a *resumed*
/// session waits out the full ~500s deadline and is then auto-denied, with nothing on
/// screen to answer it. Nothing is live at startup, so every marker here is stale by
/// definition.
///
/// KNOWN, and a deliberate default: this also deletes the markers of a SECOND running
/// instance, silently ungating its sessions. Running two instances is unsupported — the
/// tray already assumes one — and this is stated in the release notes rather than papered
/// over with an mtime heuristic that would only narrow the window, not close it.
fn sweep_live_markers() {
    let Some(root) = bridge_root() else { return };
    let Ok(entries) = std::fs::read_dir(root.join("live")) else {
        return;
    };
    for entry in entries.flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
}

/// `take_window` against the live state, with the lock scoped to the drain itself.
///
/// A poisoned map is still drained: the sessions inside own real child processes, and
/// refusing to hand them back because some unrelated thread panicked would leak every
/// one of them. This is the same reasoning as `drain_pending`.
fn drain_window(state: &AcpState, label: &str) -> Vec<Session> {
    let mut guard = match state.inner.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    take_window(&mut guard, label)
}

// ---- One project per window --------------------------------------------------

/// The label prefix for every window this app mints (`w2`, `w3`, …).
///
/// **MUST stay in sync with `"windows": ["main", "w*"]` in
/// `src-tauri/capabilities/default.json`**, whose comment names this constant. That
/// glob is what grants a window the right to invoke anything at all, and a label it
/// doesn't match fails SILENTLY in release builds: no error, no log — the window simply
/// has no permissions and every `invoke` from it dies. That silence is why this is a
/// named constant with a comment on both sides instead of a `"w"` inlined at the one
/// call site that mints labels.
///
/// The security property here is not the prefix. It is that label minting is centralized
/// in `WindowRegistry::mint_label` and no untrusted input ever reaches a label — a cwd is
/// never interpolated into one.
const WINDOW_LABEL_PREFIX: &str = "w";

/// The project a window is showing.
struct ProjectEntry {
    /// The cwd EXACTLY as the user picked it. This is what grok is handed and what the
    /// session store is matched on — `list_sessions_inner` does an exact string compare
    /// against the percent-decoded directory name, so handing it a canonicalized path
    /// silently empties the sidebar (macOS canonicalizes `/var` to `/private/var`, and
    /// the CLI stored the session under whatever the user originally typed).
    cwd: String,
    /// The dedupe identity: canonicalized, only ever compared, never handed out.
    /// Deliberately a second field rather than a normalization of `cwd` — collapsing the
    /// two is exactly the bug described above.
    key: PathBuf,
}

/// Which window is showing which project. The Rust side owns this, so a webview learns
/// its own cwd by asking (`window_project`) instead of being told and trusted.
struct WindowRegistry {
    inner: Mutex<HashMap<String, ProjectEntry>>,
    next: AtomicU64,
}

impl Default for WindowRegistry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            // Seeded at 2: `main` is the config-minted first window, so `w1` would be
            // gratuitously confusing. Counter only ever moves forward — a reused label
            // would inherit a dead window's identity, and `SessionKey` is built on the
            // assumption that a label names one window for the life of the process.
            next: AtomicU64::new(2),
        }
    }
}

impl WindowRegistry {
    /// The one place a window label is minted. See `WINDOW_LABEL_PREFIX`.
    fn mint_label(&self) -> String {
        format!(
            "{WINDOW_LABEL_PREFIX}{}",
            self.next.fetch_add(1, Ordering::SeqCst)
        )
    }
}

/// The dedupe identity for a project path.
///
/// Symlinks, `..`, a trailing slash, and macOS's `/var` -> `/private/var` all mean two
/// different strings can name one directory. Comparing raw strings would let the same
/// project open in two windows, which is the thing `open_project` exists to prevent.
/// Canonicalization failure falls back to the path as given: the folder came from a
/// dialog so it existed a moment ago, and an un-canonicalized key is still a consistent
/// one — worst case the user gets the second window this would have merged.
fn project_key(cwd: &str) -> PathBuf {
    std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd))
}

/// What `open_project` did. The caller only has to distinguish `adopted` — "you are now
/// this project's window, re-render" — from the two cases where some other window took it
/// and there is nothing for the caller to do.
#[derive(Serialize)]
struct OpenOutcome {
    /// `"focused"` — already open elsewhere; that window was raised.
    /// `"adopted"` — the calling window had no project and took this one.
    /// `"opened"`  — a new window was built for it.
    kind: &'static str,
    /// The window that ended up owning the project.
    label: String,
}

/// The window title for a project: just the folder's name.
fn window_title(cwd: &str) -> String {
    basename(cwd)
}

/// Build a window under `label`, cloning the app's configured window as the template.
/// `title: None` keeps the config's own title (that is the launcher).
fn build_window(app: &AppHandle, label: &str, title: Option<String>) -> Result<(), String> {
    // `WebviewWindowBuilder::from_config` hardcodes `label: config.label.clone()` and
    // exposes no label setter, so the config must be CLONED and its label overwritten.
    // Building from the app config as-is would try to mint a second window called "main"
    // and fail with `WindowLabelAlreadyExists` on every single call.
    let mut conf = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("no window config to clone")?;
    conf.label = label.to_string();
    // Titled here rather than from the webview: the ACL gates IPC, so a `set_title`
    // capability could be denied and leave the window lying about which project it is.
    // Rust-side titling cannot be denied.
    if let Some(title) = title {
        conf.title = title;
    }

    tauri::WebviewWindowBuilder::from_config(app, &conf)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Build a new window for `label`, already reserved in the registry by the caller.
fn build_project_window(app: &AppHandle, label: &str, cwd: &str) -> Result<(), String> {
    build_window(app, label, Some(window_title(cwd)))
}

/// What `open_project` decided to do, computed inside the registry's critical section
/// and acted on outside it.
enum OpenPlan {
    /// This project already has a window: raise it.
    Focus(String),
    /// The calling window has no project of its own: it takes this one.
    Adopt,
    /// Build a new window under this freshly-reserved label.
    Build(String),
}

/// Open a project: focus its window if it has one, adopt it into a projectless caller,
/// otherwise build it a window of its own. The one entry point for "show me this folder".
#[tauri::command]
async fn open_project(
    app: AppHandle,
    window: WebviewWindow,
    cwd: String,
) -> Result<OpenOutcome, String> {
    let caller = window.label().to_string();
    let key = project_key(&cwd);

    loop {
        // ONE critical section: scan, decide, and RESERVE. Splitting the lookup from the
        // insert is a TOCTOU that lets two quick clicks both conclude "not open yet" and
        // build two windows on one project — the exact thing this command exists to
        // prevent. The lock is released before `build()`, which pumps the event loop and
        // must never run under it.
        let plan = {
            let registry = app.state::<WindowRegistry>();
            let mut guard = registry.inner.lock().map_err(|e| e.to_string())?;

            if let Some((label, _)) = guard.iter().find(|(_, entry)| entry.key == key) {
                OpenPlan::Focus(label.clone())
            } else if let std::collections::hash_map::Entry::Vacant(slot) =
                guard.entry(caller.clone())
            {
                // The caller is projectless (the launcher, or a tray-minted window).
                // Adopting beats opening a second window and leaving an empty one behind.
                slot.insert(ProjectEntry {
                    cwd: cwd.clone(),
                    key: key.clone(),
                });
                OpenPlan::Adopt
            } else {
                let label = registry.mint_label();
                guard.insert(
                    label.clone(),
                    ProjectEntry {
                        cwd: cwd.clone(),
                        key: key.clone(),
                    },
                );
                OpenPlan::Build(label)
            }
        };

        match plan {
            OpenPlan::Focus(label) => {
                let Some(existing) = app.get_webview_window(&label) else {
                    // An entry whose window is gone. `c7`'s `Destroyed` handler is the
                    // only remover of a live entry and always runs, so this is
                    // belt-and-braces: drop the stale entry and decide again, this time
                    // without it. Terminates — each pass removes one entry.
                    if let Ok(mut guard) = app.state::<WindowRegistry>().inner.lock() {
                        guard.remove(&label);
                    }
                    continue;
                };
                let _ = existing.show();
                let _ = existing.unminimize();
                let _ = existing.set_focus();
                return Ok(OpenOutcome {
                    kind: "focused",
                    label,
                });
            }
            OpenPlan::Adopt => {
                let _ = window.set_title(&window_title(&cwd));
                return Ok(OpenOutcome {
                    kind: "adopted",
                    label: caller,
                });
            }
            OpenPlan::Build(label) => match build_project_window(&app, &label, &cwd) {
                Ok(()) => return Ok(OpenOutcome { kind: "opened", label }),
                Err(e) => {
                    // Remove ONLY our own failed reservation. This never became a live
                    // window, so it does not tread on `c7`'s role as the sole remover of
                    // a live window's entry.
                    if let Ok(mut guard) = app.state::<WindowRegistry>().inner.lock() {
                        guard.remove(&label);
                    }
                    return Err(e);
                }
            },
        }
    }
}

// ---- Tray ---------------------------------------------------------------------

/// The last window to take focus — the tray's idea of "the window you meant".
///
/// The tray used to hardcode `main`. With N windows that is a guess which is wrong more
/// often than right, and once `main` itself is closed it names nothing at all: every tray
/// action becomes a silent no-op, with the icon still sitting there looking functional.
#[cfg(desktop)]
static FOCUSED_WINDOW: Mutex<Option<String>> = Mutex::new(None);

/// The window a tray action should act on: the last-focused one if it still exists, else
/// any window at all, else `None` — meaning nothing is open and the caller should build a
/// launcher.
#[cfg(desktop)]
fn tray_target(app: &AppHandle) -> Option<WebviewWindow> {
    let focused = FOCUSED_WINDOW.lock().ok().and_then(|guard| guard.clone());
    if let Some(label) = focused {
        // The tracked label can outlive its window; fall through rather than give up.
        if let Some(window) = app.get_webview_window(&label) {
            return Some(window);
        }
    }
    app.webview_windows().into_values().next()
}

#[cfg(desktop)]
fn reveal(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

/// Open a projectless launcher window. The tray's fallback when no window is alive.
#[cfg(desktop)]
fn open_launcher(app: &AppHandle) {
    let app = app.clone();
    // NEVER inline in a tray event closure: building a webview from inside a Webview2
    // event callback deadlocks (tauri#583). Hand it to the async runtime instead.
    tauri::async_runtime::spawn(async move {
        let label = app.state::<WindowRegistry>().mint_label();
        // Deliberately NO registry entry: a launcher has no project. `window_project`
        // answers `None`, the webview renders the picker, and `open_project` will adopt
        // this very window rather than opening a second one beside it.
        let _ = build_window(&app, &label, None);
    });
}

/// Raise the window the user meant, or make one if there is none.
#[cfg(desktop)]
fn tray_show(app: &AppHandle) {
    match tray_target(app) {
        Some(window) => reveal(&window),
        None => open_launcher(app),
    }
}

/// Which project is this window showing? `None` means the projectless launcher.
///
/// Ask-don't-tell. The alternatives — a URL parameter or an injected init script — both
/// hand the cwd to the webview at creation and then trust the webview to hand it back,
/// at which point the cwd is frontend input and the registry is decoration. Here the
/// window names itself (`WebviewWindow::label()` is the runtime's, not the webview's)
/// and Rust answers.
#[tauri::command]
async fn window_project(window: WebviewWindow) -> Option<String> {
    let registry = window.state::<WindowRegistry>();
    // Short, uncontended, no I/O: no `spawn_blocking` needed or wanted.
    let guard = registry.inner.lock().ok()?;
    guard.get(window.label()).map(|entry| entry.cwd.clone())
}

// ---- Command line ------------------------------------------------------------
//
//   <app>                     the launcher (unchanged)
//   <app> <path>              open that directory as the project
//   <app> --resume <id>       open the session's project and load the conversation
//
// **This only works when the binary is invoked directly** — from a terminal, or via
// `open -a "Grok Build Desktop" --args …`. A `.app` double-clicked in Finder (or opened
// from Spotlight/Dock) is handed NO argv at all, so every launch that way takes the
// no-args path. That is the OS, not a bug here, and a PATH shim (VS Code's `code`) is the
// thing that would fix it. Deliberately not built: out of scope.
//
// Everything here is `#[cfg(desktop)]` because argv is: a mobile app has no command line.
//
// `std::env::args()` and nothing else — no `tauri-plugin-cli`, no `clap`. Three shapes do
// not need an argument parser, and the dependency would cost more than it carries.

/// What the command line asked for, straight off the wire.
///
/// Deliberately a distinct type from `CliIntent`: this is UNTRUSTED. It holds argv's own
/// bytes and nothing has been checked. Nothing in here may become a window label or reach
/// a `SessionKey` — labels are minted Rust-side from `WindowRegistry`'s counter and that
/// property is load-bearing (see `WINDOW_LABEL_PREFIX`). The only thing argv is ever
/// allowed to name is a folder to go looking for.
#[cfg(desktop)]
#[derive(Debug, PartialEq, Eq)]
enum CliRequest {
    /// No args — today's behaviour.
    Launcher,
    /// `<app> <path>`, exactly as typed: may be `.`, relative, or symlinked.
    Project(String),
    /// `<app> --resume <sessionId>`.
    Resume(String),
}

/// A `CliRequest` that has been checked against the disk. Every string in here has been
/// proven to name something real; that proof is the only difference between the two types
/// and it is why they are two types.
#[cfg(desktop)]
enum CliIntent {
    Launcher,
    Project(String),
    Resume { cwd: String, session_id: String },
}

/// Parse argv (already stripped of argv[0]) into a request. PURE — no disk, no env — so
/// the untrusted half of CLI handling has no side effects and is unit-testable.
///
/// Unknown `-`-prefixed args are IGNORED, not rejected. A GUI binary gets handed flags it
/// never asked for (macOS's legacy `-psn_0_…` process serial number is the classic), and
/// erroring on those would turn an ordinary launch into a failure. The first bare
/// positional wins and is taken as the path.
#[cfg(desktop)]
fn parse_cli_args<I: IntoIterator<Item = String>>(args: I) -> Result<CliRequest, String> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--resume" => {
                let id = args.next().unwrap_or_default();
                if id.trim().is_empty() {
                    return Err("`--resume` needs a conversation id.".to_string());
                }
                return Ok(CliRequest::Resume(id));
            }
            _ if arg.starts_with('-') => continue,
            _ => return Ok(CliRequest::Project(arg)),
        }
    }
    Ok(CliRequest::Launcher)
}

/// Make a path argument absolute WITHOUT resolving symlinks, so `.` and relative paths
/// work from a terminal.
///
/// The symlink half is the whole point. `ProjectEntry.cwd` must stay the path the user
/// meant, because `list_sessions_inner` does an exact string compare against the
/// percent-decoded session-store folder name: hand it a canonicalized path and the
/// sidebar silently empties — macOS canonicalizes `/tmp` to `/private/tmp`, while the CLI
/// stored those sessions under `/tmp`. So `<app> .` from `/tmp/projB` must open
/// `/tmp/projB`, not `/private/tmp/projB`.
///
/// Existence is still proven, by `resolve_project`, and dedupe is unaffected:
/// `project_key` canonicalizes on its own, so a window opened from the CLI and one opened
/// from the folder dialog still collapse onto the same window.
///
/// `..` is popped lexically. Across a symlink that differs from what the kernel would do,
/// but it is what the user typing it means and what their shell showed them — and the
/// result is `is_dir`-checked either way, so the worst case is a real folder they didn't
/// expect, never a broken window.
#[cfg(desktop)]
fn absolutize(raw: &str) -> Option<PathBuf> {
    let raw = Path::new(raw);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(raw)
    };

    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// Turn a `<path>` argument into a cwd, or say why not.
///
/// ARGV IS UNTRUSTED and this is the only gate between it and `open_project`. "It is a
/// real directory" is the entirety of what it proves, and the entirety of what argv is
/// believed about.
#[cfg(desktop)]
fn resolve_project(raw: &str) -> Result<String, String> {
    let abs = absolutize(raw).ok_or_else(|| format!("Can't work out where `{raw}` is."))?;
    // `canonicalize` is the existence proof and is then DISCARDED — see `absolutize` for
    // why its output must not become the stored cwd. Preferred over a bare `is_dir()`
    // because it also refuses a dangling symlink and a path we can't traverse, with the
    // OS's own error message rather than a guess.
    let real = std::fs::canonicalize(&abs).map_err(|e| format!("Can't open `{raw}`: {e}"))?;
    if !real.is_dir() {
        return Err(format!("`{raw}` isn't a folder."));
    }
    Ok(abs.to_string_lossy().into_owned())
}

/// The cwd a session belongs to, out of a list of sessions.
///
/// Split from the walk below so the id -> cwd mapping is testable without a session store
/// on disk — the walk itself is `list_sessions_inner`, which the sidebar already exercises
/// on every launch.
#[cfg(desktop)]
fn pick_session_cwd(sessions: Vec<SessionMeta>, session_id: &str) -> Option<String> {
    sessions
        .into_iter()
        .find(|session| session.id == session_id)
        .map(|session| session.cwd)
}

/// Resolve `--resume <id>` against the CLI's own session store.
///
/// A session id ALONE is enough to find its project: the store is
/// `~/.grok/sessions/<percent-encoded cwd>/<sessionId>/summary.json`, so the project is
/// simply the id's parent. Rather than walk that tree a second time, this reuses
/// `list_sessions_inner` — the one walker — which already percent-decodes the parent name
/// and reads `info.cwd` out of each summary. A second walker would be a second thing to
/// keep in sync with a layout neither of us owns.
///
/// BLOCKING: reads every `summary.json` under `~/.grok/sessions`. See `resolve_cli` for
/// why that is allowed where it is called.
#[cfg(desktop)]
fn resolve_session(session_id: &str) -> Result<CliIntent, String> {
    let cwd = pick_session_cwd(list_sessions_inner(None), session_id)
        .ok_or_else(|| format!("No conversation with id `{session_id}`."))?;
    // The store outlives the folder — a project since deleted or moved still has its
    // sessions on disk. A window on a path that isn't there is exactly the broken window
    // we would rather fail than build.
    if !Path::new(&cwd).is_dir() {
        return Err(format!("That conversation's folder is gone: `{cwd}`."));
    }
    Ok(CliIntent::Resume {
        cwd,
        session_id: session_id.to_string(),
    })
}

/// Parse and fully resolve the command line. **Called before the Tauri builder exists.**
///
/// The v0.8.4 doctrine bans a filesystem scan from the main thread, and the `--resume`
/// arm is one. It runs here anyway, and the exemption is structural rather than
/// argumentative: `run()` calls this before the builder, so there is no window, no
/// webview and no event loop — nothing exists that could be waiting on this thread. It is
/// the same ground `sweep_live_markers` stands on two lines above it. The doctrine
/// forbids blocking a UI; there is no UI yet to block.
///
/// `spawn_blocking` was the alternative and is strictly worse here: this answer decides
/// what the FIRST window shows, so deferring it means the launcher paints and is then
/// retroactively adopted — a visible flicker, bought with nothing.
///
/// A bad argument comes back `Err` and the caller falls back to the launcher. Refusing to
/// start is worse than ignoring a typo, and a half-open window is worse than both.
#[cfg(desktop)]
fn resolve_cli<I: IntoIterator<Item = String>>(args: I) -> Result<CliIntent, String> {
    match parse_cli_args(args)? {
        CliRequest::Launcher => Ok(CliIntent::Launcher),
        CliRequest::Project(raw) => Ok(CliIntent::Project(resolve_project(&raw)?)),
        CliRequest::Resume(id) => resolve_session(&id),
    }
}

/// Conversations the command line asked for, waiting for their window's webview to come up
/// and ask. Keyed by window label — minted Rust-side, never derived from argv.
#[derive(Default)]
struct PendingResume {
    inner: Mutex<HashMap<String, String>>,
}

/// The conversation `--resume` asked this window to open, if any. `None` for every
/// ordinary launch, and for every window but the one the CLI opened.
///
/// Ask-don't-tell, like `window_project`, and forced by the same fact: at the moment the
/// command line is resolved there is no webview to push an event to, and no listener
/// registered if there were. So Rust holds the answer and the window comes and asks.
///
/// CONSUMING. A resume happens once: leave the id in place and a webview reload re-opens
/// the conversation forever, and a window the user has since navigated away from snaps
/// back to it the next time anything remounts.
#[tauri::command]
async fn pending_resume(window: WebviewWindow) -> Option<String> {
    let pending = window.state::<PendingResume>();
    // Short, uncontended, no I/O: no `spawn_blocking` needed or wanted.
    let mut guard = pending.inner.lock().ok()?;
    guard.remove(window.label())
}

/// Act on a resolved command line. Runs inside `setup`, before the event loop.
///
/// Goes through `open_project` rather than building a window here. That command owns the
/// atomic check-and-reserve, the label minting and the registry insert; a second opener
/// would duplicate windows the instant the two disagreed, which is the exact thing
/// `open_project` exists to prevent. The launcher window already exists and has no
/// project, so this takes its `Adopt` arm — a CLI launch costs no extra window and leaves
/// no empty one behind. If the project is somehow already open (it cannot be this early,
/// but the arm is free), `Focus` raises that window instead of duplicating it.
#[cfg(desktop)]
fn apply_cli(app: &AppHandle, intent: CliIntent) -> Result<(), String> {
    let (cwd, session_id) = match intent {
        CliIntent::Launcher => return Ok(()),
        CliIntent::Project(cwd) => (cwd, None),
        CliIntent::Resume { cwd, session_id } => (cwd, Some(session_id)),
    };

    // The config-minted launcher — the only window alive this early.
    let window = app
        .webview_windows()
        .into_values()
        .next()
        .ok_or("no window to open the project in")?;

    // `open_project` is `async`, but the arm this takes only holds a short lock and sets a
    // title. It never reaches `build()`, so there is nothing here for the event loop to
    // pump and blocking on it cannot deadlock — the loop has not started either way.
    let outcome = tauri::async_runtime::block_on(open_project(app.clone(), window, cwd))?;

    if let Some(session_id) = session_id {
        app.state::<PendingResume>()
            .inner
            .lock()
            .map_err(|e| e.to_string())?
            // Keyed by the label `open_project` just told us owns the project. Argv named
            // a folder; it did not, and cannot, name a window.
            .insert(outcome.label, session_id);
    }
    Ok(())
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
    key: SessionKey,
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
                    key.emit(&app, "acp-update", params);
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
                    key.emit(&app, "acp-permission", payload);
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
        key.emit(&app, "acp-closed", json!({"reason": "grok stopped"}));
    });
}

/// Drain stderr so a chatty agent can't fill the pipe buffer and wedge itself.
///
/// `acp-stderr` currently has no listener on the webview side, so routing it costs
/// nothing today and could be argued away. It goes through `SessionKey::emit` with the
/// other seven anyway, on purpose: the moment one event keeps a hand-written `tabId`
/// and a bare `emit`, "every session event is routed" stops being an invariant you can
/// check by grepping for `emit(` and becomes a list you have to remember. The exclusion
/// would cost more than the inclusion — and the day someone adds a stderr console, it
/// is already correct rather than quietly cross-window.
fn spawn_stderr_drain(app: AppHandle, key: SessionKey, stderr: ChildStderr) {
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                key.emit(&app, "acp-stderr", json!({"line": line}));
            }
        }
    });
}

/// `acp-connect {tabId, stage, sessionId?, message?}` — the text-only decoration for
/// the connect/open-session wait. The command's promise stays the source of truth for
/// state; these events only ever drive a status line.
fn emit_connect(
    app: &AppHandle,
    key: &SessionKey,
    stage: &str,
    session_id: Option<&str>,
    message: Option<&str>,
) {
    let mut payload = json!({"stage": stage});
    if let Some(obj) = payload.as_object_mut() {
        if let Some(id) = session_id {
            obj.insert("sessionId".into(), Value::String(id.to_string()));
        }
        if let Some(m) = message {
            obj.insert("message".into(), Value::String(m.to_string()));
        }
    }
    key.emit(app, "acp-connect", payload);
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
///
/// Takes no identity: `tabId` is stamped by `SessionKey::emit` on the way out, like
/// every other session event. A payload builder that also knew who it was for would be
/// a second writer of `tabId`, and two writers is how they drift.
fn build_permission_payload(req: &Value, tuid: &str) -> Value {
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
fn start_approval(
    app: &AppHandle,
    key: &SessionKey,
    session_id: &str,
    stop: Arc<AtomicBool>,
    emitted: Arc<Mutex<HashSet<String>>>,
) {
    let Some(root) = bridge_root() else { return };
    for sub in ["req", "resp", "live"] {
        let _ = std::fs::create_dir_all(root.join(sub));
    }
    let _ = install_approval_hook(); // idempotent; also installed pre-spawn in connect()
    let _ = std::fs::write(root.join("live").join(session_id), b"1");

    let app = app.clone();
    let key = key.clone();
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
                    // Claim the card BEFORE emitting it, never after: the user can click
                    // Allow the instant the event lands, and a `respond_hook` that beat
                    // this insert would be told the request isn't theirs — a card that
                    // refuses its own answer. The auto-allowed reads above deliberately
                    // never enter the set; nobody is ever asked about them, so nobody can
                    // answer for them.
                    if let Ok(mut e) = emitted.lock() {
                        e.insert(stem.clone());
                    }
                    key.emit(&app, "acp-permission", build_permission_payload(&reqv, &stem));
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
///
/// Every caller must prove the card is theirs. The bridge's `resp/<toolUseId>.json`
/// namespace is flat and global — nothing in it says who a request belongs to — so
/// without the check below this command writes any decision for any session on behalf
/// of anyone who can name a tool-use id, and the id is right there in the event payload.
/// The `emitted` set is the proof, and consuming it (`remove`) means one card gets
/// exactly one answer: a second click, a duplicate event, or another window racing the
/// same id all land here and are refused.
///
/// `window` is the runtime's, not the webview's (see `SessionKey`), so the identity
/// this resolves against cannot be spoofed by the caller.
#[tauri::command]
fn respond_hook(
    window: WebviewWindow,
    tab_id: String,
    tool_use_id: String,
    allow: bool,
) -> Result<(), String> {
    let key = SessionKey::for_window(&window, tab_id);

    // Lock order: AcpState -> emitted. Clone the Arc out, DROP the AcpState guard, and
    // only then take the inner lock. Holding both at once here while `start_approval`'s
    // watcher takes only `emitted` is how this deadlocks.
    let state = window.state::<AcpState>();
    let emitted = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard.get(&key).map(|s| s.emitted.clone())
    };

    let unanswered = match emitted {
        Some(emitted) => {
            let mut set = emitted.lock().map_err(|e| e.to_string())?;
            set.remove(&tool_use_id)
        }
        None => false,
    };
    if !unanswered {
        return Err("That request isn't yours.".to_string());
    }

    write_decision(&tool_use_id, allow)
}

/// Ask the live agent for a session in `cwd`. Separated so it can be retried after sign-in.
fn new_session(
    app: &AppHandle,
    state: &State<AcpState>,
    key: &SessionKey,
    cwd: &str,
) -> Result<Result<String, String>, String> {
    let (stdin, pending, next_id, session_key) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard.get(key).ok_or("not connected to grok")?;
        (
            s.stdin.clone(),
            s.pending.clone(),
            s.next_id.clone(),
            s.key.clone(),
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
            // Clone the Arcs out under the guard; `start_approval` runs after it drops.
            let armed = if let Ok(mut guard) = state.inner.lock() {
                guard.get_mut(key).map(|s| {
                    s.session_id = Some(id.clone());
                    (s.approval_stop.clone(), s.emitted.clone())
                })
            } else {
                None
            };
            // Arm the approval gate for this session before the user can prompt.
            if let Some((stop, emitted)) = armed {
                start_approval(app, &session_key, &id, stop, emitted);
            }
            Ok(Ok(id))
        }
        Err(e) => Ok(Err(e)),
    }
}

/// Load an existing session into an already-connected agent. The agent replays its
/// updates before replying, then this makes the loaded id the tab's live session.
fn load_existing_session(
    app: &AppHandle,
    state: &State<AcpState>,
    key: &SessionKey,
    cwd: &str,
    session_id: &str,
) -> Result<Result<String, String>, String> {
    let (stdin, pending, next_id, session_key) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard.get(key).ok_or("not connected to grok")?;
        (
            s.stdin.clone(),
            s.pending.clone(),
            s.next_id.clone(),
            s.key.clone(),
        )
    };
    let auth = request(
        &stdin,
        &pending,
        &next_id,
        "authenticate",
        json!({"methodId": "cached_token"}),
    )?;
    let _ = auth
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "grok didn't answer `authenticate` in time".to_string())??;
    let rx = request(
        &stdin,
        &pending,
        &next_id,
        "session/load",
        json!({"sessionId": session_id, "cwd": cwd, "mcpServers": []}),
    )?;
    let outcome = rx
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "grok didn't answer `session/load` in time".to_string())?;

    match outcome {
        Ok(_) => {
            let id = session_id.to_string();
            let armed = if let Ok(mut guard) = state.inner.lock() {
                guard.get_mut(key).map(|s| {
                    // `connect` opens a throwaway session first. Its watcher only
                    // matches that id, so stop it before watching the loaded one.
                    s.approval_stop.store(true, Ordering::SeqCst);
                    // Drop the throwaway's live marker by hand: the watcher thread
                    // doesn't clear it on stop, and `Session::kill` only ever clears
                    // whatever `session_id` holds — which is about to be the loaded
                    // id. Left alone, every resume strands a marker in live/.
                    if let (Some(root), Some(old)) = (bridge_root(), s.session_id.as_ref()) {
                        if old != &id {
                            let _ = std::fs::remove_file(root.join("live").join(old));
                        }
                    }
                    let stop = Arc::new(AtomicBool::new(false));
                    s.session_id = Some(id.clone());
                    s.approval_stop = stop.clone();
                    // FRESH stop, but the SAME `emitted` Arc: the tab is the same tab and
                    // any card it already showed is still on screen and still answerable.
                    // Handing the re-armed watcher an empty set would strand those cards
                    // — `respond_hook` would reject the user's click on a card the app
                    // itself drew.
                    (stop, s.emitted.clone())
                })
            } else {
                None
            };
            // Arm the approval gate for this session before the user can prompt.
            if let Some((stop, emitted)) = armed {
                start_approval(app, &session_key, &id, stop, emitted);
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
async fn connect(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    cwd: String,
) -> Result<ConnectResult, String> {
    let key = SessionKey::for_window(&window, tab_id);
    tauri::async_runtime::spawn_blocking(move || connect_blocking(app, key, cwd))
        .await
        .map_err(|e| e.to_string())?
}

fn connect_blocking(app: AppHandle, key: SessionKey, cwd: String) -> Result<ConnectResult, String> {
    // First statement, before the reconnect kill and before resolve_grok(): every
    // slow case (gatekeeper, a cold binary, the unbounded `grok --version` probe in
    // resolve_grok) happens inside or before resolve, so emitting later would make
    // this stage unreachable exactly when it's the one worth showing.
    emit_connect(&app, &key, "spawning", None, None);

    let state = app.state::<AcpState>();

    // The guard is a temporary of this `let`, so it is dropped before `kill()` below —
    // `Session::kill` blocks in `child.wait()` and must never run under the state lock.
    let existing = state.inner.lock().map_err(|e| e.to_string())?.remove(&key);
    // Carry the approval-card set across the displacement. This tab's cards are still on
    // screen: reconnecting is not the same as the user dismissing them. A replacement
    // Session with an empty `emitted` would make `respond_hook` reject a click on a card
    // this very tab drew — trading the cross-window steal for a same-window lockout on
    // the ordinary paths (re-opening a folder in a live tab, resuming a conversation).
    let emitted = match existing {
        Some(existing) => {
            let carried = existing.emitted.clone();
            existing.kill();
            carried
        }
        None => Arc::new(Mutex::new(HashSet::new())),
    };

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
            emit_connect(&app, &key, "failed", None, Some(&msg));
            return Err(msg);
        }
    };

    let stdin = Arc::new(Mutex::new(stdin));
    if let Some(stderr) = stderr {
        spawn_stderr_drain(app.clone(), key.clone(), stderr);
    }

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicI64::new(1));
    spawn_reader(
        app.clone(),
        key.clone(),
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

        // In-flight connect guard. The window can be closed at any point above — the
        // spawn, the handshake — and the `Destroyed` handler drains only what is already
        // in the map. Inserting now would hand a live grok to a window that no longer
        // exists, and nothing would ever come back for it. Re-check while holding the
        // map lock: the handler removes the registry entry BEFORE it drains, so "entry
        // present" here means the drain has not passed us by.
        //
        // Lock order note: this is the only place that nests AcpState -> WindowRegistry.
        // Nothing anywhere holds WindowRegistry and then takes AcpState (the `Destroyed`
        // handler releases the registry lock before draining), so the nesting is safe.
        //
        // A window always has a registry entry before any of its tabs can connect — a tab
        // needs a cwd, and a cwd only exists via `open_project`, which inserts the entry.
        // So "no entry" here means the window is gone, not that it never had a project.
        let window_alive = app
            .state::<WindowRegistry>()
            .inner
            .lock()
            .map(|registry| registry.contains_key(&key.window))
            .unwrap_or(false);
        if !window_alive {
            drop(map);
            // `guard` still owns the child, so its Drop kills and reaps it right here.
            return Err("That window was closed.".to_string());
        }

        // Non-destructive: a racing connect for the same tab must not orphan the
        // session it displaces (double-click the folder button).
        if let Some(old) = map.insert(
            key.clone(),
            Session {
                key: key.clone(),
                child: guard.into_inner(),
                stdin: stdin.clone(),
                session_id: None,
                next_id: next_id.clone(),
                pending: pending.clone(),
                approval_stop: Arc::new(AtomicBool::new(false)),
                emitted,
            },
        ) {
            drop(map);
            old.kill();
        }
    }

    let handshake = || -> Result<ConnectResult, String> {
        emit_connect(&app, &key, "handshaking", None, None);

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

        emit_connect(&app, &key, "session", None, None);

        // Try for a session; a fresh install will bounce us to sign-in instead.
        match new_session(&app, &state, &key, &cwd)? {
            Ok(session_id) => {
                emit_connect(&app, &key, "ready", Some(&session_id), None);
                Ok(ConnectResult {
                    needs_auth: false,
                    auth_methods,
                    session_id: Some(session_id),
                })
            }
            Err(e) if is_auth_error(&e) => {
                emit_connect(&app, &key, "needs_auth", None, None);
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
            let orphan = state.inner.lock().ok().and_then(|mut g| g.remove(&key));
            if let Some(orphan) = orphan {
                orphan.kill();
            }
            emit_connect(&app, &key, "failed", None, Some(&e));
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
    window: WebviewWindow,
    state: State<AcpState>,
    tab_id: String,
    method_id: String,
) -> Result<(), String> {
    let key = SessionKey::for_window(&window, tab_id);
    let (stdin, pending, next_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard.get(&key).ok_or("not connected to grok")?;
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
        key.emit(&app, "acp-auth", payload);
    });
    Ok(())
}

/// Open a session after a successful sign-in.
#[tauri::command]
async fn open_session(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    cwd: String,
) -> Result<String, String> {
    let key = SessionKey::for_window(&window, tab_id);
    // Both Result levels stay inside the closure; flatten at the await boundary.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        emit_connect(&app, &key, "session", None, None);
        let state = app.state::<AcpState>();
        let outcome = new_session(&app, &state, &key, &cwd);
        match &outcome {
            Ok(Ok(id)) => emit_connect(&app, &key, "ready", Some(id), None),
            Ok(Err(e)) | Err(e) => emit_connect(&app, &key, "failed", None, Some(e)),
        }
        outcome
    })
    .await
    .map_err(|e| e.to_string())?;
    outcome?
}

/// Load a past session after connecting its project to a live agent.
#[tauri::command]
async fn load_session(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    cwd: String,
    session_id: String,
) -> Result<String, String> {
    let key = SessionKey::for_window(&window, tab_id);
    // Both Result levels stay inside the closure; flatten at the await boundary.
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        emit_connect(&app, &key, "session", None, None);
        let state = app.state::<AcpState>();
        let outcome = load_existing_session(&app, &state, &key, &cwd, &session_id);
        match &outcome {
            Ok(Ok(id)) => emit_connect(&app, &key, "ready", Some(id), None),
            Ok(Err(e)) | Err(e) => {
                if is_auth_error(e) {
                    emit_connect(&app, &key, "needs_auth", None, None);
                }
                emit_connect(&app, &key, "failed", None, Some(e));
            }
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
    window: WebviewWindow,
    state: State<AcpState>,
    tab_id: String,
    request_id: i64,
    option_id: Option<String>,
) -> Result<(), String> {
    let key = SessionKey::for_window(&window, tab_id);
    let stdin = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard
            .get(&key)
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
    window: WebviewWindow,
    state: State<AcpState>,
    tab_id: String,
    text: String,
) -> Result<(), String> {
    let key = SessionKey::for_window(&window, tab_id);
    let (stdin, pending, next_id, session_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard
            .get(&key)
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
        key.emit(&app, event, payload);
    });
    Ok(())
}

/// Tear a tab's session down. `Session::kill` reaps the child with a blocking
/// `wait()`, so this must never run on the main thread — it is the escape hatch
/// from a wait, and would otherwise freeze the UI it exists to unfreeze.
#[tauri::command]
async fn cancel(app: AppHandle, window: WebviewWindow, tab_id: String) -> Result<(), String> {
    let key = SessionKey::for_window(&window, tab_id);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AcpState>();
        cancel_blocking(&state, &key)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cancel_blocking(state: &State<AcpState>, key: &SessionKey) -> Result<(), String> {
    let session = state.inner.lock().map_err(|e| e.to_string())?.remove(key);
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

/// How many sessions are live right now, app-wide across every window.
///
/// App-global on purpose. The updater is a process-level event — it replaces the binary
/// every window is running — so "are we busy?" is a question about the app, not about the
/// window that happens to be showing the banner. Answering per-window would let a user
/// update from a quiet window while another window is mid-turn.
#[tauri::command]
async fn busy_sessions(app: AppHandle) -> usize {
    let state = app.state::<AcpState>();
    // A poisoned map means a thread panicked somewhere, not that nothing is running;
    // reporting 0 would turn that into a silent "safe to update".
    // Bound to a local so the lock temporary drops before `state` does.
    let busy = match state.inner.lock() {
        Ok(guard) => guard.len(),
        Err(e) => e.into_inner().len(),
    };
    busy
}

/// Tear down every session in every window, without quitting.
///
/// The updater's gate calls this before relaunching, so an update never leaves a grok
/// child running against a binary that is being replaced underneath it. Blocking body,
/// so: `async fn` + `spawn_blocking`, never a bare `#[tauri::command(async)]`.
#[tauri::command]
async fn shutdown_all(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || shutdown_everything(&app))
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before anything can arm a gate: clear the previous run's stale `live/` markers.
    sweep_live_markers();

    // The command line, parsed AND resolved against the disk, before the builder exists —
    // no window, no webview, no event loop, so the `--resume` scan has no UI to block.
    // See `resolve_cli` for why this is here rather than behind `spawn_blocking`.
    #[cfg(desktop)]
    let cli = resolve_cli(std::env::args().skip(1));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    let builder = builder
        .manage(AcpState::default())
        .manage(WindowRegistry::default())
        .manage(PendingResume::default())
        // Per-window teardown. `Destroyed`, not `CloseRequested`: teardown needs no veto
        // (the session map is app-level, not window-owned), nothing must delay the close,
        // and `RunEvent::Exit`'s join — not a `prevent_close` dance — is what guarantees
        // the work finishes. Registered on the Builder, which pushes handlers onto a Vec
        // (app.rs:2064), so this and the tray's focus tracker coexist without merging.
        .on_window_event(|window, event| {
            if !matches!(event, tauri::WindowEvent::Destroyed) {
                return;
            }
            let label = window.label().to_string();

            // Registry entry first, and this is the ONLY place a LIVE window's entry is
            // removed. Until it goes, `open_project` would happily "focus" a window that
            // no longer exists, and the project could never be reopened.
            if let Ok(mut guard) = window.state::<WindowRegistry>().inner.lock() {
                guard.remove(&label);
            }

            // Ordering with the in-flight-connect guard in `connect_blocking`: the entry
            // is dropped BEFORE this drain, so a connect racing us either inserts before
            // the drain (and is caught here) or finds no entry and kills its own child.
            // There is no gap between the two for a grok to survive in.
            let sessions = drain_window(&window.state::<AcpState>(), &label);
            if sessions.is_empty() {
                return;
            }

            // NEVER kill on the event-loop thread: `Session::kill` blocks in
            // `child.wait()`, which would freeze every other window while one closes.
            // The handle is pushed to TEARDOWN rather than detached — a detached thread
            // gets killed mid-`wait()` when this was the last window (see TEARDOWN).
            let handle = thread::spawn(move || {
                for session in sessions {
                    session.kill();
                }
            });
            if let Ok(mut guard) = TEARDOWN.lock() {
                // Finished handles are already done killing; dropping them keeps a long
                // run of opening and closing windows from growing this without bound.
                guard.retain(|h| !h.is_finished());
                guard.push(handle);
            }
        })
        .invoke_handler(tauri::generate_handler![
            grok_installed,
            auth_status,
            install_grok,
            recent_projects,
            list_sessions,
            search_sessions,
            open_project,
            window_project,
            pending_resume,
            connect,
            authenticate,
            open_session,
            load_session,
            respond_permission,
            respond_hook,
            send_prompt,
            cancel,
            busy_sessions,
            shutdown_all
        ]);

    // Registered separately from the teardown handler above — Builder handlers stack
    // (app.rs:2064), so these two compose without either knowing about the other.
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::Focused(true) = event {
            if let Ok(mut guard) = FOCUSED_WINDOW.lock() {
                *guard = Some(window.label().to_string());
            }
        }
    });

    #[cfg(desktop)]
    let builder = builder.setup(move |app| {
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

        // argv, applied before the event loop starts, so a `<app> <path>` launch has its
        // project registered before the webview can ask `window_project` for it — no
        // launcher flash, no race with the frontend's first invoke.
        //
        // Reported and then ignored on failure, never fatal: the launcher is a working
        // app and a typo shouldn't cost the user their launch. stderr is the right place
        // for it — the only way to pass args is to have started the binary from a
        // terminal, so there is someone there to read it.
        if let Err(message) = cli.and_then(|intent| apply_cli(app.handle(), intent)) {
            eprintln!("grok-build-desktop: {message}");
        }

        let show = MenuItem::with_id(app, "show", "Show Grok Build", true, None::<&str>)?;
        let new_chat = MenuItem::with_id(app, "newchat", "New chat", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &new_chat, &quit])?;

        let mut tray = TrayIconBuilder::new()
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                // `RunEvent::Exit` does the real work — it kills every grok child and
                // joins every teardown thread before the process goes. Until that
                // existed, this line orphaned every child the app had spawned.
                "quit" => app.exit(0),
                "show" => tray_show(app),
                "newchat" => match tray_target(app) {
                    Some(window) => {
                        reveal(&window);
                        // `emit_to`, not `emit`: broadcasting this would open a new chat
                        // in EVERY window at once, when the user asked for one.
                        let _ = app.emit_to(window.label(), "tray-new-chat", ());
                    }
                    // Nothing open to put a chat in. The launcher is the honest answer:
                    // a new chat needs a project, and there is no project to guess at.
                    None => open_launcher(app),
                },
                _ => {}
            })
            // The left-click path is a SECOND closure — it is not part of the menu match
            // above, and a change to "show" has to be mirrored here or the two diverge.
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    tray_show(tray.app_handle());
                }
            });

        if let Some(icon) = app.default_window_icon().cloned() {
            tray = tray.icon(icon);
        }
        let _ = tray.build(app)?;
        Ok(())
    });

    // `build()` then `run(callback)` rather than `run(context)`: the callback is the only
    // way to see `RunEvent::Exit`, and Exit is where every grok child gets reaped.
    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown_everything(app);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(window: &str, tab: &str) -> SessionKey {
        SessionKey {
            window: window.to_string(),
            tab: tab.to_string(),
        }
    }

    /// The property `take_window` exists for: draining one window must take exactly
    /// that window's sessions, hand them back OWNED (so the caller can kill them with
    /// the lock released), and leave every other window's sessions untouched. A tab id
    /// repeated across windows — which the frontend's per-window `nextTabId` counter
    /// makes the common case, not the exotic one — must not be collateral damage.
    #[test]
    fn take_window_takes_only_that_window() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(key("w2", "1"), 21);
        map.insert(key("w2", "2"), 22);
        map.insert(key("w3", "1"), 31); // same tab id as w2's — different session
        map.insert(key("main", "1"), 11);

        let mut taken = take_window(&mut map, "w2");
        taken.sort_unstable();
        assert_eq!(taken, vec![21, 22], "must return w2's values, owned");

        assert_eq!(map.len(), 2, "must remove exactly what it returned");
        assert_eq!(map.get(&key("w3", "1")), Some(&31), "w3 tab 1 must survive");
        assert_eq!(map.get(&key("main", "1")), Some(&11), "main must survive");
    }

    /// Draining a window that has no sessions is a no-op, not a panic — `EXIT` and the
    /// `Destroyed` handler both run it against windows that may never have connected.
    #[test]
    fn take_window_unknown_label_is_empty() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(key("main", "1"), 11);

        assert!(take_window(&mut map, "w9").is_empty());
        assert_eq!(map.len(), 1, "an unmatched drain must not disturb the map");
    }

    /// A `SessionKey` is only equal to itself: neither half alone is an identity. This
    /// is the whole point of the re-key — a bare tab id is ambiguous across windows.
    #[test]
    fn session_key_needs_both_halves() {
        assert_ne!(key("w2", "1"), key("w3", "1"), "same tab, other window");
        assert_ne!(key("w2", "1"), key("w2", "2"), "same window, other tab");
        assert_eq!(key("w2", "1"), key("w2", "1"));
    }

    #[cfg(desktop)]
    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    /// The three documented shapes, plus the two ways argv can be hostile or merely odd.
    /// `parse_cli_args` is the untrusted boundary, so what it *refuses* matters as much as
    /// what it accepts — and "no args is the launcher" is the no-regression promise.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_covers_the_three_shapes() {
        assert_eq!(parse_cli_args(argv(&[])), Ok(CliRequest::Launcher));
        assert_eq!(
            parse_cli_args(argv(&["."])),
            Ok(CliRequest::Project(".".to_string())),
            "`.` is a path, not a flag"
        );
        assert_eq!(
            parse_cli_args(argv(&["../projB"])),
            Ok(CliRequest::Project("../projB".to_string()))
        );
        assert_eq!(
            parse_cli_args(argv(&["--resume", "019f685d-a168-79b3-9e25-e694c7e2e1b2"])),
            Ok(CliRequest::Resume(
                "019f685d-a168-79b3-9e25-e694c7e2e1b2".to_string()
            ))
        );

        // A dangling `--resume` must not silently degrade into the launcher: the user
        // asked for a conversation and would never learn they didn't get one.
        assert!(parse_cli_args(argv(&["--resume"])).is_err());
        assert!(parse_cli_args(argv(&["--resume", "  "])).is_err());

        // macOS hands a GUI binary flags nobody typed. Ignoring them is what keeps an
        // ordinary launch from being reported as a failure.
        assert_eq!(
            parse_cli_args(argv(&["-psn_0_12345"])),
            Ok(CliRequest::Launcher)
        );
        assert_eq!(
            parse_cli_args(argv(&["-psn_0_12345", "/tmp/projB"])),
            Ok(CliRequest::Project("/tmp/projB".to_string()))
        );
    }

    #[cfg(desktop)]
    fn meta(id: &str, cwd: &str) -> SessionMeta {
        SessionMeta {
            id: id.to_string(),
            title: String::new(),
            summary: String::new(),
            cwd: cwd.to_string(),
            created_at: String::new(),
            updated_at: String::new(),
            num_messages: 0,
        }
    }

    /// `--resume <id>`'s whole premise: an id alone names a project, because the store is
    /// `~/.grok/sessions/<percent-encoded cwd>/<sessionId>/`. The walk is
    /// `list_sessions_inner`'s (already exercised by the sidebar); what is new — and what
    /// this pins — is that the id maps to exactly one cwd and an unknown id maps to none,
    /// rather than to a plausible-looking wrong project.
    #[cfg(desktop)]
    #[test]
    fn pick_session_cwd_maps_an_id_to_its_project() {
        // `SessionMeta` is a wire type and not `Clone`; rebuild the store per lookup.
        let store = || {
            vec![
                meta("019f685d-a168-79b3-9e25-e694c7e2e1b2", "/tmp/projB"),
                meta("019f6856-d431-7bd2-a59c-b03ff0112a20", "/Users/x/gba/fabri"),
            ]
        };

        assert_eq!(
            pick_session_cwd(store(), "019f685d-a168-79b3-9e25-e694c7e2e1b2"),
            Some("/tmp/projB".to_string())
        );
        assert_eq!(
            pick_session_cwd(store(), "019f6856-d431-7bd2-a59c-b03ff0112a20"),
            Some("/Users/x/gba/fabri".to_string())
        );
        assert_eq!(
            pick_session_cwd(store(), "not-a-real-id"),
            None,
            "an unknown id must resolve to nothing, never to the first project"
        );
    }
}
