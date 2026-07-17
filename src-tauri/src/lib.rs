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

/// The window title for a project: the app, then the folder.
///
/// The folder alone reads fine in isolation and terribly in a dock or a window
/// switcher, where "fabri" next to a dozen other windows says nothing about which
/// app owns it. The launcher keeps the config's bare "Grok Build Desktop" — it has
/// no project to name yet.
fn window_title(cwd: &str) -> String {
    format!("Grok Build Desktop — {}", basename(cwd))
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

/// Consume this session's claim on `tool_use_id` — "is this decision yours to make?".
///
/// `Ok(())` is returned at most ONCE per emitted card, because the check removes. The
/// two ways to be told no are deliberately the same answer: `None` (this key has no
/// session, so it never emitted anything) and "not in the set" (never emitted, or
/// already answered) both mean the caller cannot speak for this id.
///
/// Split out of `respond_hook` so the property above is testable: `respond_hook` needs a
/// live `WebviewWindow`, which cannot be constructed in a unit test, and this is the
/// half that carries the safety argument.
fn claim_emitted(
    emitted: Option<Arc<Mutex<HashSet<String>>>>,
    tool_use_id: &str,
) -> Result<(), String> {
    let unanswered = match emitted {
        Some(emitted) => {
            let mut set = emitted.lock().map_err(|e| e.to_string())?;
            set.remove(tool_use_id)
        }
        None => false,
    };
    if !unanswered {
        return Err("That request isn't yours.".to_string());
    }
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

    claim_emitted(emitted, &tool_use_id)?;

    write_decision(&tool_use_id, allow)
}

/// Pulls the model state a `session/new`/`session/load` response carries alongside
/// `sessionId` into a compact `{ currentModelId?, model?: {...} }` shape.
///
/// The response's model-state field isn't part of the frozen `sessionId` contract this
/// file already parses, so this is deliberately tolerant of shape: some agent builds
/// hang it off `result.models`, others `result.modelState`, others bury it in
/// `result._meta`. Whichever container has it wins; the raw `result` itself is the
/// last fallback for an agent that puts `currentModelId`/`availableModels` top-level.
/// Returns `None` when the response carries no model info at all — additive-only,
/// never a hard error, since the caller (`new_session`/`load_existing_session`) must
/// keep working against agents that don't advertise model state.
fn parse_session_model(result: &Value) -> Option<Value> {
    let container = result
        .get("models")
        .or_else(|| result.get("modelState"))
        .or_else(|| result.get("_meta"))
        .unwrap_or(result);

    let current_model_id = container.get("currentModelId").and_then(Value::as_str);

    // Prefer the entry matching `currentModelId`; fall back to the list's first entry
    // so a response that omits `currentModelId` (but still advertises one model) still
    // surfaces something.
    let model_entry = container
        .get("availableModels")
        .and_then(Value::as_array)
        .and_then(|models| {
            current_model_id
                .and_then(|cid| {
                    models.iter().find(|m| {
                        m.get("modelId").and_then(Value::as_str) == Some(cid)
                            || m.get("id").and_then(Value::as_str) == Some(cid)
                    })
                })
                .or_else(|| models.first())
        });

    if current_model_id.is_none() && model_entry.is_none() {
        return None;
    }

    let mut out = serde_json::Map::new();
    if let Some(cid) = current_model_id {
        out.insert("currentModelId".into(), Value::String(cid.to_string()));
    }
    if let Some(m) = model_entry {
        let mut model = serde_json::Map::new();
        for field in [
            "name",
            "description",
            "totalContextTokens",
            "supportsReasoningEffort",
            "reasoningEffort",
            "reasoningEfforts",
        ] {
            if let Some(v) = m.get(field) {
                model.insert(field.to_string(), v.clone());
            }
        }
        if !model.is_empty() {
            out.insert("model".into(), Value::Object(model));
        }
    }

    if out.is_empty() {
        None
    } else {
        Some(Value::Object(out))
    }
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
            // Additive: model state rides alongside `sessionId` in the same response,
            // so surface it right after parsing that — a session with no model info at
            // all (an agent that doesn't advertise it) just emits nothing here.
            if let Some(model_info) = parse_session_model(&result) {
                session_key.emit(
                    app,
                    "acp-session-info",
                    json!({"sessionId": id, "model": model_info}),
                );
            }
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
        Ok(result) => {
            let id = session_id.to_string();
            // Additive, same as `new_session`: emit model state if this response
            // carried any, right after the id is settled.
            if let Some(model_info) = parse_session_model(&result) {
                session_key.emit(
                    app,
                    "acp-session-info",
                    json!({"sessionId": id, "model": model_info}),
                );
            }
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
            // `get`, not `&s[..]`: the index is a BYTE offset into a `str`, so a `%`
            // followed by a multi-byte char ("%aé") slices mid-character and panics.
            // Every store walker runs this on every directory name, and a panic on the
            // blocking pool comes back as a JoinError that `unwrap_or_default()` turns
            // into an empty Vec — so one oddly-named directory would silently empty the
            // whole sidebar and recents, reporting nothing. `None` here just falls
            // through to the literal-`%` path below, which is what the "malformed
            // escapes are left alone" contract already promises.
            if let Ok(b) = u8::from_str_radix(s.get(i + 1..i + 3).unwrap_or(""), 16) {
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

/// Does a window's cwd filter exclude this session-store folder? `None` (no filter)
/// keeps everything.
///
/// **EXACT STRING COMPARE, and that is a trap worth naming.** The store's folder name is
/// whatever the CLI percent-encoded when the session was made — the path the user
/// originally typed. Anything that renames the same directory (canonicalizing `/tmp` to
/// `/private/tmp` on macOS, a trailing slash, a case difference on a case-insensitive
/// volume) compares unequal here and empties the sidebar SILENTLY: the walk returns an
/// empty Vec, never an Err, so there is nothing for the UI to report. This is precisely
/// why `ProjectEntry.cwd` stores the user's original path and only `ProjectEntry.key` is
/// canonicalized (see `project_key`), and why `absolutize` refuses to resolve symlinks.
///
/// Split out of the two walkers so that contract is stated in one place and can be tested
/// without a session store on disk.
fn cwd_filter_excludes(filter: Option<&str>, folder_cwd: &str) -> bool {
    filter.is_some_and(|filter| filter != folder_cwd)
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
    list_sessions_at(&home.join(".grok/sessions"), cwd)
}

/// The walk itself, pointed at an explicit store root.
///
/// Split from `list_sessions_inner` for one reason: `home_dir()` is the machine's real
/// `~`, so with the root baked in there was no way to test the walk without reading the
/// user's actual conversations. Every caller in the app still passes `~/.grok/sessions`;
/// only tests point it at a temp dir.
fn list_sessions_at(root: &Path, cwd: Option<String>) -> Vec<SessionMeta> {
    let Ok(project_entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };

    let mut sessions = Vec::new();
    for project_entry in project_entries.flatten().filter(|entry| entry.path().is_dir()) {
        let folder_cwd = percent_decode(&project_entry.file_name().to_string_lossy());
        if cwd_filter_excludes(cwd.as_deref(), &folder_cwd) {
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
                .unwrap_or(UNTITLED)
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

/// Directory names the @-mention walk never descends into.
///
/// `.git`/`node_modules`/`target`/`dist`/`.next`/`build`/`.venv`/`__pycache__` by name
/// (they're huge, generated, or both, in any project); every OTHER dotdir is skipped by
/// the leading-`.` check below rather than listed here one at a time — an allowlist of
/// dotdirs to skip would silently miss whichever tool's cache dir hasn't been added yet.
const SKIP_DIRS: [&str; 8] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    ".next",
    "build",
    ".venv",
    "__pycache__",
];

/// How deep the @-mention walk descends, and how many files it will collect.
///
/// Both exist for the same reason: this walks a directory the USER chose, not one this
/// app controls the shape of, and a project with a deeply nested tree or hundreds of
/// thousands of files must not hang the picker or the app. Hitting either cap stops the
/// walk cleanly (no error, no partial-looking failure) rather than exhausting memory or
/// time trying to enumerate everything.
const MAX_WALK_DEPTH: usize = 8;
const MAX_WALK_FILES: usize = 5000;

#[tauri::command]
async fn list_project_files(cwd: String) -> Result<Vec<String>, String> {
    // The walk touches disk and can be arbitrarily large (see `MAX_WALK_FILES`), so it
    // never runs on the tokio worker (HANDOFF.md #2) — `spawn_blocking`, and the `PathBuf`
    // is built and consumed entirely inside the closure.
    tauri::async_runtime::spawn_blocking(move || list_project_files_inner(Path::new(&cwd)))
        .await
        .map_err(|e| format!("The file list didn't finish: {e}"))
}

/// The walk itself, pointed at an explicit root.
///
/// Split from the command for the same reason as `list_sessions_at`: a pure `&Path ->
/// Vec<String>` fn is testable against a temp fixture without touching a real project.
/// Returns paths relative to `root`, forward-slash-joined regardless of host OS, sorted,
/// so the frontend's `filterFiles` gets a stable, comparable list to fuzzy-match against.
fn list_project_files_inner(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk_project_files(root, root, 0, &mut out);
    out.sort();
    out
}

fn walk_project_files(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_WALK_DEPTH || out.len() >= MAX_WALK_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= MAX_WALK_FILES {
            return;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();

        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            // Every dotdir is skipped, not just the named ones above (`SKIP_DIRS`) — see
            // its doc comment for why an allowlist alone isn't enough.
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            walk_project_files(root, &path, depth + 1, out);
        } else if file_type.is_file() {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            // Forward-slash unconditionally: this feeds `@mention` tokens the user types
            // and the frontend compares, so a Windows `\` would silently never match.
            let relative = relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.push(relative);
        }
    }
}

/// One conversation that matched, and WHY it matched.
///
/// The "why" is half the feature, not decoration. The old search returned bare ids: with
/// 33 of 50 conversations carrying no `generated_title` they all render as an identical
/// "Untitled conversation", so a result list was a wall of the same row with nothing to
/// tell them apart and no way to see what the query had hit.
#[derive(Serialize, Clone, Debug, PartialEq)]
struct SearchHit {
    id: String,
    /// The matched text with its surroundings, each hit term wrapped in
    /// `SNIPPET_OPEN`/`SNIPPET_CLOSE` — FTS5's `snippet()` output, rendered as emphasis
    /// by the frontend. `None` for a title hit: the title IS the evidence and it's
    /// already the row's headline, so repeating it underneath would be noise.
    snippet: Option<String>,
    /// True when the row's own visible title contains the query. Title hits sort first.
    from_title: bool,
}

/// The answer to one search: the hits, plus whether the content half actually ran.
///
/// `content_error` is the point of the struct. Content search reads an index we do not
/// own and cannot repair — it can be missing, locked, or a schema we don't know. If that
/// were folded into an empty `hits` the UI would render "No matches", which is a lie
/// about conversations sitting on disk. Title hits are computed independently and are
/// still returned alongside the error, so a degraded search is a SHORTER answer with a
/// warning, never a wrong one.
#[derive(Serialize, Clone, Debug, PartialEq)]
struct SearchResults {
    hits: Vec<SearchHit>,
    content_error: Option<String>,
}

/// What a conversation is called when it has no name of its own. OURS, not the user's
/// data — which is exactly why title search has to know about it (see `search_sessions_at`).
/// On this machine 36 of 53 conversations land here: grok writes `generated_title` and
/// `session_summary` lazily, and most sessions never get either.
const UNTITLED: &str = "(untitled)";

/// How `snippet()` marks the matched terms inside a snippet.
///
/// STX/ETX rather than the obvious `[`/`]`. The snippet is verbatim transcript text, and
/// transcripts are full of real brackets — every markdown link and array index — so with
/// `[`/`]` the frontend could not tell a match from text that merely looked like one, and
/// would emphasise the wrong words. These two control characters cannot occur in the
/// prose being quoted, so the marking is unambiguous. They never reach the DOM: the
/// frontend splits on them and drops them (see `splitSnippet`).
const SNIPPET_OPEN: char = '\u{2}';
const SNIPPET_CLOSE: char = '\u{3}';

/// The schema this code was written against. `session_search.sqlite` belongs to the grok
/// CLI, not to us; if it moves to a shape we don't understand, degrade rather than guess
/// at columns that may have changed meaning.
const SESSION_SEARCH_SCHEMA_VERSION: &str = "4";

/// Turn a user's raw words into an FTS5 phrase query.
///
/// Everything gets wrapped in one double-quoted phrase, and any `"` inside is doubled.
/// This does two jobs at once:
///   * It makes the search LITERAL and word-tokenized, which is the actual bug fix.
///     The old code did a substring grep, so "data" hit `data`base, meta`data` and
///     vali`data`ted, and matched 48 of 48 conversations. As a phrase, "data" matches
///     the word `data` and nothing else.
///   * It neutralises FTS5's query syntax. Unescaped, a user typing `AND`, `*`, `:` or
///     an unbalanced quote is either a syntax error or, worse, a silently different
///     search than the one they typed. Inside a quoted phrase all of it is just text.
fn fts_phrase_query(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}

#[tauri::command]
async fn search_sessions(query: String, cwd: Option<String>) -> SearchResults {
    // A store walk plus a SQLite query is blocking work, so it does NOT belong on a tokio
    // worker (v0.8.4). A JoinError can't become an empty result here — that's the exact
    // "silent empty list" this feature exists to kill — so it degrades with a reason.
    tauri::async_runtime::spawn_blocking(move || search_sessions_inner(query, cwd))
        .await
        .unwrap_or_else(|e| SearchResults {
            hits: Vec::new(),
            content_error: Some(format!("The search didn't finish: {e}")),
        })
}

fn search_sessions_inner(query: String, cwd: Option<String>) -> SearchResults {
    let Some(home) = home_dir() else {
        return SearchResults {
            hits: Vec::new(),
            content_error: Some("Couldn't find your home folder.".to_string()),
        };
    };
    search_sessions_at(&home.join(".grok/sessions"), &query, cwd.as_deref())
}

/// Search, pointed at an explicit store root. See `list_sessions_at` for why the root is
/// a parameter.
///
/// TITLE FIRST, and the two halves are deliberately independent:
///
///   1. Titles come from `summary.json` via the same walk that builds the sidebar. No
///      index involved, 100% coverage.
///   2. Content comes from grok's own FTS5 index — ranked, word-tokenized, with snippets.
///
/// That split is not a style choice. The index is LAZY and races: 51 of 53 conversations
/// are indexed here, and the 2 that aren't are not empty (one has 31 messages). Content
/// search therefore misses ~4% of conversations, which is only acceptable because title
/// search covers every one of them independently. Route titles through the index to save
/// a walk and a conversation the indexer missed becomes unfindable by any means.
fn search_sessions_at(root: &Path, query: &str, cwd: Option<&str>) -> SearchResults {
    let query = query.trim();
    if query.is_empty() {
        return SearchResults { hits: Vec::new(), content_error: None };
    }

    // --- 1. Titles: from data we already have. ---------------------------------------
    // Match the title the row actually DISPLAYS (`list_sessions_at` already resolves
    // generated_title -> session_summary -> "(untitled)"). The old code also matched
    // `session_summary` when a `generated_title` existed and hid it — a row whose visible
    // text does not contain your query, with nothing to explain itself. That is the same
    // "why did this match?" bug in a smaller costume.
    let needle = query.to_lowercase();
    let sessions = list_sessions_at(root, cwd.map(str::to_string));
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for session in sessions {
        // `UNTITLED` is OUR placeholder, not the user's text, and 36 of 53 conversations
        // carry it. Matching it would make the query "untitled" return all 36 as one
        // indistinguishable block — the very wall of identical rows this change exists to
        // break up, rebuilt out of a string we invented. A conversation with no title has
        // nothing for a title search to match; the content half still covers it.
        if session.title == UNTITLED {
            continue;
        }
        if session.title.to_lowercase().contains(&needle) {
            seen.insert(session.id.clone());
            hits.push(SearchHit { id: session.id, snippet: None, from_title: true });
        }
    }

    // --- 2. Content: grok's FTS5 index. ----------------------------------------------
    let content_error = match search_content(root, query, cwd) {
        Ok(found) => {
            // Ranked below every title hit, and never duplicating one.
            hits.extend(found.into_iter().filter(|hit| !seen.contains(&hit.id)));
            None
        }
        Err(e) => Some(e),
    };

    SearchResults { hits, content_error }
}

/// Query grok's FTS5 index. `Err` means "content search could not run", and the caller
/// must surface it — never swallow it into an empty list.
fn search_content(root: &Path, query: &str, cwd: Option<&str>) -> Result<Vec<SearchHit>, String> {
    let db = root.join("session_search.sqlite");
    if !db.is_file() {
        return Err("Content search is unavailable — Grok hasn't built its search index yet. Titles are still searched.".to_string());
    }

    // READ-ONLY, and that matters: this is the CLI's database and grok may be writing to
    // it right now. `mode=ro` means a bug here can never corrupt the user's history. The
    // index is journal_mode=wal, so our reads and grok's writes coexist; `busy_timeout`
    // covers the brief exclusive locks WAL still takes (e.g. checkpointing) instead of
    // failing the search outright.
    let uri = format!("file:{}?mode=ro", db.display());
    let conn = rusqlite::Connection::open_with_flags(
        &uri,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("Content search is unavailable — couldn't open the search index: {e}"))?;
    conn.busy_timeout(Duration::from_millis(2000))
        .map_err(|e| format!("Content search is unavailable — couldn't open the search index: {e}"))?;

    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'session_search_schema_version'",
            [],
            |row| row.get(0),
        )
        .ok();
    if version.as_deref() != Some(SESSION_SEARCH_SCHEMA_VERSION) {
        // Not an error to hide: a newer grok could rename columns under us, and guessing
        // is how you return confidently wrong results.
        return Err(format!(
            "Content search is unavailable — Grok's search index is version {}, and this app understands version {}. Titles are still searched.",
            version.as_deref().unwrap_or("unknown"),
            SESSION_SEARCH_SCHEMA_VERSION,
        ));
    }

    // bm25() is NEGATIVE and lower is better, so ORDER BY rank ASC is best-first. Title
    // is weighted 10x content: within the content half, a conversation whose indexed
    // title carries the query still outranks a passing mention in a transcript.
    //
    // The cwd compare is EXACT, matching `cwd_filter_excludes` — see the note there. It
    // is correct here for a verified reason: `session_docs.cwd` is byte-identical to the
    // percent-decoded store folder name for all 51 indexed conversations on this machine,
    // because grok writes the same string to both. It is NOT canonicalized. `/private/tmp`
    // shows up as a cwd not because `/tmp` was resolved, but because `%2Fprivate%2Ftmp`
    // is its own folder with its own conversations — `%2Ftmp` exists separately, holding
    // different ones. Canonicalizing either side to "fix" the symlink would MERGE two
    // projects the store deliberately keeps apart, and break the filter it was meant to
    // repair.
    let mut stmt = conn
        .prepare(
            "SELECT d.session_id, snippet(session_docs_fts, 1, ?3, ?4, '…', 8)
             FROM session_docs_fts f
             JOIN session_docs d ON d.rowid = f.rowid
             WHERE session_docs_fts MATCH ?1
               AND (?2 IS NULL OR d.cwd = ?2)
             ORDER BY bm25(session_docs_fts, 10.0, 1.0)
             LIMIT 200",
        )
        .map_err(|e| format!("Content search is unavailable — the search index rejected the query: {e}"))?;

    let rows = stmt
        // The delimiters are BOUND, not written into the SQL, so `SNIPPET_OPEN`/
        // `SNIPPET_CLOSE` are the single source of truth the frontend's `splitSnippet`
        // is matched against. Spelled as `char(2)` in the query text they'd be a second,
        // silent copy of the contract that a change to the constants wouldn't reach.
        .query_map(
            rusqlite::params![
                fts_phrase_query(query),
                cwd,
                SNIPPET_OPEN.to_string(),
                SNIPPET_CLOSE.to_string(),
            ],
            |row| {
                let id: String = row.get(0)?;
                let snippet: Option<String> = row.get(1)?;
                Ok(SearchHit {
                    id,
                    snippet: snippet.filter(|s| !s.trim().is_empty()),
                    from_title: false,
                })
            },
        )
        .map_err(|e| format!("Content search is unavailable — the search index rejected the query: {e}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Content search is unavailable — couldn't read the search index: {e}"))
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

/// The CLI's own `--version` line, trimmed. A blocking subprocess call, so — same
/// doctrine as `grok_installed`/`auth_status` — it runs off the async runtime's
/// worker pool via `spawn_blocking`, never inline on the command thread.
#[tauri::command]
async fn grok_version() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(grok_version_inner)
        .await
        .map_err(|e| e.to_string())?
}

fn grok_version_inner() -> Result<String, String> {
    let grok = resolve_grok().ok_or("grok CLI not found")?;
    let output = Command::new(&grok)
        .arg("--version")
        .output()
        .map_err(|e| format!("couldn't run `grok --version`: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "`grok --version` exited with {}",
            output.status
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let first_line = text.lines().next().unwrap_or("").trim().to_string();
    if first_line.is_empty() {
        return Err("`grok --version` printed nothing".to_string());
    }
    Ok(first_line)
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

/// Blocking helper for `rewind_points`: list checkpoints for a tab's live session.
/// Follows the `new_session`/`load_existing_session` shape — outer `Result` is our own
/// lookup/transport failure, inner `Result` is the agent's own error reply.
fn rewind_points_blocking(
    state: &State<AcpState>,
    key: &SessionKey,
) -> Result<Result<Value, String>, String> {
    let (stdin, pending, next_id, session_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard
            .get(key)
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
        "x.ai/rewind/points",
        json!({"sessionId": session_id}),
    )?;
    Ok(rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "grok didn't answer `x.ai/rewind/points` in time".to_string())?)
}

/// List rewind checkpoints (~one per prompt) for the tab's live session. Returns the
/// agent's raw reply shape as-is — the wire contract is unverified, so normalization
/// happens client-side.
#[tauri::command]
async fn rewind_points(app: AppHandle, window: WebviewWindow, tab_id: String) -> Result<Value, String> {
    let key = SessionKey::for_window(&window, tab_id);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AcpState>();
        rewind_points_blocking(&state, &key)
    })
    .await
    .map_err(|e| e.to_string())?;
    outcome?
}

/// Blocking helper for `rewind_execute`: restore a chosen checkpoint. `mode` is one of
/// "conversation" | "files" | "both", passed through verbatim — validated in-app, not here.
fn rewind_execute_blocking(
    state: &State<AcpState>,
    key: &SessionKey,
    point_id: &str,
    mode: &str,
) -> Result<Result<Value, String>, String> {
    let (stdin, pending, next_id, session_id) = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        let s = guard
            .get(key)
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
        "x.ai/rewind/execute",
        json!({"sessionId": session_id, "pointId": point_id, "mode": mode}),
    )?;
    Ok(rx
        .recv_timeout(Duration::from_secs(60))
        .map_err(|_| "grok didn't answer `x.ai/rewind/execute` in time".to_string())?)
}

/// Restore a chosen rewind checkpoint. Destructive when `mode` is "files" or "both" —
/// that gating lives entirely in the frontend's two-step confirm; this command just
/// forwards the already-confirmed request.
#[tauri::command]
async fn rewind_execute(
    app: AppHandle,
    window: WebviewWindow,
    tab_id: String,
    point_id: String,
    mode: String,
) -> Result<Value, String> {
    let key = SessionKey::for_window(&window, tab_id);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AcpState>();
        rewind_execute_blocking(&state, &key, &point_id, &mode)
    })
    .await
    .map_err(|e| e.to_string())?;
    outcome?
}

/// Expose the app's hardcoded read-only auto-approval allowlist to the UI, for display only.
///
/// Transparency, not authority: this just clones `READONLY_TOOLS` so Preferences can show the
/// user what runs unattended. The hook script's `case` arm remains the sole enforcement point —
/// nothing reads this value back into the approval path.
#[tauri::command]
fn readonly_tools() -> Vec<String> {
    READONLY_TOOLS.iter().map(|s| s.to_string()).collect()
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
            grok_version,
            install_grok,
            recent_projects,
            list_sessions,
            list_project_files,
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
            shutdown_all,
            readonly_tools,
            rewind_points,
            rewind_execute
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

    // What is deliberately NOT tested here, and why — so the gaps are a decision rather
    // than an oversight:
    //
    //   * Anything needing a live `AppHandle` / `WebviewWindow`: `SessionKey::for_window`,
    //     `SessionKey::emit`, `emit_connect`, `respond_hook`, `connect_blocking`,
    //     `open_project`, `window_project`, `pending_resume`, `shutdown_everything`, the
    //     tray. Tauri offers no constructor for these outside a running app, and a fake
    //     would prove only that the fake works. `claim_emitted` and `take_window` exist as
    //     separate fns precisely so the load-bearing halves land on this side of the line.
    //   * `drain_window`: its value type is pinned to `Session`, which owns a live `Child`
    //     and cannot be built in a test. `take_window` is the generic seam under it and is
    //     tested exhaustively; `drain_window` adds only the poison-tolerant lock.
    //   * `list_sessions_inner` / `search_sessions_inner` / `recent_projects_inner`: these
    //     resolve `home_dir()` and so read the REAL `~/.grok/sessions` store. Tests must
    //     never touch a user's data. `list_sessions_at` / `search_sessions_at` are the same
    //     code with the root as a PARAMETER and are tested exhaustively against a temp store
    //     built by `store()` below; the `_inner` fns add only the `home_dir()` join.
    //     `recent_projects_inner` keeps the old shape, so `cwd_filter_excludes` remains the
    //     seam for the one subtle thing in it — the exact string compare.
    //   * `write_decision` / `install_approval_hook` / `sweep_live_markers`: all write into
    //     the user's real `~/.grok`. Same rule.
    //   * `resolve_grok` / `home_dir`: probe the machine and the environment. Mutating `HOME`
    //     from a test would race every other test in the process.
    //   * `TEARDOWN`: a process-wide static; asserting on it would make tests order-dependent.

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

    /// The degenerate case the `Destroyed` handler hits most often: a window closed
    /// before any tab ever connected. Nothing in the map at all.
    #[test]
    fn take_window_empty_map_is_empty() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        assert!(take_window(&mut map, "w2").is_empty());
        assert!(map.is_empty());
    }

    /// One window, one session — the single-window install, which is most people.
    #[test]
    fn take_window_single_session() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(key("main", "1"), 11);

        assert_eq!(take_window(&mut map, "main"), vec![11]);
        assert!(map.is_empty(), "the map must be emptied, not just filtered");
    }

    /// Many windows, many tabs each, interleaved in the map. The drain must be exact at
    /// scale — this is the shape at quit time with a real session in every window.
    #[test]
    fn take_window_many_windows_interleaved() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        // Tab ids repeat across every window on purpose: the frontend's `nextTabId` is
        // per-window, so "every window has a tab 1" is the normal state of the app.
        for (w, window) in ["main", "w2", "w3", "w4"].iter().enumerate() {
            for tab in 1..=4u32 {
                map.insert(key(window, &tab.to_string()), (w as u32 * 10) + tab);
            }
        }
        assert_eq!(map.len(), 16);

        let mut taken = take_window(&mut map, "w3");
        taken.sort_unstable();
        assert_eq!(taken, vec![21, 22, 23, 24], "exactly w3's four sessions");
        assert_eq!(map.len(), 12, "the other three windows are untouched");
        for window in ["main", "w2", "w4"] {
            for tab in 1..=4u32 {
                assert!(
                    map.contains_key(&key(window, &tab.to_string())),
                    "{window} tab {tab} must survive a w3 drain"
                );
            }
        }
    }

    /// Draining the same window twice is idempotent: the second pass finds nothing. A
    /// `Destroyed` racing `RunEvent::Exit` runs exactly this, and a double-take would mean
    /// two threads calling `kill()` on one child.
    #[test]
    fn take_window_twice_yields_nothing_the_second_time() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(key("w2", "1"), 21);
        map.insert(key("w3", "1"), 31);

        assert_eq!(take_window(&mut map, "w2"), vec![21]);
        assert!(take_window(&mut map, "w2").is_empty());
        assert_eq!(map.len(), 1, "w3 survives both passes");
    }

    /// The match is EXACT EQUALITY, never a prefix. `w2` and `w22` are different windows,
    /// and the registry's counter mints both once you have opened ten projects. A
    /// `starts_with` here would silently kill a live window's grok children when a
    /// completely different window closed.
    #[test]
    fn take_window_label_match_is_exact_not_prefix() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(key("w2", "1"), 21);
        map.insert(key("w22", "1"), 221);
        map.insert(key("w222", "1"), 2221);

        assert_eq!(take_window(&mut map, "w2"), vec![21]);
        assert_eq!(map.len(), 2, "w22 and w222 are NOT w2");
        assert_eq!(map.get(&key("w22", "1")), Some(&221));
        assert_eq!(map.get(&key("w222", "1")), Some(&2221));
    }

    /// A `SessionKey` is only equal to itself: neither half alone is an identity. This
    /// is the whole point of the re-key — a bare tab id is ambiguous across windows.
    #[test]
    fn session_key_needs_both_halves() {
        assert_ne!(key("w2", "1"), key("w3", "1"), "same tab, other window");
        assert_ne!(key("w2", "1"), key("w2", "2"), "same window, other tab");
        assert_eq!(key("w2", "1"), key("w2", "1"));
    }

    /// The window half alone is not an identity: one window's two tabs are two sessions.
    #[test]
    fn session_key_window_alone_is_not_an_identity() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(key("w2", "1"), 1);
        map.insert(key("w2", "2"), 2);
        map.insert(key("w2", "3"), 3);
        assert_eq!(map.len(), 3, "three tabs in one window are three sessions");
    }

    /// The tab half alone is not an identity: the same tab id in two windows is two
    /// sessions, and this is the COMMON case, not a corner one — `nextTabId` restarts at
    /// 1 in every window, so window A's tab 1 and window B's tab 1 always coexist.
    #[test]
    fn session_key_tab_alone_is_not_an_identity() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(key("main", "1"), 11);
        map.insert(key("w2", "1"), 21);
        map.insert(key("w3", "1"), 31);
        assert_eq!(map.len(), 3, "one tab id, three windows, three sessions");
        assert_eq!(map.get(&key("w2", "1")), Some(&21), "no cross-window aliasing");
    }

    /// Re-inserting the same key replaces — that is what makes a reconnect displace its
    /// own session (and only its own) in `connect_blocking`.
    #[test]
    fn session_key_equal_keys_collide_in_a_map() {
        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        assert_eq!(map.insert(key("w2", "1"), 1), None);
        assert_eq!(map.insert(key("w2", "1"), 2), Some(1), "same key replaces");
        assert_eq!(map.len(), 1);
    }

    /// The two halves must not be concatenatable into each other. A key built by gluing
    /// the strings together ("a" + "bc" == "ab" + "c") would alias two distinct sessions;
    /// the derived `Hash`/`Eq` over two separate `String` fields is what prevents it.
    #[test]
    fn session_key_halves_do_not_bleed_into_each_other() {
        assert_ne!(key("a", "bc"), key("ab", "c"));
        assert_ne!(key("", "w21"), key("w2", "1"));

        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(key("a", "bc"), 1);
        map.insert(key("ab", "c"), 2);
        assert_eq!(map.len(), 2, "no boundary-ambiguity collision");
    }

    /// Empty halves are still distinct values, not wildcards.
    #[test]
    fn session_key_empty_halves_are_distinct_values() {
        assert_ne!(key("", "1"), key("1", ""));
        assert_ne!(key("", ""), key("w2", ""));
        assert_eq!(key("", ""), key("", ""));
    }

    /// A clone is the same identity — `SessionKey` is cloned into every reader thread,
    /// stderr drain and watcher, and each must still address the tab it came from.
    #[test]
    fn session_key_clone_is_the_same_identity() {
        let original = key("w2", "1");
        let cloned = original.clone();
        assert_eq!(original, cloned);

        let mut map: HashMap<SessionKey, u32> = HashMap::new();
        map.insert(original, 21);
        assert_eq!(map.get(&cloned), Some(&21), "a clone must find its own entry");
    }

    /// A representative `session/new` response: `currentModelId` + `availableModels`
    /// nested under `models`, the shape this app has actually observed. Covers the
    /// happy path (find the matching entry, keep only the documented fields) and the
    /// "no model state at all" / "no matching entry" edges in one place.
    #[test]
    fn parse_session_model_extracts_the_current_model() {
        let result = json!({
            "sessionId": "s1",
            "models": {
                "currentModelId": "grok-4",
                "availableModels": [
                    {
                        "modelId": "grok-4",
                        "name": "Grok 4",
                        "description": "Flagship reasoning model",
                        "totalContextTokens": 256000,
                        "supportsReasoningEffort": true,
                        "reasoningEffort": "high",
                        "reasoningEfforts": ["low", "medium", "high"],
                        "irrelevantField": "ignored"
                    },
                    {
                        "modelId": "grok-4-fast",
                        "name": "Grok 4 Fast"
                    }
                ]
            }
        });

        let info = parse_session_model(&result).expect("model info present");
        assert_eq!(info["currentModelId"], json!("grok-4"));
        assert_eq!(info["model"]["name"], json!("Grok 4"));
        assert_eq!(info["model"]["description"], json!("Flagship reasoning model"));
        assert_eq!(info["model"]["totalContextTokens"], json!(256000));
        assert_eq!(info["model"]["supportsReasoningEffort"], json!(true));
        assert_eq!(info["model"]["reasoningEffort"], json!("high"));
        assert_eq!(
            info["model"]["reasoningEfforts"],
            json!(["low", "medium", "high"])
        );
        // Only the documented fields are copied — an unknown field never leaks through.
        assert!(info["model"].get("irrelevantField").is_none());
    }

    /// A response that carries no model state at all (an agent that doesn't advertise
    /// it) must yield `None`, not a mostly-empty object — the caller uses `Some`/`None`
    /// to decide whether to emit `acp-session-info` at all.
    #[test]
    fn parse_session_model_is_none_when_absent() {
        let result = json!({"sessionId": "s1"});
        assert_eq!(parse_session_model(&result), None);
    }

    /// Tolerates the `modelState`-shaped alternative, and falls back to the list's
    /// first entry when `currentModelId` doesn't match any `availableModels` entry.
    #[test]
    fn parse_session_model_tolerates_modelstate_and_falls_back_to_first_entry() {
        let result = json!({
            "sessionId": "s1",
            "modelState": {
                "currentModelId": "unknown-id",
                "availableModels": [
                    {"id": "grok-4", "name": "Grok 4"}
                ]
            }
        });
        let info = parse_session_model(&result).expect("model info present");
        assert_eq!(info["currentModelId"], json!("unknown-id"));
        assert_eq!(info["model"]["name"], json!("Grok 4"));
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

    /// An empty store answers nothing. `--resume` on a machine that has never run grok
    /// must say "no such conversation", not panic and not guess.
    #[cfg(desktop)]
    #[test]
    fn pick_session_cwd_empty_store_is_none() {
        assert_eq!(pick_session_cwd(Vec::new(), "any-id"), None);
    }

    /// The id match is exact. A session id that merely CONTAINS or PREFIXES the query must
    /// not answer for it — resolving `--resume abc` onto `abcdef`'s project would open a
    /// window on a folder the user never named.
    #[cfg(desktop)]
    #[test]
    fn pick_session_cwd_matches_the_whole_id_only() {
        let store = || {
            vec![
                meta("abcdef", "/tmp/long"),
                meta("xyz-abc", "/tmp/suffix"),
            ]
        };
        assert_eq!(pick_session_cwd(store(), "abc"), None, "not a prefix match");
        assert_eq!(pick_session_cwd(store(), "def"), None, "not a suffix match");
        assert_eq!(pick_session_cwd(store(), "bcde"), None, "not a substring match");
        assert_eq!(
            pick_session_cwd(store(), "abcdef"),
            Some("/tmp/long".to_string())
        );
    }

    /// The cwd handed back is `info.cwd` verbatim — including a path with a space, which
    /// is ordinary on macOS ("~/Documents/My Project") and is the input most likely to be
    /// mangled by anything that re-parses it.
    #[cfg(desktop)]
    #[test]
    fn pick_session_cwd_returns_the_path_verbatim() {
        let sessions = vec![meta("id-1", "/Users/x/My Projects/café app")];
        assert_eq!(
            pick_session_cwd(sessions, "id-1"),
            Some("/Users/x/My Projects/café app".to_string()),
            "spaces and unicode must survive untouched"
        );
    }

    // ---- Tier 1: the approval `emitted` set -----------------------------------
    //
    // `claim_emitted` is the whole answer to "is this decision yours to make?". The
    // bridge's `resp/<toolUseId>.json` namespace is flat and global, so if this check is
    // ever weakened, any window can approve any other window's file write — with the id
    // sitting right there in the event payload.

    fn emitted_set(ids: &[&str]) -> Arc<Mutex<HashSet<String>>> {
        Arc::new(Mutex::new(
            ids.iter().map(|id| id.to_string()).collect::<HashSet<_>>(),
        ))
    }

    /// An id that was never emitted is not answerable. This is the cross-window steal:
    /// window B names window A's tool-use id, and its own session never showed that card.
    #[test]
    fn claim_emitted_refuses_an_id_that_was_never_emitted() {
        let set = emitted_set(&["mine-1"]);
        assert_eq!(
            claim_emitted(Some(set.clone()), "someone-elses-id"),
            Err("That request isn't yours.".to_string())
        );
        assert_eq!(
            set.lock().unwrap().len(),
            1,
            "a refused claim must not disturb the cards that ARE ours"
        );
    }

    /// An empty set answers for nothing. A tab that has never been asked about anything
    /// cannot approve anything.
    #[test]
    fn claim_emitted_empty_set_refuses_everything() {
        let set = emitted_set(&[]);
        assert!(claim_emitted(Some(set), "any-id").is_err());
    }

    /// No session for this key at all (the tab was cancelled, the window closed, or the
    /// key never existed) is the same answer as "not yours" — never a pass.
    #[test]
    fn claim_emitted_no_session_refuses() {
        assert_eq!(
            claim_emitted(None, "anything"),
            Err("That request isn't yours.".to_string())
        );
    }

    /// The core property: an emitted id is answerable EXACTLY ONCE. The check consumes,
    /// so a double-click, a duplicated event, or a second window racing the same id all
    /// land on the second call and are refused.
    #[test]
    fn claim_emitted_is_consuming_exactly_once() {
        let set = emitted_set(&["tuid-1"]);

        assert!(claim_emitted(Some(set.clone()), "tuid-1").is_ok(), "first answer wins");
        assert!(
            claim_emitted(Some(set.clone()), "tuid-1").is_err(),
            "the second answer must be refused — the check REMOVES"
        );
        assert!(
            claim_emitted(Some(set.clone()), "tuid-1").is_err(),
            "and stays refused"
        );
        assert!(set.lock().unwrap().is_empty(), "consuming keeps the set bounded");
    }

    /// Claiming one card leaves every other card on the same tab answerable. A tab can
    /// have several approvals on screen at once, and answering the first must not
    /// invalidate the rest.
    #[test]
    fn claim_emitted_consumes_only_the_claimed_id() {
        let set = emitted_set(&["a", "b", "c"]);

        assert!(claim_emitted(Some(set.clone()), "b").is_ok());
        assert_eq!(set.lock().unwrap().len(), 2);
        assert!(claim_emitted(Some(set.clone()), "a").is_ok(), "a is still answerable");
        assert!(claim_emitted(Some(set.clone()), "c").is_ok(), "c is still answerable");
        assert!(set.lock().unwrap().is_empty());
    }

    /// The claim is by exact id. A prefix or substring of a live card's id must not
    /// consume it — ids come off the wire from the webview, so a loose match here is a
    /// forgery surface.
    #[test]
    fn claim_emitted_matches_the_whole_id_only() {
        let set = emitted_set(&["toolu_01ABCDEF"]);

        assert!(claim_emitted(Some(set.clone()), "toolu_01").is_err(), "no prefix match");
        assert!(claim_emitted(Some(set.clone()), "ABCDEF").is_err(), "no suffix match");
        assert!(claim_emitted(Some(set.clone()), "").is_err(), "empty claims nothing");
        assert_eq!(set.lock().unwrap().len(), 1, "the real card is still pending");
        assert!(claim_emitted(Some(set), "toolu_01ABCDEF").is_ok());
    }

    /// Two sessions' sets are independent objects. This is the shape after
    /// `connect_blocking` carries one tab's Arc across a displacement while another tab's
    /// set stays its own: consuming from one must never reach into the other.
    #[test]
    fn claim_emitted_sets_are_per_session() {
        let window_a = emitted_set(&["shared-looking-id"]);
        let window_b = emitted_set(&["shared-looking-id"]);

        assert!(claim_emitted(Some(window_a.clone()), "shared-looking-id").is_ok());
        assert!(
            window_a.lock().unwrap().is_empty(),
            "A's card is consumed"
        );
        assert_eq!(
            window_b.lock().unwrap().len(),
            1,
            "B's identically-named card is untouched — the sets do not alias"
        );
        assert!(
            claim_emitted(Some(window_b), "shared-looking-id").is_ok(),
            "and B can still answer its own"
        );
    }

    /// A carried Arc is the SAME set. `connect_blocking` and `load_existing_session` both
    /// clone this Arc into a replacement Session so a card already on screen stays
    /// answerable across a reconnect; if the clone ever became a deep copy, the app would
    /// reject a click on a card it drew itself.
    #[test]
    fn claim_emitted_carried_arc_shares_one_set() {
        let original = emitted_set(&["tuid-1"]);
        let carried = original.clone(); // exactly what connect_blocking does

        assert!(claim_emitted(Some(carried.clone()), "tuid-1").is_ok());
        assert!(
            original.lock().unwrap().is_empty(),
            "the carried Arc must be the same set, not a copy"
        );
        assert!(
            claim_emitted(Some(original), "tuid-1").is_err(),
            "and one card still gets exactly one answer through either handle"
        );
    }

    // ---- Tier 1: install_stage bucketing --------------------------------------

    /// Every arm reachable from a line install.sh actually prints, checked against the
    /// real script rather than inferred.
    #[test]
    fn install_stage_buckets_real_installer_lines() {
        assert_eq!(install_stage("Fetching latest stable version..."), "resolving");
        assert_eq!(install_stage("  Downloading grok 0.2.102..."), "downloading");
        assert_eq!(
            install_stage("  Updated /Users/x/.grok/bin in PATH in /Users/x/.zshrc."),
            "configuring"
        );
        // The fallback arm, reached by the two lines that close a successful install.
        assert_eq!(
            install_stage("  Binary linked to /usr/local/bin/grok"),
            "installing"
        );
        assert_eq!(
            install_stage("Grok 0.2.102 installed to /Users/x/.grok/bin/grok"),
            "installing"
        );
    }

    /// The channel is interpolated into the "Fetching latest ${CHANNEL} version..." line,
    /// so every channel must still resolve — the match is on the invariant prefix.
    #[test]
    fn install_stage_resolving_survives_any_channel() {
        for channel in ["stable", "beta", "nightly", ""] {
            assert_eq!(
                install_stage(&format!("Fetching latest {channel} version...")),
                "resolving",
                "channel {channel:?} must still bucket as resolving"
            );
        }
    }

    /// Matching is case-insensitive: the fn lowercases first, and the installer's own
    /// capitalisation is not a contract we control.
    #[test]
    fn install_stage_is_case_insensitive() {
        assert_eq!(install_stage("FETCHING LATEST STABLE VERSION"), "resolving");
        assert_eq!(install_stage("DOWNLOADING GROK"), "downloading");
        assert_eq!(install_stage("Updated BIN_DIR in path"), "configuring");
    }

    /// `INSTALL_MARKER` is the gate in `spawn_install_reader`: nothing renders until a line
    /// contains it, so the marker line is ALWAYS the first line the user sees bucketed. It
    /// must therefore bucket as `resolving` — if the two ever drift, the first visible
    /// stage silently becomes the "installing" fallback.
    #[test]
    fn install_marker_line_buckets_as_resolving() {
        assert_eq!(install_stage(INSTALL_MARKER), "resolving");
        assert_eq!(
            install_stage("Fetching latest stable version...").to_string(),
            install_stage(INSTALL_MARKER).to_string(),
            "the marker and the real line must agree"
        );
    }

    /// There is deliberately NO verifying/extracting arm: install.sh prints no such line
    /// (it downloads a bare binary and its only check is a silent `--version` smoke test).
    /// A bucket that can never fire is a stage we would be claiming exists. Pin the
    /// absence so nobody re-adds one.
    #[test]
    fn install_stage_has_no_verifying_or_extracting_bucket() {
        assert_eq!(
            install_stage("  Verifying checksum..."),
            "installing",
            "a verify line must fall to the honest fallback, not mint a `verifying` stage"
        );
        assert_eq!(install_stage("  Extracting archive..."), "installing");
        assert_eq!(install_stage("  Unpacking..."), "installing");
        assert_eq!(install_stage("  Validating signature..."), "installing");
    }

    /// The label set is CLOSED — exactly four buckets. The frontend switches on these
    /// strings, so a fifth label invented here renders as nothing at all.
    #[test]
    fn install_stage_only_ever_returns_the_four_known_labels() {
        const KNOWN: [&str; 4] = ["resolving", "downloading", "configuring", "installing"];
        let corpus = [
            "Fetching latest stable version...",
            "  Downloading grok 0.2.102...",
            "  Updated /Users/x/.grok/bin in PATH in /Users/x/.zshrc.",
            "  Binary linked to /usr/local/bin/grok",
            "Grok 0.2.102 installed to /Users/x/.grok/bin/grok",
            "",
            "   ",
            "curl: (22) The requested URL returned error: 404",
            "bash: line 1: syntax error near unexpected token",
            "Verifying...",
            "🎉 done",
        ];
        for line in corpus {
            let stage = install_stage(line);
            assert!(
                KNOWN.contains(&stage),
                "line {line:?} produced unknown stage {stage:?}"
            );
        }
    }

    /// An empty or whitespace line falls to the fallback rather than panicking. The
    /// reader filters empties before calling, so this is belt-and-braces on a fn whose
    /// input is a foreign script's stdout.
    #[test]
    fn install_stage_empty_line_falls_back() {
        assert_eq!(install_stage(""), "installing");
        assert_eq!(install_stage("   "), "installing");
    }

    /// Arm order is load-bearing where a line could match two: "downloading" is checked
    /// before "path", so a download line mentioning a path still reads as downloading.
    #[test]
    fn install_stage_earlier_arms_win() {
        assert_eq!(
            install_stage("  Downloading grok to $PATH..."),
            "downloading",
            "downloading is checked before the path arm"
        );
        assert_eq!(
            install_stage("Fetching latest stable version from a path..."),
            "resolving",
            "resolving is checked first of all"
        );
    }

    // ---- Tier 2: parse_cli_args ------------------------------------------------

    /// `--resume` takes the NEXT argv item verbatim, even when it looks like a flag. A
    /// session id is a UUID, so this never mis-fires in practice; when it does, the id is
    /// checked against the store by `resolve_session` and comes back as a clear "No
    /// conversation with id `--foo`" rather than a silent launcher.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_resume_takes_the_next_arg_verbatim() {
        assert_eq!(
            parse_cli_args(argv(&["--resume", "--foo"])),
            Ok(CliRequest::Resume("--foo".to_string())),
            "the value is not re-parsed as a flag; the disk gate rejects it downstream"
        );
    }

    /// A path AND `--resume` together: the first bare positional wins, exactly as
    /// documented. `--resume` after it is never reached.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_path_before_resume_takes_the_path() {
        assert_eq!(
            parse_cli_args(argv(&["/tmp/projB", "--resume", "some-id"])),
            Ok(CliRequest::Project("/tmp/projB".to_string())),
            "the first bare positional wins"
        );
    }

    /// `--resume` before a path: the resume returns immediately and the trailing path is
    /// never consumed. The two orders give different answers, and that is the documented
    /// "first thing recognised wins" rule, not an accident.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_resume_before_path_takes_the_resume() {
        assert_eq!(
            parse_cli_args(argv(&["--resume", "some-id", "/tmp/projB"])),
            Ok(CliRequest::Resume("some-id".to_string()))
        );
    }

    /// Every unknown `-`-prefixed arg is IGNORED, never an error. macOS hands a
    /// double-clicked GUI binary `-psn_0_...`; erroring on an unknown flag would turn
    /// every single Finder launch into a failure. This is the regression that would be
    /// invisible in a terminal and total in the wild.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_ignores_every_unknown_flag() {
        for flag in ["-psn_0_12345", "-NSDocumentRevisionsDebugMode", "--verbose", "-v", "-"] {
            assert_eq!(
                parse_cli_args(argv(&[flag])),
                Ok(CliRequest::Launcher),
                "{flag} must be ignored, not rejected"
            );
        }
    }

    /// Several unknown flags before the path, which is what a real Finder/Spotlight
    /// launch with an argument looks like.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_skips_a_run_of_flags_to_find_the_path() {
        assert_eq!(
            parse_cli_args(argv(&["-psn_0_12345", "-v", "--debug", "/tmp/projB"])),
            Ok(CliRequest::Project("/tmp/projB".to_string()))
        );
    }

    /// Flags do not hide a `--resume` further down the line.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_finds_resume_after_flags() {
        assert_eq!(
            parse_cli_args(argv(&["-psn_0_12345", "--resume", "an-id"])),
            Ok(CliRequest::Resume("an-id".to_string()))
        );
    }

    /// A dangling or blank `--resume` is an ERROR, not a silent launcher. The user asked
    /// for a conversation; degrading to the launcher would never tell them they didn't
    /// get one.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_rejects_a_valueless_resume() {
        assert!(parse_cli_args(argv(&["--resume"])).is_err(), "no value at all");
        assert!(parse_cli_args(argv(&["--resume", ""])).is_err(), "empty value");
        assert!(parse_cli_args(argv(&["--resume", "   "])).is_err(), "blank value");
        assert!(parse_cli_args(argv(&["--resume", "\t\n"])).is_err(), "whitespace value");
    }

    /// The error names the flag, so a terminal launch says what went wrong.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_resume_error_mentions_the_flag() {
        let err = parse_cli_args(argv(&["--resume"])).unwrap_err();
        assert!(err.contains("--resume"), "unhelpful error: {err}");
    }

    /// An empty argv is the launcher. This is the no-regression promise: it is what every
    /// Finder double-click takes, because a `.app` opened that way is handed no argv.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_empty_argv_is_the_launcher() {
        assert_eq!(parse_cli_args(argv(&[])), Ok(CliRequest::Launcher));
    }

    /// An empty-string positional is a positional, not a flag and not a skip. It resolves
    /// downstream through `absolutize("")` -> the current directory, which is the same
    /// place `.` goes — so the behaviour is odd but never wrong.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_empty_positional_is_a_path() {
        assert_eq!(
            parse_cli_args(argv(&[""])),
            Ok(CliRequest::Project(String::new()))
        );
    }

    /// The path is taken verbatim — not trimmed, not normalised, not resolved. Parsing is
    /// PURE; proving the path names something real is `resolve_project`'s job alone.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_takes_the_path_verbatim() {
        for path in [
            "/tmp/projB",
            "../projB",
            "./projB/",
            "~/projects/x",
            "/Users/x/My Project",
            "/tmp/café",
            "relative/nested/path",
        ] {
            assert_eq!(
                parse_cli_args(argv(&[path])),
                Ok(CliRequest::Project(path.to_string())),
                "{path} must survive parsing untouched"
            );
        }
    }

    /// A second positional is ignored — only the first is the project.
    #[cfg(desktop)]
    #[test]
    fn parse_cli_args_ignores_extra_positionals() {
        assert_eq!(
            parse_cli_args(argv(&["/tmp/a", "/tmp/b"])),
            Ok(CliRequest::Project("/tmp/a".to_string()))
        );
    }

    // ---- Tier 2: percent_decode ------------------------------------------------

    /// A `%` followed by a multi-byte char used to panic: the 2-byte window is a
    /// BYTE slice into a `str`, so it cut mid-character. Every store walker decodes
    /// every directory name, and the panic surfaced as an empty sidebar, not an error.
    #[test]
    fn percent_decode_survives_an_escape_that_cuts_a_multibyte_char() {
        assert_eq!(percent_decode("%a\u{e9}"), "%a\u{e9}");
        assert_eq!(percent_decode("%\u{e9}\u{e9}"), "%\u{e9}\u{e9}");
        assert_eq!(percent_decode("%2Ftmp%2F\u{e9}"), "/tmp/\u{e9}");
    }

    /// The round-trip the session store depends on: `~/.grok/sessions/<pct-encoded cwd>/`.
    #[test]
    fn percent_decode_round_trips_a_project_path() {
        assert_eq!(percent_decode("%2Ftmp%2FprojB"), "/tmp/projB");
        assert_eq!(
            percent_decode("%2FUsers%2Fx%2Fgba%2Ffabri"),
            "/Users/x/gba/fabri"
        );
    }

    /// A path with a space — ordinary on macOS ("~/Documents/My Project") and the single
    /// most likely thing to be encoded.
    #[test]
    fn percent_decode_handles_spaces() {
        assert_eq!(
            percent_decode("%2FUsers%2Fx%2FMy%20Project"),
            "/Users/x/My Project"
        );
    }

    /// Multi-byte UTF-8 arrives as two escapes and must reassemble into one char.
    #[test]
    fn percent_decode_handles_unicode() {
        assert_eq!(percent_decode("%2Ftmp%2Fcaf%C3%A9"), "/tmp/café");
        assert_eq!(percent_decode("caf%C3%A9"), "café");
        // Four bytes, one emoji.
        assert_eq!(percent_decode("%F0%9F%8E%89"), "🎉");
    }

    /// An escaped percent decodes to a literal one, and does not then re-decode what
    /// follows it.
    #[test]
    fn percent_decode_handles_an_escaped_percent() {
        assert_eq!(percent_decode("%25"), "%");
        assert_eq!(percent_decode("100%25"), "100%");
        assert_eq!(percent_decode("%252F"), "%2F", "one pass only, never recursive");
    }

    /// A path with nothing to decode passes through untouched.
    #[test]
    fn percent_decode_passes_plain_text_through() {
        assert_eq!(percent_decode("/tmp/projB"), "/tmp/projB");
        assert_eq!(percent_decode("projB"), "projB");
        assert_eq!(percent_decode(""), "");
    }

    /// A `%` that isn't a valid escape stays a literal `%`. Folder names are not ours and
    /// a stray percent must not eat the next two characters.
    #[test]
    fn percent_decode_leaves_malformed_escapes_alone() {
        assert_eq!(percent_decode("%zz"), "%zz", "not hex");
        assert_eq!(percent_decode("%2"), "%2", "truncated at the end");
        assert_eq!(percent_decode("%"), "%", "a bare trailing percent");
        assert_eq!(percent_decode("50%%"), "50%%");
        assert_eq!(percent_decode("a%gg%2Fb"), "a%gg/b", "recovers after a bad escape");
    }

    /// Lowercase hex decodes the same as uppercase — `from_str_radix` accepts both.
    #[test]
    fn percent_decode_accepts_either_hex_case() {
        assert_eq!(percent_decode("%2f%2F"), "//");
        assert_eq!(percent_decode("%c3%a9"), "é");
    }

    /// An escape at the very end of the string is still decoded — the bounds check is
    /// `i + 2 < len`, which is exactly enough room for two hex digits.
    #[test]
    fn percent_decode_decodes_a_trailing_escape() {
        assert_eq!(percent_decode("tmp%2F"), "tmp/");
        assert_eq!(percent_decode("%2F"), "/");
    }

    // ---- Tier 2: the /tmp vs /private/tmp symlink trap -------------------------

    /// No filter keeps everything — this is the launcher's sidebar, showing every project.
    #[test]
    fn cwd_filter_none_keeps_everything() {
        assert!(!cwd_filter_excludes(None, "/tmp/projB"));
        assert!(!cwd_filter_excludes(None, ""));
    }

    /// An exact match keeps the folder. The happy path: `ProjectEntry.cwd` is the string
    /// the user picked, and the CLI encoded that same string into the folder name.
    #[test]
    fn cwd_filter_exact_match_keeps() {
        assert!(!cwd_filter_excludes(Some("/tmp/projB"), "/tmp/projB"));
        assert!(!cwd_filter_excludes(Some(""), ""));
    }

    /// A different project is excluded. This is the feature: a window shows its own
    /// project's conversations and no one else's.
    #[test]
    fn cwd_filter_other_project_is_excluded() {
        assert!(cwd_filter_excludes(Some("/tmp/projB"), "/tmp/projA"));
        assert!(cwd_filter_excludes(Some("/tmp/projB"), "/Users/x/gba/fabri"));
    }

    /// THE TRAP, pinned. The compare is exact, so a canonicalized path does NOT match the
    /// folder the CLI stored — macOS canonicalizes `/tmp` to `/private/tmp` while grok
    /// wrote the session under `/tmp`. The failure is silent: the walk returns an empty
    /// Vec, never an Err, so the sidebar just goes blank with nothing to report.
    ///
    /// This is why `absolutize` refuses to resolve symlinks and why `ProjectEntry` keeps
    /// `cwd` and `key` as two fields. If this test ever fails, someone has changed the
    /// compare — and the two guards above are now load-bearing for nothing.
    #[test]
    fn cwd_filter_canonicalized_path_does_not_match_the_stored_folder() {
        assert!(
            cwd_filter_excludes(Some("/private/tmp/projB"), "/tmp/projB"),
            "a canonicalized filter silently empties the sidebar — do not hand one in"
        );
        assert!(
            cwd_filter_excludes(Some("/private/var/x/proj"), "/var/x/proj"),
            "the same trap on /var, which is the one users actually hit"
        );
    }

    /// A trailing slash is a different string and therefore a different project. Another
    /// face of the same trap.
    #[test]
    fn cwd_filter_trailing_slash_does_not_match() {
        assert!(cwd_filter_excludes(Some("/tmp/projB/"), "/tmp/projB"));
        assert!(cwd_filter_excludes(Some("/tmp/projB"), "/tmp/projB/"));
    }

    /// The compare is case-SENSITIVE even though macOS's default volume is not. A cwd
    /// that differs only in case names the same directory to the OS and a different one
    /// here.
    #[test]
    fn cwd_filter_is_case_sensitive() {
        assert!(cwd_filter_excludes(Some("/tmp/ProjB"), "/tmp/projb"));
    }

    /// No prefix or substring matching: a parent directory does not match its child, so
    /// opening `/tmp` does not pull in `/tmp/projB`'s conversations.
    #[test]
    fn cwd_filter_has_no_prefix_matching() {
        assert!(cwd_filter_excludes(Some("/tmp"), "/tmp/projB"));
        assert!(cwd_filter_excludes(Some("/tmp/projB"), "/tmp"));
        assert!(cwd_filter_excludes(Some("/tmp/proj"), "/tmp/projB"));
    }

    // ---- Tier 2: window_title / basename ---------------------------------------

    /// The title is the app, then the folder — the folder alone says nothing in a dock or
    /// a window switcher.
    #[test]
    fn window_title_names_the_app_and_the_folder() {
        assert_eq!(window_title("/tmp/projB"), "Grok Build Desktop — projB");
        assert_eq!(
            window_title("/Users/x/gba/fabri"),
            "Grok Build Desktop — fabri"
        );
    }

    /// A folder name with a space or unicode reaches the title unmangled.
    #[test]
    fn window_title_survives_spaces_and_unicode() {
        assert_eq!(
            window_title("/Users/x/My Project"),
            "Grok Build Desktop — My Project"
        );
        assert_eq!(window_title("/tmp/café"), "Grok Build Desktop — café");
    }

    /// A root cwd has no folder name; `basename` falls back to the path itself, so the
    /// title reads "Grok Build Desktop — /". Odd-looking, but honest and never empty.
    #[test]
    fn window_title_of_root() {
        assert_eq!(window_title("/"), "Grok Build Desktop — /");
    }

    /// A trailing slash takes `basename`'s whole-path fallback (see
    /// `basename_trailing_slash_falls_back_to_the_whole_path`), so the title shows the
    /// full path. Not reachable from either real source of a cwd — the folder dialog and
    /// `absolutize` both produce slash-free paths — but pinned so the coupling is visible.
    #[test]
    fn window_title_of_a_trailing_slash_cwd_shows_the_whole_path() {
        assert_eq!(
            window_title("/tmp/projB/"),
            "Grok Build Desktop — /tmp/projB/"
        );
    }

    /// The separator is an em dash, not a hyphen. It is in the string the user reads.
    #[test]
    fn window_title_uses_an_em_dash() {
        let title = window_title("/tmp/projB");
        assert!(title.contains(" — "), "expected an em dash in {title:?}");
        assert!(title.starts_with("Grok Build Desktop"));
    }

    /// The ordinary case: the last path segment.
    #[test]
    fn basename_takes_the_last_segment() {
        assert_eq!(basename("/tmp/projB"), "projB");
        assert_eq!(basename("/a/b/c/d/e"), "e");
        assert_eq!(basename("/Users/x/My Project"), "My Project");
    }

    /// A bare name with no separator is already its own basename.
    #[test]
    fn basename_of_a_single_segment() {
        assert_eq!(basename("projB"), "projB");
        assert_eq!(basename("Cargo.toml"), "Cargo.toml");
    }

    /// Windows separators count too — `build_permission_payload` runs `basename` on a
    /// `file_path` that grok produced, which is backslash-separated on Windows.
    #[test]
    fn basename_handles_windows_separators() {
        assert_eq!(basename(r"C:\Users\x\projB"), "projB");
        assert_eq!(basename(r"C:\Users\x\projB\src\lib.rs"), "lib.rs");
        assert_eq!(basename("/mixed/path\\segment"), "segment");
    }

    /// With no last segment to show, `basename` deliberately falls back to the whole path
    /// rather than to an empty string — an empty title or an empty "Edit " in an approval
    /// card would be strictly worse than a long one.
    #[test]
    fn basename_trailing_slash_falls_back_to_the_whole_path() {
        assert_eq!(basename("/tmp/projB/"), "/tmp/projB/");
        assert_eq!(basename(r"C:\Users\x\projB\"), r"C:\Users\x\projB\");
    }

    /// Root is its own name, via the same fallback.
    #[test]
    fn basename_of_root() {
        assert_eq!(basename("/"), "/");
    }

    /// Empty in, empty out. The fallback cannot invent a name.
    #[test]
    fn basename_of_empty_is_empty() {
        assert_eq!(basename(""), "");
    }

    /// A dotfile directory is an ordinary segment.
    #[test]
    fn basename_of_a_dotfile() {
        assert_eq!(basename("/Users/x/.grok"), ".grok");
        assert_eq!(basename("/Users/x/.config/nvim"), "nvim");
    }

    // ---- Tier 3: with_tab_id ---------------------------------------------------

    /// An object payload gets `tabId` stamped in beside its own keys. `with_tab_id` is the
    /// ONLY writer of `tabId` in this file — every session event routes through it.
    #[test]
    fn with_tab_id_stamps_an_object_in_place() {
        let out = with_tab_id(json!({"stage": "ready", "sessionId": "s1"}), "3");
        assert_eq!(out["tabId"], json!("3"));
        assert_eq!(out["stage"], json!("ready"), "existing keys survive");
        assert_eq!(out["sessionId"], json!("s1"));
        assert_eq!(out.as_object().unwrap().len(), 3, "nothing else is added");
    }

    /// An empty object is still an object — it gets stamped, not wrapped.
    #[test]
    fn with_tab_id_stamps_an_empty_object() {
        let out = with_tab_id(json!({}), "1");
        assert_eq!(out, json!({"tabId": "1"}));
    }

    /// **The agent must not be able to spoof its own route.** `params` on an
    /// `acp-update` is grok's bytes, so a payload arriving with its own `tabId` must be
    /// OVERWRITTEN by ours, never allowed to stand. Insert-over is what makes the last
    /// word Rust's.
    #[test]
    fn with_tab_id_overwrites_an_incoming_tab_id() {
        let out = with_tab_id(json!({"tabId": "99", "text": "hi"}), "3");
        assert_eq!(
            out["tabId"],
            json!("3"),
            "a payload-supplied tabId must never win"
        );
        assert_eq!(out["text"], json!("hi"));
    }

    /// A non-object payload is wrapped rather than stamped — there is nowhere to put a key
    /// on a bare scalar.
    #[test]
    fn with_tab_id_wraps_a_non_object() {
        assert_eq!(
            with_tab_id(json!("just a string"), "2"),
            json!({"tabId": "2", "payload": "just a string"})
        );
        assert_eq!(
            with_tab_id(json!(42), "2"),
            json!({"tabId": "2", "payload": 42})
        );
        assert_eq!(
            with_tab_id(json!(null), "2"),
            json!({"tabId": "2", "payload": null})
        );
        assert_eq!(
            with_tab_id(json!(true), "2"),
            json!({"tabId": "2", "payload": true})
        );
    }

    /// An array is not an object either — `spawn_reader` forwards `params` verbatim, and
    /// JSON-RPC permits array params.
    #[test]
    fn with_tab_id_wraps_an_array() {
        assert_eq!(
            with_tab_id(json!([1, 2, 3]), "2"),
            json!({"tabId": "2", "payload": [1, 2, 3]})
        );
    }

    /// The tab id is stamped as a JSON string, whatever it looks like. The frontend keys
    /// its ref-maps on `tabId` as a string; a number would silently miss every lookup.
    #[test]
    fn with_tab_id_always_stamps_a_string() {
        let out = with_tab_id(json!({}), "42");
        assert!(out["tabId"].is_string(), "tabId must be a JSON string");
        assert_eq!(out["tabId"], json!("42"));
    }

    // ---- Tier 3: project_key / ProjectEntry ------------------------------------

    /// A path that does not exist cannot be canonicalized, and falls back to itself. The
    /// key stays a consistent identity either way — worst case the user gets a second
    /// window this would have merged.
    #[test]
    fn project_key_falls_back_to_the_path_as_given() {
        let missing = "/definitely/not/a/real/path/xyzzy-12345";
        assert_eq!(project_key(missing), PathBuf::from(missing));
    }

    /// `..` and `.` collapse for a real directory, so two spellings of one project dedupe
    /// onto one window — the whole reason `open_project` has a key at all.
    #[test]
    fn project_key_collapses_two_spellings_of_one_directory() {
        let manifest = env!("CARGO_MANIFEST_DIR"); // this crate's own dir; never the user's store
        let via_parent = format!("{manifest}/src/..");
        let via_dot = format!("{manifest}/./");

        assert_eq!(
            project_key(manifest),
            project_key(&via_parent),
            "`src/..` names the same project"
        );
        assert_eq!(project_key(manifest), project_key(&via_dot));

        // The point: a raw string compare would have called these three different projects.
        assert_ne!(manifest, via_parent.as_str());
        assert_ne!(manifest, via_dot.as_str());
    }

    /// A trailing slash is not a different project.
    #[test]
    fn project_key_ignores_a_trailing_slash() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        assert_eq!(project_key(manifest), project_key(&format!("{manifest}/")));
    }

    /// Two genuinely different directories keep different keys.
    #[test]
    fn project_key_keeps_different_projects_apart() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        assert_ne!(project_key(manifest), project_key(&format!("{manifest}/src")));
    }

    /// The key is canonical and the cwd is the user's original string. Collapsing the two
    /// fields is exactly the bug `cwd_filter_excludes` documents — the key must never be
    /// what gets handed to grok or matched against the store.
    #[test]
    fn project_entry_keeps_the_original_cwd_beside_the_canonical_key() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let as_typed = format!("{manifest}/src/..");

        let entry = ProjectEntry {
            cwd: as_typed.clone(),
            key: project_key(&as_typed),
        };

        assert_eq!(entry.cwd, as_typed, "the cwd is stored EXACTLY as picked");
        assert_eq!(
            entry.key,
            project_key(manifest),
            "the key is the canonical identity"
        );
        assert_ne!(
            PathBuf::from(&entry.cwd),
            entry.key,
            "the two fields are different values — that is the point of having two"
        );
    }

    // ---- Tier 3: WindowRegistry -------------------------------------------------

    /// The counter is seeded at 2: `main` is the config-minted first window, so `w1` would
    /// be gratuitously confusing.
    #[test]
    fn window_registry_mints_from_w2() {
        let registry = WindowRegistry::default();
        assert_eq!(registry.mint_label(), "w2");
        assert_eq!(registry.mint_label(), "w3");
        assert_eq!(registry.mint_label(), "w4");
    }

    /// Every minted label carries the prefix the capability glob matches.
    #[test]
    fn window_registry_labels_carry_the_prefix() {
        let registry = WindowRegistry::default();
        for _ in 0..20 {
            let label = registry.mint_label();
            assert!(
                label.starts_with(WINDOW_LABEL_PREFIX),
                "{label} must match the `{WINDOW_LABEL_PREFIX}*` capability glob"
            );
        }
    }

    /// A minted label is never `main`. `main` is the config's window and already has an
    /// identity; minting a second one would collide on `WindowLabelAlreadyExists`.
    #[test]
    fn window_registry_never_mints_main() {
        let registry = WindowRegistry::default();
        for _ in 0..50 {
            assert_ne!(registry.mint_label(), "main");
        }
    }

    /// Labels are never reused. A recycled label would inherit a dead window's identity,
    /// and `SessionKey` is built on the assumption that a label names one window for the
    /// life of the process.
    #[test]
    fn window_registry_never_reuses_a_label() {
        let registry = WindowRegistry::default();
        let labels: Vec<String> = (0..200).map(|_| registry.mint_label()).collect();
        let unique: HashSet<&String> = labels.iter().collect();
        assert_eq!(unique.len(), labels.len(), "every label must be unique");
    }

    /// The counter only ever moves forward, even under concurrent minting — `open_project`
    /// and the tray's `open_launcher` both mint, from different threads.
    #[test]
    fn window_registry_mints_uniquely_under_concurrency() {
        let registry = Arc::new(WindowRegistry::default());
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let registry = registry.clone();
                thread::spawn(move || {
                    (0..100).map(|_| registry.mint_label()).collect::<Vec<_>>()
                })
            })
            .collect();

        let mut all = Vec::new();
        for t in threads {
            all.extend(t.join().expect("mint thread panicked"));
        }

        let unique: HashSet<&String> = all.iter().collect();
        assert_eq!(all.len(), 800);
        assert_eq!(
            unique.len(),
            800,
            "two windows must never be handed the same label"
        );
    }

    /// Insert / lookup / remove, keyed by label. `window_project` reads this map and
    /// `Destroyed` removes from it.
    #[test]
    fn window_registry_insert_lookup_remove() {
        let registry = WindowRegistry::default();
        let cwd = "/tmp/projB".to_string();

        {
            let mut guard = registry.inner.lock().unwrap();
            guard.insert(
                "w2".to_string(),
                ProjectEntry {
                    cwd: cwd.clone(),
                    key: PathBuf::from(&cwd),
                },
            );
        }

        {
            let guard = registry.inner.lock().unwrap();
            assert_eq!(guard.get("w2").map(|e| e.cwd.clone()), Some(cwd));
            assert!(guard.get("w3").is_none(), "an unknown window has no project");
        }

        {
            let mut guard = registry.inner.lock().unwrap();
            assert!(guard.remove("w2").is_some());
            assert!(guard.remove("w2").is_none(), "removing twice is a no-op");
            assert!(guard.is_empty());
        }
    }

    /// A fresh registry is empty — every window starts projectless and `window_project`
    /// answers `None` until `open_project` inserts. That `None` is what renders the
    /// launcher.
    #[test]
    fn window_registry_starts_empty() {
        let registry = WindowRegistry::default();
        assert!(registry.inner.lock().unwrap().is_empty());
    }

    /// The reverse lookup `open_project` does inside its critical section: find the window
    /// already showing this canonical key. Two windows on two projects, one match.
    #[test]
    fn window_registry_finds_the_window_showing_a_project() {
        let registry = WindowRegistry::default();
        {
            let mut guard = registry.inner.lock().unwrap();
            for (label, cwd) in [("main", "/tmp/projA"), ("w2", "/tmp/projB")] {
                guard.insert(
                    label.to_string(),
                    ProjectEntry {
                        cwd: cwd.to_string(),
                        key: PathBuf::from(cwd),
                    },
                );
            }
        }

        let guard = registry.inner.lock().unwrap();
        let found = guard
            .iter()
            .find(|(_, entry)| entry.key == Path::new("/tmp/projB"))
            .map(|(label, _)| label.clone());
        assert_eq!(found, Some("w2".to_string()));

        let missing = guard
            .iter()
            .find(|(_, entry)| entry.key == Path::new("/tmp/projC"));
        assert!(missing.is_none(), "an unopened project has no window");
    }

    // ---- Tier 3: the capability glob (fails SILENTLY in release builds) --------

    /// `capabilities/default.json`'s `"windows"` glob is what grants a window the right to
    /// invoke anything at all. A label it fails to match loses ALL IPC — with no error and
    /// no log in a release build; the window simply never works. Nothing else in the build
    /// checks these two against each other, so this test is the only thing standing
    /// between the constant and the glob.
    #[test]
    fn capability_glob_matches_the_window_label_prefix() {
        const CAPABILITY: &str = include_str!("../capabilities/default.json");
        let parsed: Value = serde_json::from_str(CAPABILITY).expect("capability file must be JSON");

        let windows: Vec<&str> = parsed["windows"]
            .as_array()
            .expect("`windows` must be an array")
            .iter()
            .map(|w| w.as_str().expect("every entry must be a string"))
            .collect();

        assert!(
            windows.contains(&"main"),
            "the config-minted `main` window must be covered: {windows:?}"
        );

        let glob = windows
            .iter()
            .find(|w| w.ends_with('*'))
            .unwrap_or_else(|| panic!("no prefix glob for minted windows in {windows:?}"));
        assert_eq!(
            glob.trim_end_matches('*'),
            WINDOW_LABEL_PREFIX,
            "the capability glob and WINDOW_LABEL_PREFIX have drifted — every minted \
             window would silently lose IPC in a release build"
        );
    }

    /// The glob is a PREFIX glob, not a bare `*`. `["*"]` would grant every future window
    /// every permission by default, which is the thing the named prefix exists to avoid.
    #[test]
    fn capability_glob_is_not_a_bare_wildcard() {
        const CAPABILITY: &str = include_str!("../capabilities/default.json");
        let parsed: Value = serde_json::from_str(CAPABILITY).unwrap();
        let windows = parsed["windows"].as_array().unwrap();
        assert!(
            !windows.iter().any(|w| w == "*"),
            "a bare `*` would auto-grant every future window"
        );
    }

    /// Labels the registry actually mints are matched by the glob the capability declares.
    /// The two tests above check the strings; this one checks the property they exist for.
    #[test]
    fn every_minted_label_is_covered_by_the_capability_glob() {
        const CAPABILITY: &str = include_str!("../capabilities/default.json");
        let parsed: Value = serde_json::from_str(CAPABILITY).unwrap();
        let globs: Vec<String> = parsed["windows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w.as_str().unwrap().to_string())
            .collect();

        let covered = |label: &str| {
            globs.iter().any(|g| match g.strip_suffix('*') {
                Some(prefix) => label.starts_with(prefix),
                None => g == label,
            })
        };

        assert!(covered("main"), "the launcher window must be covered");
        let registry = WindowRegistry::default();
        for _ in 0..50 {
            let label = registry.mint_label();
            assert!(covered(&label), "{label} is not covered by {globs:?}");
        }
    }

    // ---- Tier 3: the hook allowlist (drift here means grok edits files unasked) --

    /// The sh hook's `case` arm and `READONLY_TOOLS` must be the same list, in the same
    /// order. They are two hand-maintained copies of one allowlist: the script's is what
    /// actually auto-allows, and Rust's is the defence-in-depth check in the watcher.
    /// Drift in one direction prompts for a read (annoying); in the other it silently
    /// auto-allows something that should have been asked about.
    #[test]
    fn hook_script_allowlist_matches_readonly_tools() {
        let after = HOOK_SCRIPT
            .split_once("case \"$TOOL\" in")
            .expect("the hook script must still have a $TOOL case")
            .1;
        let arm = after
            .split_once(')')
            .expect("the case arm must be closed")
            .0
            .trim();
        let tools: Vec<&str> = arm.split('|').map(str::trim).collect();

        assert_eq!(
            tools, READONLY_TOOLS,
            "the sh hook's allowlist has drifted from READONLY_TOOLS"
        );
    }

    /// The PowerShell hook carries a third copy of the same list. Only compiled on
    /// Windows, so this does not run on a macOS/Linux gate — noted, not hidden.
    #[cfg(windows)]
    #[test]
    fn hook_script_ps1_allowlist_matches_readonly_tools() {
        let after = HOOK_SCRIPT_PS1
            .split_once("$allow = @(")
            .expect("the ps1 hook must still declare $allow")
            .1;
        let arm = after.split_once(')').expect("$allow must be closed").0;
        let tools: Vec<String> = arm
            .split(',')
            .map(|t| t.trim().trim_matches('"').to_string())
            .collect();

        assert_eq!(
            tools, READONLY_TOOLS,
            "the ps1 hook's allowlist has drifted from READONLY_TOOLS"
        );
    }

    /// **The allowlist must never grow a mutating tool.** This is the entire safety
    /// argument of the gate: a denylist does not hold (grok routes around it via
    /// `monitor`), so the default-deny allowlist is the only thing that does. Any of these
    /// appearing here means grok writes files, runs shells, or spawns background work with
    /// no prompt at all.
    #[test]
    fn readonly_tools_contains_nothing_that_mutates() {
        for tool in [
            "write",
            "create_file",
            "search_replace",
            "run_terminal_command",
            "monitor",
            "delete_file",
            "edit_file",
        ] {
            assert!(
                !READONLY_TOOLS.contains(&tool),
                "`{tool}` mutates and must NEVER be auto-allowed"
            );
        }
    }

    /// Network egress is deliberately NOT auto-allowed, so a read-then-exfiltrate path
    /// cannot run unattended. This exclusion is a decision, not an omission.
    #[test]
    fn readonly_tools_excludes_network_egress() {
        for tool in ["web_search", "web_fetch", "browse", "fetch"] {
            assert!(
                !READONLY_TOOLS.contains(&tool),
                "`{tool}` reaches the network and must prompt"
            );
        }
    }

    /// The allowlist is non-empty and has no duplicates — a duplicate would mean an edit
    /// half-applied to one of the three copies.
    #[test]
    fn readonly_tools_is_a_clean_set() {
        assert!(!READONLY_TOOLS.is_empty());
        let unique: HashSet<&&str> = READONLY_TOOLS.iter().collect();
        assert_eq!(unique.len(), READONLY_TOOLS.len(), "duplicate entry");
        assert!(!READONLY_TOOLS.iter().any(|t| t.is_empty()));
    }

    /// The `readonly_tools` command is a pure clone of `READONLY_TOOLS` — nothing added,
    /// nothing dropped, same order. It exists for display in Preferences only.
    #[test]
    fn readonly_tools_command_mirrors_the_allowlist() {
        let expected: Vec<String> = READONLY_TOOLS.iter().map(|s| s.to_string()).collect();
        assert_eq!(readonly_tools(), expected);
    }

    /// The hook FAILS CLOSED: after its internal deadline it prints an explicit deny
    /// rather than being force-killed by grok's 600s timeout (which would fail open).
    #[test]
    fn hook_script_denies_on_timeout() {
        assert!(
            HOOK_SCRIPT.contains(r#"{"decision":"deny""#),
            "the sh hook must emit an explicit deny after its deadline"
        );
        // The internal deadline must stay under grok's 600s hook timeout: 5000 * 0.1s.
        assert!(HOOK_SCRIPT.contains("-lt 5000"));
        assert!(HOOK_SCRIPT.contains("sleep 0.1"));
    }

    /// The hook only gates sessions the app has marked live, so the user's own terminal
    /// grok is never gated by an app that isn't even watching it.
    #[test]
    fn hook_script_gates_only_live_sessions() {
        assert!(
            HOOK_SCRIPT.contains("$BRIDGE/live/$SID"),
            "the live-marker gate is what keeps a terminal grok ungated"
        );
    }

    /// The hook reads its scalar fields from the payload prefix BEFORE `toolInput`, so
    /// model-controlled content inside `toolInput` (a file's bytes, a command string)
    /// cannot spoof `toolName` or `sessionId` — e.g. writing a file whose contents contain
    /// `"toolName":"read_file"`.
    #[test]
    fn hook_script_truncates_before_tool_input() {
        assert!(
            HOOK_SCRIPT.contains(r#"HEAD=${INPUT%%\"toolInput\"*}"#),
            "the anti-spoof truncation is gone from the sh hook"
        );
    }

    /// The bridge path is hardcoded in the hook script and computed in Rust. Two spellings
    /// of one directory; if they drift, the app writes decisions nobody reads and every
    /// approval times out into a deny.
    #[test]
    fn bridge_root_agrees_with_the_hook_script() {
        assert!(
            HOOK_SCRIPT.contains(r#"BRIDGE="$HOME/.grok/gbd-bridge""#),
            "the sh hook's bridge path has moved"
        );
        if let Some(root) = bridge_root() {
            assert!(
                root.ends_with(".grok/gbd-bridge"),
                "bridge_root disagrees with the hook script: {root:?}"
            );
        }
    }

    // ---- build_permission_payload ---------------------------------------------

    /// An edit renders as a diff, titled with the file's basename.
    #[test]
    fn permission_payload_renders_an_edit_as_a_diff() {
        let req = json!({
            "toolName": "search_replace",
            "toolInput": {
                "file_path": "/tmp/projB/src/main.rs",
                "old_string": "let x = 1;",
                "new_string": "let x = 2;"
            }
        });
        let payload = build_permission_payload(&req, "tuid-1");

        assert_eq!(payload["toolCall"]["title"], json!("Edit main.rs"));
        assert_eq!(payload["toolCall"]["content"][0]["type"], json!("diff"));
        assert_eq!(
            payload["toolCall"]["content"][0]["path"],
            json!("/tmp/projB/src/main.rs")
        );
        assert_eq!(payload["toolCall"]["content"][0]["oldText"], json!("let x = 1;"));
        assert_eq!(payload["toolCall"]["content"][0]["newText"], json!("let x = 2;"));
    }

    /// A new file is a diff against nothing — `oldText` is empty, which is what makes the
    /// card render as an all-additions diff rather than a rewrite.
    #[test]
    fn permission_payload_renders_a_write_as_a_diff_from_empty() {
        for tool in ["write", "create_file"] {
            let req = json!({
                "toolName": tool,
                "toolInput": {"file_path": "/tmp/projB/new.txt", "content": "hello"}
            });
            let payload = build_permission_payload(&req, "tuid-1");

            assert_eq!(payload["toolCall"]["title"], json!("Write new.txt"), "{tool}");
            assert_eq!(payload["toolCall"]["content"][0]["type"], json!("diff"));
            assert_eq!(payload["toolCall"]["content"][0]["oldText"], json!(""));
            assert_eq!(payload["toolCall"]["content"][0]["newText"], json!("hello"));
        }
    }

    /// A shell command renders verbatim. `monitor` is grok's undocumented background
    /// shell — the tool it routes around a denylist with — and must render exactly like a
    /// foreground one, because it is exactly as dangerous.
    #[test]
    fn permission_payload_renders_a_command() {
        for tool in ["run_terminal_command", "monitor"] {
            let req = json!({
                "toolName": tool,
                "toolInput": {"command": "rm -rf /tmp/projB"}
            });
            let payload = build_permission_payload(&req, "tuid-1");

            assert_eq!(payload["toolCall"]["title"], json!("Run a shell command"), "{tool}");
            assert_eq!(payload["toolCall"]["content"][0]["type"], json!("command"));
            assert_eq!(
                payload["toolCall"]["content"][0]["text"],
                json!("rm -rf /tmp/projB"),
                "the command must be shown exactly as it will run"
            );
        }
    }

    /// An unrecognised tool still gets a card, naming the tool and dumping its input. It
    /// must never be silently allowed just because we have no pretty renderer for it.
    #[test]
    fn permission_payload_falls_back_for_an_unknown_tool() {
        let req = json!({
            "toolName": "web_fetch",
            "toolInput": {"url": "https://example.com"}
        });
        let payload = build_permission_payload(&req, "tuid-1");

        assert_eq!(
            payload["toolCall"]["title"],
            json!("Grok wants to use web_fetch")
        );
        assert_eq!(payload["toolCall"]["content"][0]["type"], json!("command"));
        let text = payload["toolCall"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("https://example.com"), "the input must be shown: {text}");
    }

    /// `hookToolUseId` is the request FILE'S STEM, which is the id the hook script polls
    /// its response on. It must be the `tuid` argument and never the JSON `toolUseId` —
    /// the two differ whenever grok omits the field, and answering the wrong one leaves
    /// the hook waiting out its full deadline into an auto-deny.
    #[test]
    fn permission_payload_keys_on_the_file_stem_not_the_json_field() {
        let req = json!({
            "toolName": "write",
            "toolUseId": "a-different-id-from-the-json",
            "toolInput": {"file_path": "/tmp/x", "content": "y"}
        });
        let payload = build_permission_payload(&req, "the-file-stem");

        assert_eq!(
            payload["hookToolUseId"],
            json!("the-file-stem"),
            "the stem is the identity the hook polls on"
        );
    }

    /// The card always offers exactly Allow and Deny, with the option ids the frontend
    /// sends back and the kinds it styles on.
    #[test]
    fn permission_payload_always_offers_allow_and_deny() {
        let req = json!({"toolName": "write", "toolInput": {"file_path": "/tmp/x"}});
        let payload = build_permission_payload(&req, "tuid-1");

        assert_eq!(
            payload["options"],
            json!([
                {"optionId": "allow", "name": "Allow", "kind": "allow"},
                {"optionId": "deny",  "name": "Deny",  "kind": "reject"}
            ]),
            "the two-option contract is what PermissionCard renders"
        );
        assert_eq!(payload["requestId"], json!(0));
    }

    /// A missing `toolInput` must not panic — the payload is a foreign process's JSON, and
    /// a card with empty fields beats a crashed watcher thread.
    #[test]
    fn permission_payload_survives_a_missing_tool_input() {
        let payload = build_permission_payload(&json!({"toolName": "search_replace"}), "t");
        assert_eq!(payload["toolCall"]["title"], json!("Edit "));
        assert_eq!(payload["toolCall"]["content"][0]["path"], json!(""));
    }

    /// A missing `toolName` falls to the unknown-tool arm rather than matching an empty
    /// string into a renderer.
    #[test]
    fn permission_payload_survives_a_missing_tool_name() {
        let payload = build_permission_payload(&json!({"toolInput": {}}), "t");
        assert_eq!(payload["toolCall"]["title"], json!("Grok wants to use "));
    }

    /// Non-string fields are not strings, and `s()` says so rather than stringifying them.
    /// grok's `toolInput` is not a type we control.
    #[test]
    fn permission_payload_survives_wrongly_typed_input_fields() {
        let req = json!({
            "toolName": "search_replace",
            "toolInput": {"file_path": 42, "old_string": null, "new_string": ["a"]}
        });
        let payload = build_permission_payload(&req, "t");
        assert_eq!(payload["toolCall"]["content"][0]["path"], json!(""));
        assert_eq!(payload["toolCall"]["content"][0]["oldText"], json!(""));
        assert_eq!(payload["toolCall"]["content"][0]["newText"], json!(""));
    }

    /// The payload carries NO identity of its own — `tabId` is stamped by
    /// `SessionKey::emit` on the way out. A second writer of `tabId` is how the two drift.
    #[test]
    fn permission_payload_carries_no_tab_id() {
        let req = json!({"toolName": "write", "toolInput": {"file_path": "/tmp/x"}});
        let payload = build_permission_payload(&req, "tuid-1");
        assert!(
            payload.get("tabId").is_none(),
            "build_permission_payload must not stamp tabId; emit() is the only writer"
        );
    }

    /// End to end through the one route a card takes: build, then stamp. The frontend
    /// needs both `tabId` (which tab drew it) and `hookToolUseId` (what to answer).
    #[test]
    fn permission_payload_gains_its_tab_id_only_via_with_tab_id() {
        let req = json!({"toolName": "write", "toolInput": {"file_path": "/tmp/x", "content": ""}});
        let routed = with_tab_id(build_permission_payload(&req, "tuid-1"), "3");

        assert_eq!(routed["tabId"], json!("3"));
        assert_eq!(routed["hookToolUseId"], json!("tuid-1"));
    }

    // ---- is_auth_error ----------------------------------------------------------

    /// The three shapes grok's auth failures actually take. Getting this wrong means the
    /// UI reports a hard failure where it should be showing a sign-in button.
    #[test]
    fn is_auth_error_recognises_grok_auth_failures() {
        assert!(is_auth_error("Authentication required"));
        assert!(is_auth_error("authentication required"));
        assert!(is_auth_error("AUTHENTICATION REQUIRED"));
        assert!(is_auth_error("No auth method available"));
        assert!(is_auth_error("Unauthorized"));
        assert!(is_auth_error("401 unauthorized"));
    }

    /// The match is a case-insensitive substring, so a wrapped or prefixed message still
    /// reads as auth — the string comes from grok and its wording is not our contract.
    #[test]
    fn is_auth_error_matches_inside_a_longer_message() {
        assert!(is_auth_error(
            "session/new failed: Authentication required (code -32000)"
        ));
    }

    /// Everything else is a real error and must NOT be reported as needing sign-in — that
    /// would send the user to a browser to fix a timeout.
    #[test]
    fn is_auth_error_rejects_non_auth_failures() {
        for msg in [
            "",
            "grok didn't answer `session/new` in time",
            "grok stopped responding",
            "Permission denied",
            "no such file or directory",
            "Couldn't start `grok agent stdio`",
        ] {
            assert!(!is_auth_error(msg), "{msg:?} is not an auth error");
        }
    }

    // ---- absolutize / resolve_project ------------------------------------------

    /// An absolute path passes through unchanged — and, critically, unresolved.
    #[cfg(desktop)]
    #[test]
    fn absolutize_passes_an_absolute_path_through() {
        assert_eq!(absolutize("/tmp/projB"), Some(PathBuf::from("/tmp/projB")));
        assert_eq!(absolutize("/"), Some(PathBuf::from("/")));
    }

    /// `.` and `..` are popped lexically — what the user typed and what their shell showed
    /// them, rather than what the kernel would resolve across a symlink.
    #[cfg(desktop)]
    #[test]
    fn absolutize_pops_dot_and_dotdot_lexically() {
        assert_eq!(absolutize("/tmp/./projB"), Some(PathBuf::from("/tmp/projB")));
        assert_eq!(absolutize("/tmp/a/../projB"), Some(PathBuf::from("/tmp/projB")));
        assert_eq!(
            absolutize("/tmp/a/b/../../projB"),
            Some(PathBuf::from("/tmp/projB"))
        );
        assert_eq!(absolutize("/tmp/projB/"), Some(PathBuf::from("/tmp/projB")));
    }

    /// A relative path is joined onto the current directory. This is what makes
    /// `<app> .` and `<app> ../projB` work from a terminal.
    #[cfg(desktop)]
    #[test]
    fn absolutize_joins_a_relative_path_onto_the_cwd() {
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(absolutize("projB"), Some(cwd.join("projB")));
        assert_eq!(absolutize("."), Some(cwd.clone()));
        assert_eq!(absolutize("./projB"), Some(cwd.join("projB")));
    }

    /// **The symlink trap, pinned at the source.** `absolutize` must NOT resolve symlinks:
    /// macOS canonicalizes `/tmp` to `/private/tmp`, while the CLI stored those sessions
    /// under `/tmp`. Resolving here would hand `list_sessions_inner` a path that can never
    /// match, and the sidebar would silently empty. `/tmp` exists on every macOS box and
    /// is not the user's session store.
    #[cfg(all(desktop, target_os = "macos"))]
    #[test]
    fn absolutize_does_not_resolve_symlinks_on_macos() {
        assert_eq!(
            absolutize("/tmp/projB"),
            Some(PathBuf::from("/tmp/projB")),
            "absolutize must keep the path the user meant"
        );
        // The contrast that makes the test worth having: canonicalize would NOT.
        assert_eq!(
            std::fs::canonicalize("/tmp").unwrap(),
            PathBuf::from("/private/tmp"),
            "if this ever stops being true, the trap this guards against is gone"
        );
    }

    /// A real directory resolves to itself, and the string handed back is the
    /// lexically-absolute path — never `canonicalize`'s output.
    #[cfg(desktop)]
    #[test]
    fn resolve_project_accepts_a_real_directory() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        assert_eq!(resolve_project(manifest), Ok(manifest.to_string()));
    }

    /// `..` is collapsed on the way through, so two spellings of one project produce one
    /// cwd string.
    #[cfg(desktop)]
    #[test]
    fn resolve_project_collapses_dotdot() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        assert_eq!(
            resolve_project(&format!("{manifest}/src/..")),
            Ok(manifest.to_string())
        );
    }

    /// **The whole point of `resolve_project` NOT returning `canonicalize`'s output**, on
    /// the platform where it bites: `<app> .` from `/tmp/projB` must open `/tmp/projB`,
    /// not `/private/tmp/projB`.
    #[cfg(all(desktop, target_os = "macos"))]
    #[test]
    fn resolve_project_keeps_the_unresolved_path_on_macos() {
        assert_eq!(
            resolve_project("/tmp"),
            Ok("/tmp".to_string()),
            "canonicalize proves existence and is then DISCARDED — do not return it"
        );
    }

    /// A path that does not exist is an error, not a window on nothing. Argv is untrusted
    /// and this is the only gate between it and `open_project`.
    #[cfg(desktop)]
    #[test]
    fn resolve_project_rejects_a_missing_path() {
        let err = resolve_project("/definitely/not/a/real/path/xyzzy-12345").unwrap_err();
        assert!(err.contains("xyzzy-12345"), "the error must name the input: {err}");
    }

    /// A file is not a folder. `canonicalize` succeeds on one, so the `is_dir` check is
    /// what refuses it.
    #[cfg(desktop)]
    #[test]
    fn resolve_project_rejects_a_file() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let err = resolve_project(&format!("{manifest}/Cargo.toml")).unwrap_err();
        assert!(err.contains("isn't a folder"), "unexpected error: {err}");
    }

    /// No args resolves to the launcher without touching the disk.
    #[cfg(desktop)]
    #[test]
    fn resolve_cli_no_args_is_the_launcher() {
        assert!(matches!(
            resolve_cli(Vec::<String>::new()),
            Ok(CliIntent::Launcher)
        ));
    }

    /// A real path resolves to a project. (The `--resume` arm is deliberately NOT tested:
    /// it walks the user's real `~/.grok/sessions` store.)
    #[cfg(desktop)]
    #[test]
    fn resolve_cli_a_real_path_is_a_project() {
        let manifest = env!("CARGO_MANIFEST_DIR").to_string();
        match resolve_cli(vec![manifest.clone()]) {
            Ok(CliIntent::Project(cwd)) => assert_eq!(cwd, manifest),
            _ => panic!("expected a Project intent"),
        }
    }

    /// A parse error surfaces before any disk access, so a bad flag never costs a scan.
    #[cfg(desktop)]
    #[test]
    fn resolve_cli_propagates_a_parse_error() {
        assert!(resolve_cli(vec!["--resume".to_string()]).is_err());
    }

    /// A bad path is an error the caller falls back to the launcher on, rather than a
    /// half-open window.
    #[cfg(desktop)]
    #[test]
    fn resolve_cli_propagates_a_bad_path() {
        assert!(resolve_cli(vec!["/definitely/not/real/xyzzy-12345".to_string()]).is_err());
    }

    /// Ignored flags survive the whole pipeline, not just the parser. This is the Finder
    /// launch, end to end.
    #[cfg(desktop)]
    #[test]
    fn resolve_cli_ignores_a_process_serial_number() {
        assert!(matches!(
            resolve_cli(vec!["-psn_0_12345".to_string()]),
            Ok(CliIntent::Launcher)
        ));
    }

    // ---- wire contracts (the frontend reads these field names) ------------------

    /// `OpenOutcome`'s field names and its three `kind` values are the frontend's
    /// contract (src/lib/bridge.ts): only `"adopted"` makes the caller re-render.
    #[test]
    fn open_outcome_serializes_the_shape_the_frontend_reads() {
        for kind in ["focused", "adopted", "opened"] {
            let json = serde_json::to_value(OpenOutcome {
                kind,
                label: "w2".to_string(),
            })
            .unwrap();
            assert_eq!(json, json!({"kind": kind, "label": "w2"}));
        }
    }

    /// `AuthStatus`'s `Default` is the JoinError fallback: if the probe thread dies we
    /// report "not installed, not signed in" rather than inventing state. Reporting
    /// `true` here would send the user to a chat with no agent behind it.
    #[test]
    fn auth_status_default_claims_nothing() {
        let json = serde_json::to_value(AuthStatus::default()).unwrap();
        assert_eq!(
            json,
            json!({"grok_installed": false, "grok_path": null, "has_login": false})
        );
    }

    /// `SessionMeta`'s snake_case field names are what the sidebar reads.
    #[test]
    fn session_meta_serializes_the_shape_the_frontend_reads() {
        let json = serde_json::to_value(SessionMeta {
            id: "id-1".to_string(),
            title: "A title".to_string(),
            summary: "A summary".to_string(),
            cwd: "/tmp/projB".to_string(),
            created_at: "2026-01-01".to_string(),
            updated_at: "2026-01-02".to_string(),
            num_messages: 7,
        })
        .unwrap();

        assert_eq!(
            json,
            json!({
                "id": "id-1", "title": "A title", "summary": "A summary",
                "cwd": "/tmp/projB", "created_at": "2026-01-01",
                "updated_at": "2026-01-02", "num_messages": 7
            })
        );
    }

    /// `Project`'s field names are what the recents list reads.
    #[test]
    fn project_serializes_the_shape_the_frontend_reads() {
        let json = serde_json::to_value(Project {
            path: "/tmp/projB".to_string(),
            name: "projB".to_string(),
            last_used: 1_700_000_000,
        })
        .unwrap();
        assert_eq!(
            json,
            json!({"path": "/tmp/projB", "name": "projB", "last_used": 1_700_000_000})
        );
    }

    /// `ConnectResult` is what `connect` resolves with; `needs_auth` is the flag the UI
    /// branches on between "chat" and "sign in".
    #[test]
    fn connect_result_serializes_the_shape_the_frontend_reads() {
        let json = serde_json::to_value(ConnectResult {
            needs_auth: true,
            auth_methods: vec![json!({"id": "grok.com"})],
            session_id: None,
        })
        .unwrap();
        assert_eq!(
            json,
            json!({
                "needs_auth": true,
                "auth_methods": [{"id": "grok.com"}],
                "session_id": null
            })
        );
    }

    // ---- search: the store fixture ---------------------------------------------------
    //
    // Every test below builds a REAL store in a temp dir — percent-encoded project folders,
    // summary.json files, and a session_search.sqlite carrying grok's actual schema. None of
    // them can see `~/.grok`: `search_sessions_at` takes the root as a parameter and these
    // never pass anything but the fixture. That is the whole reason the root was lifted out.

    /// A temp directory that deletes itself. Hand-rolled rather than pulling in `tempfile`:
    /// rusqlite is the only dependency this change is allowed to add.
    struct TempStore(PathBuf);

    impl TempStore {
        fn new() -> TempStore {
            // pid + an atomic counter: unique across concurrent test binaries AND across the
            // threads cargo runs tests on.
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "gbd-search-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("temp store");
            TempStore(path)
        }

        fn root(&self) -> &Path {
            &self.0
        }

        /// Percent-encode just enough to name a project folder the way the CLI does.
        fn encode(cwd: &str) -> String {
            cwd.replace('%', "%25").replace('/', "%2F").replace(' ', "%20")
        }

        /// Write one conversation into the store, exactly as the CLI lays it out.
        /// `title: None` is the common case the bug report is about — 33 of 50 real
        /// conversations have no `generated_title`.
        fn session(&self, cwd: &str, id: &str, title: Option<&str>, updated_at: &str) -> &TempStore {
            let dir = self.0.join(TempStore::encode(cwd)).join(id);
            std::fs::create_dir_all(&dir).expect("session dir");
            let mut summary = json!({
                "info": {"id": id, "cwd": cwd},
                "session_summary": "",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": updated_at,
                "num_chat_messages": 4,
            });
            if let Some(title) = title {
                summary["generated_title"] = json!(title);
            }
            std::fs::write(dir.join("summary.json"), summary.to_string()).expect("summary.json");
            self
        }

        /// Build the FTS5 index with grok's real schema (verified against the live file:
        /// schema version 4, content= external-content table, ai/ad/au triggers).
        /// `version` is a parameter so the degrade path has something to trip on.
        fn index(&self, version: &str, docs: &[(&str, &str, &str, &str)]) -> &TempStore {
            let conn = rusqlite::Connection::open(self.0.join("session_search.sqlite")).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE session_docs (
                     session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL,
                     title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
                     last_indexed_offset INTEGER NOT NULL DEFAULT 0);
                 CREATE VIRTUAL TABLE session_docs_fts USING fts5(
                     title, content, content='session_docs', content_rowid='rowid');
                 CREATE TRIGGER ai AFTER INSERT ON session_docs BEGIN
                     INSERT INTO session_docs_fts(rowid, title, content)
                     VALUES (new.rowid, new.title, new.content);
                 END;",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO meta (key, value) VALUES ('session_search_schema_version', ?1)",
                [version],
            )
            .unwrap();
            for (session_id, cwd, title, content) in docs {
                conn.execute(
                    "INSERT INTO session_docs (session_id, cwd, updated_at, title, content, content_hash)
                     VALUES (?1, ?2, 0, ?3, ?4, '')",
                    rusqlite::params![session_id, cwd, title, content],
                )
                .unwrap();
            }
            self
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn ids(results: &SearchResults) -> Vec<&str> {
        results.hits.iter().map(|hit| hit.id.as_str()).collect()
    }

    // ---- search: the bug itself ------------------------------------------------------

    /// THE BUG, pinned. The old search was a substring grep over each conversation's
    /// transcript, so "data" matched `data`base / meta`data` / vali`data`ted and returned
    /// 48 of 48 conversations — every row, no signal. Through FTS5 the query is a
    /// tokenized phrase, so it matches the WORD `data` and only the word.
    #[test]
    fn content_search_matches_words_not_substrings() {
        let store = TempStore::new();
        store
            .session("/repo", "hit", None, "2026-01-02")
            .session("/repo", "substring", None, "2026-01-01")
            .index(
                "4",
                &[
                    ("hit", "/repo", "", "we should store the data somewhere"),
                    ("substring", "/repo", "", "the database was validated with metadata"),
                ],
            );

        let found = search_sessions_at(store.root(), "data", None);
        assert_eq!(found.content_error, None);
        assert_eq!(
            ids(&found),
            vec!["hit"],
            "`database`/`metadata`/`validated` contain `data` as a SUBSTRING; only the real word counts"
        );
    }

    /// The other half of the same bug: a hit had no evidence attached, so a wall of
    /// identically-titled "Untitled conversation" rows was unreadable. Every content hit
    /// carries a snippet with the matched term delimited.
    #[test]
    fn content_hits_carry_a_snippet_marking_the_match() {
        let store = TempStore::new();
        store.session("/repo", "s1", None, "2026-01-01").index(
            "4",
            &[("s1", "/repo", "", "we should store the data somewhere safe")],
        );

        let found = search_sessions_at(store.root(), "data", None);
        let snippet = found.hits[0].snippet.as_deref().expect("a content hit must explain itself");
        assert!(
            snippet.contains(&format!("{SNIPPET_OPEN}data{SNIPPET_CLOSE}")),
            "the matched term is delimited: {snippet:?}"
        );
        assert!(snippet.contains("store the"), "and it carries the surrounding context");
        assert!(!found.hits[0].from_title);
    }

    /// The snippet marks MATCHES, and must stay distinguishable from prose that merely
    /// looks like a marker. Transcripts are full of real brackets — markdown links, array
    /// indices — so `[`/`]` delimiters would make a literal `[TODO]` in a transcript
    /// indistinguishable from a hit, and the frontend would emphasise the wrong words.
    /// STX/ETX cannot occur in the quoted prose.
    #[test]
    fn snippet_markers_cannot_be_confused_with_brackets_in_the_transcript() {
        let store = TempStore::new();
        store.session("/repo", "s1", None, "2026-01-01").index(
            "4",
            &[("s1", "/repo", "", "see [the docs](url) about parser internals")],
        );

        let snippet = search_sessions_at(store.root(), "parser", None).hits[0]
            .snippet
            .clone()
            .expect("a content hit must explain itself");
        assert!(snippet.contains("[the docs]"), "the transcript's own brackets survive: {snippet:?}");
        assert_eq!(
            snippet.matches(SNIPPET_OPEN).count(),
            1,
            "exactly one marked term — the bracketed prose is NOT marked: {snippet:?}"
        );
    }

    // ---- search: title first, and independent of the index ---------------------------

    /// The load-bearing property of the whole design. grok's indexer is LAZY and races —
    /// 2 of 53 real conversations are unindexed, and one of them has 31 messages. Title
    /// matching therefore must NOT go through the index, or a conversation the indexer
    /// missed becomes unfindable by any means. This conversation is absent from the index
    /// entirely and must still be found by its title.
    #[test]
    fn title_search_finds_a_conversation_the_index_never_saw() {
        let store = TempStore::new();
        store
            .session("/repo", "indexed", None, "2026-01-01")
            .session("/repo", "never-indexed", Some("Migrate the parser"), "2026-01-02")
            // `never-indexed` is deliberately NOT in this list — that is the ~4% case.
            .index("4", &[("indexed", "/repo", "", "nothing relevant here")]);

        let found = search_sessions_at(store.root(), "parser", None);
        assert_eq!(ids(&found), vec!["never-indexed"]);
        assert_eq!(found.content_error, None, "a healthy index that simply lags is not an error");
    }

    /// Title hits rank ABOVE content hits — "do a title search mainly, then priority to
    /// full content". The content hit here would win on bm25 alone (it's a dense match);
    /// it still sorts second.
    #[test]
    fn title_hits_outrank_content_hits() {
        let store = TempStore::new();
        store
            .session("/repo", "by-content", None, "2026-01-09")
            .session("/repo", "by-title", Some("The parser rewrite"), "2026-01-01")
            .index(
                "4",
                &[
                    ("by-content", "/repo", "", "parser parser parser parser parser"),
                    ("by-title", "/repo", "The parser rewrite", "unrelated prose"),
                ],
            );

        let found = search_sessions_at(store.root(), "parser", None);
        assert_eq!(ids(&found), vec!["by-title", "by-content"]);
        assert!(found.hits[0].from_title);
        assert!(!found.hits[1].from_title);
    }

    /// A conversation that matches BOTH halves appears once, as a title hit. Two rows for
    /// one conversation would be a new bug in a feature about legibility.
    #[test]
    fn a_conversation_matching_both_halves_appears_once() {
        let store = TempStore::new();
        store.session("/repo", "both", Some("The parser rewrite"), "2026-01-01").index(
            "4",
            &[("both", "/repo", "The parser rewrite", "the parser is slow")],
        );

        let found = search_sessions_at(store.root(), "parser", None);
        assert_eq!(ids(&found), vec!["both"]);
        assert!(found.hits[0].from_title);
        assert_eq!(
            found.hits[0].snippet, None,
            "the title is already the row's headline; repeating it underneath is noise"
        );
    }

    /// Title matching reads the title the row actually DISPLAYS. `list_sessions_at` falls
    /// back generated_title -> session_summary, and a conversation with no title at all is
    /// findable by the summary text that is standing in for one.
    #[test]
    fn title_search_reads_the_title_the_row_displays() {
        let store = TempStore::new();
        store.session("/repo", "fallback", None, "2026-01-01");
        // No generated_title; session_summary is what the sidebar shows instead.
        let dir = store.root().join(TempStore::encode("/repo")).join("fallback");
        std::fs::write(
            dir.join("summary.json"),
            json!({
                "info": {"id": "fallback", "cwd": "/repo"},
                "session_summary": "Refactoring the tokenizer",
                "updated_at": "2026-01-01",
            })
            .to_string(),
        )
        .unwrap();

        let found = search_sessions_at(store.root(), "tokenizer", None);
        assert_eq!(ids(&found), vec!["fallback"], "the visible text matched, so the row explains itself");
    }

    /// A nameless conversation has NOTHING for a title search to match — and the row it
    /// draws must not be matchable by the words we put in it on its behalf.
    ///
    /// The real shape, verified against the live store: for the 36 of 53 conversations
    /// with no name, `generated_title` is ABSENT while `session_summary` is PRESENT AND
    /// EMPTY. So the title resolves to `""` (which is why the sidebar's
    /// `title || "Untitled conversation"` fallback is what the user actually sees), and an
    /// empty title matches no query. `UNTITLED` is only reached when a summary.json has
    /// neither key — covered below, because that path is live code and would otherwise
    /// make "untitled" match every nameless conversation at once.
    #[test]
    fn a_nameless_conversation_is_not_matchable_by_the_words_we_gave_it() {
        let store = TempStore::new();
        store
            // The real-world shape: session_summary present, empty.
            .session("/repo", "nameless", None, "2026-01-01")
            .session("/repo", "real", Some("Untitled draft notes"), "2026-01-03")
            .index("4", &[]);
        // The shape that has neither key, which is what reaches the `UNTITLED` fallback.
        let dir = store.root().join(TempStore::encode("/repo")).join("no-keys");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("summary.json"),
            json!({"info": {"id": "no-keys", "cwd": "/repo"}, "updated_at": "2026-01-02"}).to_string(),
        )
        .unwrap();

        // Both really are nameless, by the two different routes.
        let listed = list_sessions_at(store.root(), Some("/repo".to_string()));
        let title = |id: &str| listed.iter().find(|s| s.id == id).unwrap().title.clone();
        assert_eq!(title("nameless"), "", "empty session_summary resolves to an empty title");
        assert_eq!(title("no-keys"), UNTITLED, "neither key resolves to our placeholder");

        assert_eq!(
            ids(&search_sessions_at(store.root(), "untitled", None)),
            vec!["real"],
            "only the conversation a human actually named `Untitled draft notes` matches"
        );
        // And the empty title can't be matched by an empty-ish query either.
        assert!(search_sessions_at(store.root(), "   ", None).hits.is_empty());
    }

    /// Title matching stays a case-insensitive LITERAL substring. Titles are short, and a
    /// user typing part of one expects to see it; the substring bug was about grepping
    /// whole TRANSCRIPTS, not about matching a headline.
    #[test]
    fn title_search_is_case_insensitive() {
        let store = TempStore::new();
        store.session("/repo", "s1", Some("Migrate The PARSER"), "2026-01-01");

        for query in ["parser", "PARSER", "PaRsEr", "the parser"] {
            assert_eq!(ids(&search_sessions_at(store.root(), query, None)), vec!["s1"], "query: {query}");
        }
    }

    // ---- search: cwd scoping, and the /tmp vs /private/tmp trap -----------------------

    /// The symlink trap, settled by evidence rather than by assumption.
    ///
    /// `session_docs.cwd` is NOT canonicalized: it is byte-identical to the percent-decoded
    /// store folder name, because grok writes the same string to both. Verified against the
    /// live store — all 51 indexed conversations match their folder exactly, zero mismatches.
    /// `/private/tmp` appears there not as a resolved `/tmp`, but because `%2Fprivate%2Ftmp`
    /// is its OWN project folder holding its OWN conversations, while `%2Ftmp` exists
    /// separately holding different ones.
    ///
    /// So the exact string compare is right, and "fixing" the symlink by canonicalizing
    /// either side would MERGE two projects the store deliberately keeps apart. This test
    /// exists to fail if someone ever tries.
    #[test]
    fn tmp_and_private_tmp_are_different_projects_not_a_symlink_to_resolve() {
        let store = TempStore::new();
        store
            .session("/tmp", "in-tmp", Some("Parser notes"), "2026-01-01")
            .session("/private/tmp", "in-private-tmp", Some("Parser notes"), "2026-01-02")
            .index(
                "4",
                &[
                    ("in-tmp", "/tmp", "", "the parser lives here"),
                    ("in-private-tmp", "/private/tmp", "", "the parser lives here"),
                ],
            );

        assert_eq!(
            ids(&search_sessions_at(store.root(), "parser", Some("/tmp"))),
            vec!["in-tmp"],
            "/tmp must not absorb /private/tmp's conversations"
        );
        assert_eq!(
            ids(&search_sessions_at(store.root(), "parser", Some("/private/tmp"))),
            vec!["in-private-tmp"],
            "/private/tmp must not absorb /tmp's conversations"
        );
        // Unscoped sees both, newest folder-walk order first for the title half.
        let all = search_sessions_at(store.root(), "parser", None);
        assert_eq!(all.hits.len(), 2, "no filter, no exclusions");
    }

    /// The cwd filter applies to BOTH halves. If it were enforced on the title walk but not
    /// on the SQL, a project window would leak other projects' conversations in through the
    /// content half — visible only as extra rows, which is exactly the kind of thing nobody
    /// notices.
    #[test]
    fn cwd_filter_scopes_the_content_half_too() {
        let store = TempStore::new();
        store
            .session("/repo/a", "a1", None, "2026-01-01")
            .session("/repo/b", "b1", None, "2026-01-02")
            .index(
                "4",
                &[
                    ("a1", "/repo/a", "", "the parser is here"),
                    ("b1", "/repo/b", "", "the parser is here too"),
                ],
            );

        assert_eq!(ids(&search_sessions_at(store.root(), "parser", Some("/repo/a"))), vec!["a1"]);
        assert_eq!(ids(&search_sessions_at(store.root(), "parser", Some("/repo/b"))), vec!["b1"]);
        assert!(
            search_sessions_at(store.root(), "parser", Some("/repo/nope")).hits.is_empty(),
            "a project with no conversations is empty, not everyone's"
        );
    }

    // ---- search: the degrade path ----------------------------------------------------
    //
    // The one outcome that is NOT allowed is a silent empty list. Content search reads an
    // index we don't own; when it can't run, title hits still stand and the failure is
    // REPORTED.

    /// No index on disk at all — a fresh install, or a grok too old to build one.
    #[test]
    fn a_missing_index_degrades_to_titles_and_says_so() {
        let store = TempStore::new();
        store.session("/repo", "s1", Some("Parser notes"), "2026-01-01");
        // Deliberately no `.index(..)` call.

        let found = search_sessions_at(store.root(), "parser", None);
        assert_eq!(ids(&found), vec!["s1"], "the title half is independent and still answers");
        let error = found.content_error.expect("a missing index must be REPORTED, never silent");
        assert!(error.to_lowercase().contains("content search is unavailable"), "{error}");
    }

    /// A schema we don't understand. Guessing at columns whose meaning may have changed is
    /// how you return confidently wrong results, so this degrades rather than adapts.
    #[test]
    fn an_unknown_schema_version_degrades_to_titles_and_says_so() {
        let store = TempStore::new();
        store
            .session("/repo", "s1", Some("Parser notes"), "2026-01-01")
            .index("5", &[("s1", "/repo", "", "the parser is here")]);

        let found = search_sessions_at(store.root(), "parser", None);
        assert_eq!(ids(&found), vec!["s1"]);
        let error = found.content_error.expect("an unreadable index must be REPORTED");
        assert!(error.contains('5') && error.contains('4'), "name both versions: {error}");
    }

    /// The degrade is not allowed to swallow the title half even when NOTHING matches a
    /// title: the result is an empty list PLUS an error, which the UI must not render as
    /// "No matches".
    #[test]
    fn a_degraded_search_with_no_title_hits_still_reports_the_error() {
        let store = TempStore::new();
        store.session("/repo", "s1", Some("Something else entirely"), "2026-01-01");

        let found = search_sessions_at(store.root(), "parser", None);
        assert!(found.hits.is_empty());
        assert!(
            found.content_error.is_some(),
            "an empty list with no error reads as `No matches` — a lie about a search that never ran"
        );
    }

    /// A corrupt/unreadable index file is a degrade, NOT a panic. A panic on the blocking
    /// pool comes back as a JoinError, and the old `unwrap_or_default()` would have turned
    /// that into an empty list — the silent failure again.
    #[test]
    fn a_corrupt_index_degrades_rather_than_panicking() {
        let store = TempStore::new();
        store.session("/repo", "s1", Some("Parser notes"), "2026-01-01");
        std::fs::write(store.root().join("session_search.sqlite"), b"this is not a database").unwrap();

        let found = search_sessions_at(store.root(), "parser", None);
        assert_eq!(ids(&found), vec!["s1"]);
        assert!(found.content_error.is_some(), "garbage on disk must be reported, not swallowed");
    }

    // ---- search: query handling ------------------------------------------------------

    /// An empty or whitespace-only query is not a search. No hits, and NO error — there is
    /// nothing wrong, so the UI must not light up a warning.
    #[test]
    fn an_empty_query_is_not_a_search_and_not_an_error() {
        let store = TempStore::new();
        store.session("/repo", "s1", Some("Parser"), "2026-01-01").index("4", &[]);

        for query in ["", "   ", "\t\n"] {
            let found = search_sessions_at(store.root(), query, None);
            assert!(found.hits.is_empty(), "query {query:?}");
            assert_eq!(found.content_error, None, "query {query:?} is blank, not broken");
        }
    }

    /// Punctuation-only input tokenizes to nothing. It must read as "no content match",
    /// never as "your index is broken" — alarm text about a healthy index is its own bug.
    ///
    /// This needs no special-casing on our side, which was worth checking rather than
    /// assuming: FTS5 answers a phrase containing no tokens (`MATCH '"..."'`) with zero
    /// rows and no error. An earlier draft carried a `has_searchable_token` guard here on
    /// the belief that FTS5 raised a syntax error; it does not, the guard was dead code,
    /// and removing it changed no behaviour this suite can observe.
    #[test]
    fn a_punctuation_only_query_is_not_an_index_failure() {
        let store = TempStore::new();
        store.session("/repo", "s1", None, "2026-01-01").index("4", &[("s1", "/repo", "", "hello")]);

        for query in ["...", "???", "-", "%"] {
            let found = search_sessions_at(store.root(), query, None);
            assert_eq!(found.content_error, None, "query {query:?} is unsearchable, not broken");
        }
    }

    /// FTS5 query syntax typed into a search box is TEXT, not operators. Unescaped, each of
    /// these is either a syntax error or a silently different search than the one the user
    /// typed — the second being far worse.
    #[test]
    fn fts_syntax_in_a_query_is_treated_as_literal_text() {
        let store = TempStore::new();
        store.session("/repo", "s1", None, "2026-01-01").index(
            "4",
            &[("s1", "/repo", "", "we discussed parser AND lexer design")],
        );

        for query in ["parser AND lexer", "parser OR lexer", "\"quoted\"", "parser*", "col:value", "("] {
            let found = search_sessions_at(store.root(), query, None);
            assert_eq!(found.content_error, None, "query {query:?} must not break the search");
        }

        // The literal phrase is what actually matches — proving the words weren't parsed
        // as operators.
        assert_eq!(ids(&search_sessions_at(store.root(), "parser AND lexer", None)), vec!["s1"]);
        assert!(
            search_sessions_at(store.root(), "lexer AND parser", None).hits.is_empty(),
            "as a phrase, word order matters — this is a literal search, not a boolean one"
        );
    }

    #[test]
    fn fts_phrase_query_wraps_and_escapes() {
        assert_eq!(fts_phrase_query("data"), "\"data\"");
        assert_eq!(fts_phrase_query("parser AND lexer"), "\"parser AND lexer\"");
        // The one that matters: a bare `"` would close the phrase and let the rest of the
        // user's text be parsed as query syntax.
        assert_eq!(fts_phrase_query("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(fts_phrase_query("\""), "\"\"\"\"");
    }

    // ---- search: the wire contract ---------------------------------------------------

    /// The shape `bridge.ts` reads. Field names here and in `SearchHit`/`SearchResults` on
    /// the TS side are one contract; a rename on either side is a silent empty sidebar.
    #[test]
    fn search_results_serialize_the_shape_the_frontend_reads() {
        let json = serde_json::to_value(SearchResults {
            hits: vec![
                SearchHit { id: "a".into(), snippet: None, from_title: true },
                SearchHit {
                    id: "b".into(),
                    snippet: Some(format!("the {SNIPPET_OPEN}data{SNIPPET_CLOSE} here")),
                    from_title: false,
                },
            ],
            content_error: Some("boom".into()),
        })
        .unwrap();
        assert_eq!(
            json,
            json!({
                "hits": [
                    {"id": "a", "snippet": null, "from_title": true},
                    {"id": "b", "snippet": "the \u{2}data\u{3} here", "from_title": false}
                ],
                "content_error": "boom"
            })
        );
    }

    // ---- list_project_files_inner ------------------------------------------------------

    /// A temp dir this test owns end to end, deleted on drop. Hand-rolled like
    /// `TempStore` above and for the same reason: no extra dependency for one throwaway
    /// fixture, and pid + a counter keeps it unique across concurrent test threads.
    struct TempProject(PathBuf);

    impl TempProject {
        fn new() -> TempProject {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "gbd-project-files-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("temp project dir");
            TempProject(path)
        }

        fn root(&self) -> &Path {
            &self.0
        }

        fn file(&self, relative: &str) -> &TempProject {
            let path = self.0.join(relative);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).expect("fixture parent dir");
            }
            std::fs::write(path, "fixture").expect("fixture file");
            self
        }
    }

    impl Drop for TempProject {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn list_project_files_inner_skips_generated_dirs_and_sorts_the_rest() {
        let project = TempProject::new();
        project
            .file("src/main.rs")
            .file("README.md")
            .file("src/lib/mod.rs")
            // Must be skipped: named generated dirs.
            .file("node_modules/left-pad/index.js")
            .file(".git/HEAD")
            // Must be skipped: any dotdir, not just the named ones.
            .file(".vscode/settings.json");

        let files = list_project_files_inner(project.root());

        assert_eq!(
            files,
            vec![
                "README.md".to_string(),
                "src/lib/mod.rs".to_string(),
                "src/main.rs".to_string(),
            ],
            "node_modules, .git and every other dotdir are skipped; the rest are sorted"
        );
    }

    #[test]
    fn list_project_files_inner_caps_rather_than_hangs_on_a_huge_tree() {
        let project = TempProject::new();
        for i in 0..(MAX_WALK_FILES + 50) {
            project.file(&format!("f{i}.txt"));
        }

        let files = list_project_files_inner(project.root());

        assert_eq!(
            files.len(),
            MAX_WALK_FILES,
            "the walk stops cleanly at the cap instead of erroring or running unbounded"
        );
    }
}
