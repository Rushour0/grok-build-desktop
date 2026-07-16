import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  authStatus,
  installGrok,
  recentProjects,
  listSessions,
  loadSessionUpdates,
  searchSessions,
  connect,
  authenticate,
  openSession,
  sendPrompt,
  cancelRun,
  respondPermission,
  respondHook,
  subscribe,
  type AuthMethod,
  type PermissionRequest,
  type Project,
  type SessionMeta,
  type SessionUpdate,
} from "./lib/bridge";
import "./App.css";

// Installation is global; folders, authentication, and conversations live in tabs.
type Stage = "checking" | "needs-install" | "installing" | "ready" | "chat";

interface ToolItem {
  id: string;
  kind: "tool";
  title: string;
  status: string;
}
interface TextItem {
  id: string;
  kind: "answer" | "thought" | "you" | "error";
  text: string;
}
interface AskItem {
  id: string;
  kind: "ask";
  req: PermissionRequest;
  decided: string | null;
}
interface PlanItem {
  id: string;
  kind: "plan";
  entries: { content: string; status?: string; priority?: string }[];
}
type Item = ToolItem | TextItem | AskItem | PlanItem;

interface Tab {
  id: string;
  cwd: string | null;
  sessionId: string | null;
  items: Item[];
  busy: boolean;
  draft: string;
  attachments: string[];
  needsAuth: boolean;
  authMethods: AuthMethod[];
}

let nextTabId = 1;
let nextItemId = 1;

function createTab(): Tab {
  return {
    id: `tab-${nextTabId++}`,
    cwd: null,
    sessionId: null,
    items: [],
    busy: false,
    draft: "",
    attachments: [],
    needsAuth: false,
    authMethods: [],
  };
}

function itemId(prefix: string): string {
  return `${prefix}-${nextItemId++}`;
}

const isTool = (i: Item): i is ToolItem => i.kind === "tool";
const isAsk = (i: Item): i is AskItem => i.kind === "ask";
const isPlan = (i: Item): i is PlanItem => i.kind === "plan";
const isText = (i: Item): i is TextItem => !isTool(i) && !isAsk(i) && !isPlan(i);

function folderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function toMention(cwd: string | null, absPath: string): string {
  const path = cwd && (absPath === cwd || absPath.startsWith(`${cwd}/`))
    ? absPath.slice(absPath === cwd ? cwd.length : cwd.length + 1)
    : absPath;
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path);
}

