import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  authStatus,
  installGrok,
  recentProjects,
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
  type SessionUpdate,
} from "./lib/bridge";
import "./App.css";

// The app is a straight line: setup -> sign in -> pick a folder -> chat.
type Stage = "checking" | "needs-install" | "installing" | "ready" | "authenticating" | "chat";

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

const isTool = (i: Item): i is ToolItem => i.kind === "tool";
const isAsk = (i: Item): i is AskItem => i.kind === "ask";
const isPlan = (i: Item): i is PlanItem => i.kind === "plan";
const isText = (i: Item): i is TextItem => !isTool(i) && !isAsk(i) && !isPlan(i);

function folderName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export default function App() {
  const [stage, setStage] = useState<Stage>("checking");
  const [cwd, setCwd] = useState<string | null>(null);
  const [authMethods, setAuthMethods] = useState<AuthMethod[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [recents, setRecents] = useState<Project[]>([]);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updating, setUpdating] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Chunks stream in one fragment at a time; keep appending to the same bubble
  // until something else happens rather than making a bubble per fragment.
  const openBubble = useRef<{ answer?: string; thought?: string }>({});
  // Grok resends the whole plan as it evolves; update one card in place per turn.
  const planId = useRef<string | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items, busy]);

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

  // Offer updates rather than forcing them: an agent mid-task shouldn't be
  // restarted out from under the user. `check()` is a no-op in dev.
  useEffect(() => {
    check()
      .then((u) => u && setUpdate(u))
      .catch(() => {});
  }, []);

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

  const appendText = useCallback((kind: TextItem["kind"], id: string, chunk: string) => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && isText(last) && last.id === id) {
        return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
      }
      return [...prev, { id, kind, text: chunk }];
    });
  }, []);

  const onUpdate = useCallback(
    (u: SessionUpdate) => {
      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          openBubble.current.answer ??= `a-${Date.now()}`;
          appendText("answer", openBubble.current.answer, u.content?.text ?? "");
          break;
        }
        case "agent_thought_chunk": {
          openBubble.current.thought ??= `t-${Date.now()}`;
          appendText("thought", openBubble.current.thought, u.content?.text ?? "");
          break;
        }
        case "tool_call": {
          const id = u.toolCallId ?? `tool-${Date.now()}`;
          setItems((prev) => [
            ...prev,
            { id, kind: "tool", title: u.title ?? u.kind ?? "Working", status: u.status ?? "in_progress" },
          ]);
          // A tool ran, so any answer text after it belongs in a fresh bubble.
          openBubble.current = {};
          break;
        }
        case "tool_call_update": {
          setItems((prev) =>
            prev.map((i) =>
              isTool(i) && i.id === u.toolCallId
                ? { ...i, status: u.status ?? i.status, title: u.title ?? i.title }
                : i,
            ),
          );
          break;
        }
        case "plan": {
          const entries = u.entries ?? [];
          // Decide the plan item's id outside the updater so the updater stays a
          // pure function (no ref mutation under StrictMode double-invocation).
          if (!planId.current) planId.current = `plan-${Date.now()}`;
          const id = planId.current;
          setItems((prev) =>
            prev.some((i) => isPlan(i) && i.id === id)
              ? prev.map((i) => (isPlan(i) && i.id === id ? { ...i, entries } : i))
              : [...prev, { id, kind: "plan", entries }],
          );
          openBubble.current = {};
          break;
        }
        default:
          break; // user_message_chunk: the echo of our own prompt, no need to show
      }
    },
    [appendText],
  );

  useEffect(() => {
    const off = subscribe({
      onUpdate,
      onPermission: (req) => {
        openBubble.current = {};
        setItems((prev) => [...prev, { id: `p-${req.requestId}`, kind: "ask", req, decided: null }]);
      },
      onTurnEnd: () => {
        setBusy(false);
        openBubble.current = {};
        planId.current = null; // next turn starts a fresh plan
      },
      onError: (message) => {
        setBusy(false);
        openBubble.current = {};
        setItems((prev) => [...prev, { id: `e-${Date.now()}`, kind: "error", text: message }]);
      },
      onClosed: () => setBusy(false),
    });
    return () => {
      off.then((fn) => fn());
    };
  }, [onUpdate]);

  async function decide(item: AskItem, optionId: string | null, label: string) {
    // Hook-gated requests (the path that fires today) go back through respondHook;
    // ACP requests through respondPermission. `optionId === "allow"` means approve.
    if (item.req.hookToolUseId) {
      await respondHook(item.req.hookToolUseId, optionId === "allow").catch(() => {});
    } else {
      await respondPermission(item.req.requestId, optionId).catch(() => {});
    }
    setItems((prev) => prev.map((i) => (isAsk(i) && i.id === item.id ? { ...i, decided: label } : i)));
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

  async function openFolder(path: string) {
    setNotice(null);
    try {
      const res = await connect(path);
      setCwd(path);
      if (res.needs_auth) {
        setAuthMethods(res.auth_methods);
        setStage("authenticating");
      } else {
        setStage("chat");
      }
    } catch (e) {
      setNotice(String(e));
    }
  }

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (typeof picked !== "string") return;
    await openFolder(picked);
  }

  async function signIn(methodId: string) {
    setNotice("A browser window will open — finish signing in there.");
    try {
      await authenticate(methodId);
      if (cwd) await openSession(cwd);
      setNotice(null);
      setStage("chat");
    } catch (e) {
      setNotice(String(e));
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setItems((prev) => [...prev, { id: `u-${Date.now()}`, kind: "you", text }]);
    openBubble.current = {};
    setBusy(true);
    try {
      await sendPrompt(text);
    } catch (e) {
      setBusy(false);
      setItems((prev) => [...prev, { id: `e-${Date.now()}`, kind: "error", text: String(e) }]);
    }
  }

  async function closeFolder() {
    await cancelRun().catch(() => {});
    setBusy(false);
    setItems([]);
    setStage("ready");
    setCwd(null);
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

  if (stage === "ready") {
    return (
      <Splash banner={banner} title="Grok Build Desktop" line="Pick the project folder you want to work on.">
        <button className="primary" onClick={pickFolder}>
          Choose a folder…
        </button>
        {recents.length > 0 && (
          <div className="recents">
            <div className="recents-head">Recent</div>
            {recents.map((p) => (
              <button key={p.path} className="recent" onClick={() => openFolder(p.path)} title={p.path}>
                <strong>{p.name}</strong>
                <span>{p.path}</span>
              </button>
            ))}
          </div>
        )}
        {notice && <p className="notice error">{notice}</p>}
      </Splash>
    );
  }

  if (stage === "authenticating") {
    return (
      <Splash banner={banner} title="Sign in to continue" line="Grok needs you signed in before it can work on your project.">
        {authMethods.map((m) => (
          <button key={m.id} className="primary" onClick={() => signIn(m.id)}>
            {m.description ?? `Sign in with ${m.name}`}
          </button>
        ))}
        {notice && <p className="notice">{notice}</p>}
      </Splash>
    );
  }

  return (
    <main className="app">
      {banner}
      <header className="bar">
        {/* The full path is the answer to "does it actually know where it's working?" */}
        <div className="folder" title={cwd ?? ""}>
          <span className="dot" />
          <strong>{cwd ? folderName(cwd) : "—"}</strong>
          <span className="path">{cwd}</span>
        </div>
        <button className="ghost" onClick={closeFolder}>
          Close folder
        </button>
      </header>

      <div className="stream" ref={scrollRef}>
        {items.length === 0 && (
          <div className="empty">
            <p>
              Grok can read and edit everything in <strong>{cwd ? folderName(cwd) : "this folder"}</strong>.
              Tell it what you want done, in plain English.
            </p>
            <p className="eg">e.g. “add a README explaining what this project does”</p>
            {/* Be straight about this: Grok's agent mode applies edits itself. */}
            <p className="eg warn">Grok can change files here on its own. Use a folder you can undo — ideally one in git.</p>
          </div>
        )}
        {items.map((i) => {
          if (isTool(i)) {
            return (
              <div key={i.id} className={`tool ${i.status}`}>
                <span className="tick" />
                {i.title}
              </div>
            );
          }
          if (isAsk(i)) return <PermissionCard key={i.id} item={i} onDecide={decide} />;
          if (isPlan(i)) return <PlanCard key={i.id} entries={i.entries} />;
          return (
            <div key={i.id} className={`bubble ${i.kind}`}>
              {i.text}
            </div>
          );
        })}
        {busy && (
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
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="What should Grok do?"
          rows={1}
        />
        <button type="submit" className="primary" disabled={busy || !draft.trim()}>
          {busy ? "Working…" : "Send"}
        </button>
      </form>
    </main>
  );
}

/// The gate. Our PreToolUse hook holds Grok's tool call open until the user
/// answers here, so an approved edit is the only one that lands. Best-effort, not
/// a hard boundary: grok's hook runner fails open if approval times out or errors.
function PermissionCard({
  item,
  onDecide,
}: {
  item: AskItem;
  onDecide: (i: AskItem, optionId: string | null, label: string) => void;
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
