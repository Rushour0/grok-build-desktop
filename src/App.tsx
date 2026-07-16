import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  authStatus,
  installGrok,
  connect,
  authenticate,
  openSession,
  sendPrompt,
  cancelRun,
  subscribe,
  type AuthMethod,
  type SessionUpdate,
} from "./lib/bridge";
import "./App.css";

// What the user is doing right now. The app is a straight line:
// setup -> sign in -> pick a folder -> chat.
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
type Item = ToolItem | TextItem;

const isTool = (i: Item): i is ToolItem => i.kind === "tool";

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

  const scrollRef = useRef<HTMLDivElement>(null);
  // Chunks stream in one fragment at a time; keep appending to the same bubble
  // until the turn ends rather than making a bubble per fragment.
  const openBubble = useRef<{ answer?: string; thought?: string }>({});

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items, busy]);

  useEffect(() => {
    authStatus()
      .then((s) => setStage(s.grok_installed ? "ready" : "needs-install"))
      .catch(() => setStage("needs-install"));
  }, []);

  const appendText = useCallback((kind: TextItem["kind"], id: string, chunk: string) => {
    setItems((prev) => {
      const last = prev[prev.length - 1];
      if (last && !isTool(last) && last.id === id) {
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
        default:
          break; // plan/user chunks: not surfaced yet
      }
    },
    [appendText],
  );

  useEffect(() => {
    const off = subscribe({
      onUpdate,
      onTurnEnd: () => {
        setBusy(false);
        openBubble.current = {};
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

  async function pickFolder() {
    const picked = await open({ directory: true, multiple: false, title: "Choose a project folder" });
    if (typeof picked !== "string") return;
    setNotice(null);
    try {
      const res = await connect(picked);
      setCwd(picked);
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

  async function stop() {
    await cancelRun().catch(() => {});
    setBusy(false);
    setStage("ready");
    setCwd(null);
  }

  if (stage === "checking") {
    return <Splash title="Grok Build Desktop" line="Getting things ready…" />;
  }

  if (stage === "needs-install" || stage === "installing") {
    return (
      <Splash
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
      <Splash title="Grok Build Desktop" line="Pick the project folder you want to work on.">
        <button className="primary" onClick={pickFolder}>
          Choose a folder…
        </button>
        {notice && <p className="notice error">{notice}</p>}
      </Splash>
    );
  }

  if (stage === "authenticating") {
    return (
      <Splash title="Sign in to continue" line="Grok needs you signed in before it can work on your project.">
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
      <header className="bar">
        <div className="folder">
          <span className="dot" />
          {cwd ? folderName(cwd) : "—"}
        </div>
        <button className="ghost" onClick={stop}>
          Close folder
        </button>
      </header>

      <div className="stream" ref={scrollRef}>
        {items.length === 0 && (
          <p className="empty">
            Tell Grok what you want done in this folder — in plain English.
            <br />
            <span>e.g. “add a README explaining what this project does”</span>
          </p>
        )}
        {items.map((i) =>
          isTool(i) ? (
            <div key={i.id} className={`tool ${i.status}`}>
              <span className="tick" />
              {i.title}
            </div>
          ) : (
            <div key={i.id} className={`bubble ${i.kind}`}>
              {i.text}
            </div>
          ),
        )}
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

function Splash({
  title,
  line,
  children,
}: {
  title: string;
  line: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="splash">
      <div className="mark" />
      <h1>{title}</h1>
      <p>{line}</p>
      {children}
    </main>
  );
}