function reduceUpdates(updates: SessionUpdate[]): Item[] {
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
        case "tool_call":
          return {
            items: [
              ...state.items,
              {
                id: update.toolCallId ?? `tool-${index}`,
                kind: "tool",
                title: update.title ?? update.kind ?? "Working",
                status: update.status ?? "completed",
              },
            ],
          };
        case "tool_call_update":
          return {
            ...state,
            items: state.items.map((item) =>
              isTool(item) && item.id === update.toolCallId
                ? {
                    ...item,
                    status: update.status ?? item.status,
                    title: update.title ?? item.title,
                  }
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

function sessionDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

export default function App() {
  const [stage, setStage] = useState<Stage>("checking");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [recents, setRecents] = useState<Project[]>([]);
  const [historySessions, setHistorySessions] = useState<SessionMeta[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historySearchIds, setHistorySearchIds] = useState<string[]>([]);
  const [historySearching, setHistorySearching] = useState(false);
  const [historySession, setHistorySession] = useState<SessionMeta | null>(null);
  const [historyItems, setHistoryItems] = useState<Item[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyListError, setHistoryListError] = useState<string | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRequest = useRef(0);
  const tabsRef = useRef(tabs);
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [activeTab?.items, activeTab?.busy, historySession]);

  useEffect(() => {
    authStatus()
      .then((s) => setStage(s.grok_installed ? "ready" : "needs-install"))
      .catch(() => setStage("needs-install"));
  }, []);

  // Refresh the recents whenever we're back at the picker — the CLI may have
  // gained sessions since last time (including from the terminal).
  useEffect(() => {
    if (stage === "ready") recentProjects().then(setRecents).catch(() => setRecents([]));
  }, [stage]);

  useEffect(() => {
    if (stage !== "ready" && stage !== "chat") return;
    let cancelled = false;
    setHistoryLoading(true);
    setHistoryListError(null);
    listSessions()
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
  }, [stage, historyRevision]);

  useEffect(() => {
    if (stage !== "ready" && stage !== "chat") return;
    const query = historyQuery.trim();
    setHistorySearchIds([]);
    if (!query) {
      setHistorySearching(false);
      return;
    }

    let cancelled = false;
    setHistorySearching(true);
    const timer = window.setTimeout(() => {
      searchSessions(query)
        .then((ids) => {
          if (!cancelled) setHistorySearchIds(ids);
        })
        .catch(() => {
          if (!cancelled) setHistorySearchIds([]);
        })
        .finally(() => {
          if (!cancelled) setHistorySearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [historyQuery, stage]);

  // Offer updates rather than forcing them: an agent mid-task shouldn't be
  // restarted out from under the user. `check()` is a no-op in dev.
  useEffect(() => {
    check()
      .then((u) => u && setUpdate(u))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const dropTabId = activeTab?.id;
    const dropCwd = activeTab?.cwd;
    if (stage !== "chat" || !dropTabId || !dropCwd || historySession) {
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
  }, [activeTab?.cwd, activeTab?.id, historySession, stage, updateTab]);

  async function installUpdate() {
    if (!update) return;
    setUpdating(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      setUpdating(false);
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
              { id, kind: "tool", title: u.title ?? u.kind ?? "Working", status: u.status ?? "in_progress" },
            ],
          }));
          // A tool ran, so any answer text after it belongs in a fresh bubble.
          openBubbles.current.set(tabId, {});
          break;
        }
        case "tool_call_update": {
          updateTab(tabId, (tab) => ({
            ...tab,
            items: tab.items.map((i) =>
              isTool(i) && i.id === u.toolCallId
                ? { ...i, status: u.status ?? i.status, title: u.title ?? i.title }
                : i,
            ),
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
        default:
          break; // user_message_chunk: the echo of our own prompt, no need to show
      }
    },
    [appendText, updateTab],
  );

  useEffect(() => {
    const off = subscribe({
      onUpdate,
      onPermission: (tabId, req) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        openBubbles.current.set(tabId, {});
        updateTab(tabId, (tab) => ({
          ...tab,
          items: [...tab.items, { id: itemId("p"), kind: "ask", req, decided: null }],
        }));
      },
      onTurnEnd: (tabId) => {
        if (!tabsRef.current.some((tab) => tab.id === tabId)) return;
        updateTab(tabId, (tab) => ({ ...tab, busy: false }));
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
  }, [onUpdate, updateTab]);

  async function decide(tab: Tab, item: AskItem, optionId: string | null, label: string) {
    // Hook-gated requests (the path that fires today) go back through respondHook;
    // ACP requests through respondPermission. `optionId === "allow"` means approve.
    if (item.req.hookToolUseId) {
      await respondHook(tab.id, item.req.hookToolUseId, optionId === "allow").catch(() => {});
    } else {
      await respondPermission(tab.id, item.req.requestId, optionId).catch(() => {});
    }
    updateTab(tab.id, (current) => ({
      ...current,
      items: current.items.map((i) => (isAsk(i) && i.id === item.id ? { ...i, decided: label } : i)),
    }));
  }

  async function doInstall() {
    setStage("installing");
    setNotice(null);
    try {
      await installGrok();
      setStage("ready");
    } catch (e) {
      setNotice(String(e));
      setStage("needs-install");
    }
  }

  function addTab(): Tab {
    const tab = createTab();
    setTabs((current) => {
      const nextTabs = [...current, tab];
      tabsRef.current = nextTabs;
      return nextTabs;
    });
    setActiveTabId(tab.id);
    setStage("chat");
    return tab;
  }

  async function openFolder(tabId: string, path: string) {
    closeTranscript();
    setNotice(null);
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
      }));
      setDragging(false);
      setHistoryRevision((revision) => revision + 1);
      setStage("chat");
    } catch (e) {
      setNotice(String(e));
    }
  }

  async function pickFolder(tabId?: string) {
    closeTranscript();
    const target = tabId ? tabsRef.current.find((tab) => tab.id === tabId) : addTab();
    if (!target) return;
    setActiveTabId(target.id);
    const picked = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (typeof picked !== "string") return;
    await openFolder(target.id, picked);
  }

  async function openRecent(path: string) {
    const tab = addTab();
    await openFolder(tab.id, path);
  }

  // A new tab is a parallel RUN in the CURRENT project (e.g. one agent fixes a
  // bug while another writes tests, same repo) — not a different project. Only
  // fall back to the folder picker when nothing is open yet.
  async function addRun() {
    const folder = activeTab?.cwd ?? tabsRef.current.find((tab) => tab.cwd)?.cwd ?? null;
    if (!folder) {
      await pickFolder();
      return;
    }
    const tab = addTab();
    await openFolder(tab.id, folder);
  }

  async function signIn(tab: Tab, methodId: string) {
    setNotice("A browser window will open — finish signing in there.");
    try {
      await authenticate(tab.id, methodId);
      if (!tabsRef.current.some((candidate) => candidate.id === tab.id)) return;
      const sessionId = tab.cwd ? await openSession(tab.id, tab.cwd) : tab.sessionId;
      updateTab(tab.id, (current) => ({
        ...current,
        sessionId,
        needsAuth: false,
        authMethods: [],
      }));
      setNotice(null);
      setStage("chat");
    } catch (e) {
      setNotice(String(e));
    }
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
    if (activeTabId === tabId) {
      setActiveTabId(nextTabs[Math.min(index, nextTabs.length - 1)]?.id ?? null);
    }
    setDragging(false);
    if (nextTabs.length === 0) setStage("ready");
  }

  async function viewSession(session: SessionMeta) {
    const request = ++transcriptRequest.current;
    setHistorySession(session);
    setHistoryItems([]);
    setTranscriptLoading(true);
    setHistoryError(null);
    try {
      const updates = await loadSessionUpdates(session.cwd, session.id);
      if (transcriptRequest.current === request) setHistoryItems(reduceUpdates(updates));
    } catch (error) {
      if (transcriptRequest.current === request) setHistoryError(String(error));
    } finally {
      if (transcriptRequest.current === request) setTranscriptLoading(false);
    }
  }

  function closeTranscript() {
    transcriptRequest.current += 1;
    setHistorySession(null);
    setHistoryItems([]);
    setTranscriptLoading(false);
    setHistoryError(null);
  }

  const banner = update ? (
    <UpdateBanner update={update} busy={updating} onInstall={installUpdate} />
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
          {stage === "installing" ? "Installing…" : "Install Grok Build"}
        </button>
        {notice && <p className="notice error">{notice}</p>}
      </Splash>
    );
  }

  const query = historyQuery.trim().toLocaleLowerCase();
  const contentMatches = new Set(historySearchIds);
  const filteredSessions = query
    ? historySessions.filter(
        (session) =>
          session.title.toLocaleLowerCase().includes(query) ||
          session.summary.toLocaleLowerCase().includes(query) ||
          contentMatches.has(session.id),
      )
    : historySessions;

  return (
    <div className="shell">
      {banner}
      <div className="shell-body">
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="sidebar-brand">
              <span className="mark" />
              <strong>Grok Build</strong>
            </div>
            <button className="new-chat primary" onClick={() => addRun()}>
              New chat
            </button>
            <button
              className="open-folder ghost"
              onClick={() => pickFolder()}
              title="Open a different project folder"
            >
              Open folder…
            </button>
          </div>
          <input
            className="side-search"
            type="search"
            value={historyQuery}
            onChange={(event) => setHistoryQuery(event.currentTarget.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
          <div className="side-list">
            {historyLoading && historySessions.length === 0 && (
              <div className="side-state">Loading conversations…</div>
            )}
            {!historyLoading && historyListError && <div className="side-state error">{historyListError}</div>}
            {(!historyLoading || historySessions.length > 0) &&
              !historyListError &&
              filteredSessions.length === 0 && (
                <div className="side-state">
                  {query ? (historySearching ? "Searching…" : "No matches") : "No conversations yet"}
                </div>
              )}
            {(!historyLoading || historySessions.length > 0) &&
              !historyListError &&
              filteredSessions.map((session) => (
                <button
                  key={session.id}
                  className={`side-row${historySession?.id === session.id ? " active" : ""}`}
                  onClick={() => viewSession(session)}
                  title={session.cwd}
                  aria-current={historySession?.id === session.id ? "page" : undefined}
                >
                  <strong>{session.title || "Untitled conversation"}</strong>
                  <span className="side-row-meta">
                    {folderName(session.cwd)} · {sessionDate(session.updated_at)}
                  </span>
                </button>
              ))}
          </div>
        </aside>

        <main className="content">
          {dragging && stage === "chat" && activeTab?.cwd && !historySession && (
            <div className="drop-overlay">Drop files to attach</div>
          )}
          {historySession ? (
            <>
              <header className="content-header">
                <div className="content-title">
                  <h1>{historySession.title || "Untitled conversation"}</h1>
                  <span title={historySession.cwd}>{folderName(historySession.cwd)}</span>
                </div>
                <button
                  className="transcript-close"
                  onClick={closeTranscript}
                  aria-label="Close transcript"
                  title="Close transcript"
                >
                  ×
                </button>
              </header>
              <div className="stream">
                {transcriptLoading && <div className="history-state">Loading conversation…</div>}
                {!transcriptLoading && historyError && <div className="history-state error">{historyError}</div>}
                {!transcriptLoading && !historyError && historyItems.length === 0 && (
                  <div className="history-state">This conversation has no messages.</div>
                )}
                <TranscriptItems items={historyItems} />
              </div>
            </>
          ) : tabs.length > 0 ? (
            <>
              <nav className="tab-strip" aria-label="Chat tabs">
                {tabs.map((tab) => (
                  <div className={`chat-tab${tab.id === activeTabId ? " active" : ""}`} key={tab.id}>
                    <button
                      className="tab-select"
                      onClick={() => setActiveTabId(tab.id)}
                      aria-current={tab.id === activeTabId ? "page" : undefined}
                      title={tab.cwd ?? "New tab"}
                    >
                      {tab.cwd ? folderName(tab.cwd) : "New tab"}
                    </button>
                    <button
                      className="tab-close"
                      onClick={() => closeTab(tab.id)}
                      aria-label={`Close ${tab.cwd ? folderName(tab.cwd) : "new tab"}`}
                      title="Close tab"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  className="tab-add"
                  onClick={() => addRun()}
                  aria-label="New run in this project"
                  title="New run in this project"
                >
                  +
                </button>
              </nav>

              {activeTab?.needsAuth ? (
                <div className="content-empty tab-auth">
                  <h1>Sign in to continue</h1>
                  <p>Grok needs you signed in before it can work on this project.</p>
                  {activeTab.authMethods.map((method) => (
                    <button key={method.id} className="primary" onClick={() => signIn(activeTab, method.id)}>
                      {method.description ?? `Sign in with ${method.name}`}
                    </button>
                  ))}
                  {notice && <p className="notice">{notice}</p>}
                </div>
              ) : activeTab?.cwd ? (
                <>
                  <header className="bar">
                    {/* The full path is the answer to "does it actually know where it's working?" */}
                    <div className="folder" title={activeTab.cwd}>
                      <span className="dot" />
                      <strong>{folderName(activeTab.cwd)}</strong>
                      <span className="path">{activeTab.cwd}</span>
                    </div>
                    <button className="ghost" onClick={() => closeTab(activeTab.id)}>
                      Close tab
                    </button>
                  </header>

                  <div className="stream" ref={scrollRef}>
                    {activeTab.items.length === 0 && (
                      <div className="empty">
                        <p>
                          Grok can read and edit everything in <strong>{folderName(activeTab.cwd)}</strong>. Tell it
                          what you want done, in plain English.
                        </p>
                        <p className="eg">e.g. “add a README explaining what this project does”</p>
                        {/* Be straight about this: Grok's agent mode applies edits itself. */}
                        <p className="eg warn">
                          Grok can change files here on its own. Use a folder you can undo — ideally one in git.
                        </p>
                      </div>
                    )}
                    <TranscriptItems
                      items={activeTab.items}
                      onDecide={(item, optionId, label) => decide(activeTab, item, optionId, label)}
                    />
                    {activeTab.busy && (
                      <div className="working">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
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
                    <textarea
                      value={activeTab.draft}
                      onChange={(e) => {
                        const draft = e.currentTarget.value;
                        updateActiveTab((tab) => ({ ...tab, draft }));
                      }}
                      onKeyDown={(e) => {
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
              ) : (
                <div className="content-empty">
                  <h1>Choose a folder for this tab</h1>
                  <p>This tab is ready for a project folder.</p>
                  <button className="primary" onClick={() => pickFolder(activeTab?.id)}>
                    Choose a folder…
                  </button>
                  {notice && <p className="notice error">{notice}</p>}
                </div>
              )}
            </>
          ) : (
            <div className="content-empty">
              <h1>Open a folder to start</h1>
              <p>Choose a project folder for your next conversation.</p>
              <button className="primary" onClick={() => pickFolder()}>
                Choose a folder…
              </button>
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
          )}
        </main>
      </div>
    </div>
  );
}

function TranscriptItems({
  items,
  onDecide,
}: {
  items: Item[];
  onDecide?: (i: AskItem, optionId: string | null, label: string) => void;
}) {
  return items.map((item) => {
    if (isTool(item)) {
      return (
        <div key={item.id} className={`tool ${item.status}`}>
          <span className="tick" />
          {item.title}
        </div>
      );
    }
    if (isAsk(item)) return <PermissionCard key={item.id} item={item} onDecide={onDecide} />;
    if (isPlan(item)) return <PlanCard key={item.id} entries={item.entries} />;
    return (
      <div key={item.id} className={`bubble ${item.kind}`}>
        {item.text}
      </div>
    );
  });
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

  return (
    <div className="ask">
      <div className="ask-head">{toolCall?.title ?? "Grok wants to make a change"}</div>
      {diffs.map((d, n) => (
        <div className="diff" key={`d${n}`}>
          {d.path && <div className="diff-path">{d.path}</div>}
          <Diff oldText={d.oldText ?? ""} newText={d.newText ?? ""} />
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

/// Deliberately dumb line diff — enough to answer "what is about to change?".
function Diff({ oldText, newText }: { oldText: string; newText: string }) {
  const before = oldText ? oldText.split("\n") : [];
  const after = newText ? newText.split("\n") : [];
  const removed = before.filter((l) => !after.includes(l));
  const added = after.filter((l) => !before.includes(l));
  return (
    <pre className="diff-body">
      {removed.map((l, i) => (
        <div key={`r${i}`} className="del">
          - {l}
        </div>
      ))}
      {added.map((l, i) => (
        <div key={`a${i}`} className="add">
          + {l}
        </div>
      ))}
      {!removed.length && !added.length && <div className="nil">(no textual change)</div>}
    </pre>
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
      {banner}
      <div className="mark" />
      <h1>{title}</h1>
      <p>{line}</p>
      {children}
    </main>
  );
}

/// Shown on every screen when a newer release exists. Opt-in, never automatic.
function UpdateBanner({
  update,
  busy,
  onInstall,
}: {
  update: Update;
  busy: boolean;
  onInstall: () => void;
}) {
  return (
    <div className="update">
      <span>Version {update.version} is available.</span>
      <button onClick={onInstall} disabled={busy}>
        {busy ? "Updating…" : "Update & restart"}
      </button>
    </div>
  );
}
