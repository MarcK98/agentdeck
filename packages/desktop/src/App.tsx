import { useEffect, useRef, useState } from "react";
import type { ApprovalRequest, Message, Project, ProjectSettings, Thread } from "./types";

// Spawn MVP shell — three panes, Discord-shaped: projects rail / threads /
// active thread. Phase 1 scope: incremental streaming (events ship the
// persisted row), approval modals, thread rename + auto-title, and a
// per-project settings panel.

// The full model menu; a project opts in per-model (fable is opt-in only).
const MODELS = ["haiku", "sonnet", "opus", "fable"];

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  // Which threads have a turn in flight — per-thread, so streaming in one
  // thread never shows a phantom "working" or locks the composer in another.
  const [busyThreads, setBusyThreads] = useState<Set<number>>(new Set());
  // Pending permission prompt — global, so a background thread's prompt still
  // reaches the user.
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // Inline thread rename (double-click a title).
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Settings panel for the selected project; non-null = open.
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.spawn.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    if (projectId == null) return;
    window.spawn.listThreads(projectId).then(setThreads);
    setThreadId(null);
    setMessages([]);
    setSettings(null);
  }, [projectId]);

  useEffect(() => {
    if (threadId == null) return;
    window.spawn.listMessages(threadId).then(setMessages);
  }, [threadId]);

  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (ev.type === "thread:updated") {
        setThreads((prev) => prev.map((t) => (t.id === ev.payload.id ? ev.payload : t)));
        return;
      }
      if (ev.type === "approval:request") {
        setApproval(ev.payload);
        return;
      }
      if (ev.type === "approval:resolved") {
        setApproval((cur) => (cur?.id === ev.payload.id ? null : cur));
        return;
      }
      if (ev.type === "turn:done") {
        // A finished turn can't still be waiting on an approval.
        setApproval((cur) => (cur?.threadId === ev.payload.threadId ? null : cur));
        setBusyThreads((prev) => {
          const next = new Set(prev);
          next.delete(ev.payload.threadId);
          return next;
        });
        return;
      }
      if (ev.type === "turn:text" || ev.type === "turn:tool") {
        if (ev.payload.threadId !== threadId) return;
        // The event ships the persisted row — append it; dedupe by id in case
        // of a double-deliver.
        const msg = ev.payload.message;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      }
    });
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const openThread = async () => {
    if (projectId == null) return;
    // Untitled — the daemon defaults it and the first message auto-titles it.
    const t = await window.spawn.createThread({ projectId, title: "" });
    setThreads((prev) => [t, ...prev]);
    setThreadId(t.id);
  };

  const startRename = (t: Thread) => {
    setRenamingId(t.id);
    setRenameDraft(t.title);
  };

  const commitRename = async (id: number) => {
    const title = renameDraft.trim();
    setRenamingId(null);
    if (!title) return;
    const t = await window.spawn.renameThread(id, title);
    setThreads((prev) => prev.map((x) => (x.id === t.id ? t : x)));
  };

  const answerApproval = (allow: boolean) => {
    if (!approval) return;
    window.spawn.resolveApproval(approval.id, allow);
    setApproval(null);
  };

  const openSettings = async () => {
    if (projectId == null) return;
    setSettings(await window.spawn.getProjectSettings(projectId));
  };

  const patchSettings = async (patch: Partial<ProjectSettings>) => {
    if (projectId == null) return;
    setSettings(await window.spawn.updateProjectSettings(projectId, patch));
  };

  const toggleModel = (m: string) => {
    if (!settings) return;
    const allowed = settings.allowedModels.includes(m)
      ? settings.allowedModels.filter((x) => x !== m)
      : [...settings.allowedModels, m];
    const patch: Partial<ProjectSettings> = { allowedModels: allowed };
    // Don't leave a default pointing at a model this project no longer allows.
    if (settings.defaultModel && !allowed.includes(settings.defaultModel)) {
      patch.defaultModel = "";
    }
    patchSettings(patch);
  };

  const busy = threadId != null && busyThreads.has(threadId);

  const send = async () => {
    const text = draft.trim();
    if (!text || threadId == null || busy) return;
    const id = threadId;
    setDraft("");
    setBusyThreads((prev) => new Set(prev).add(id));
    await window.spawn.sendMessage(id, text);
    // One pull to pick up the persisted user row; streamed rows arrive as events.
    setMessages(await window.spawn.listMessages(id));
  };

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-head">
          <h1>Spawn</h1>
          <button
            className="gear"
            title="Project settings"
            onClick={openSettings}
            disabled={projectId == null}
          >
            ⚙
          </button>
        </div>
        {projects.map((p) => (
          <button
            key={p.id}
            className={p.id === projectId ? "item active" : "item"}
            onClick={() => setProjectId(p.id)}
            title={p.dir}
          >
            {p.name}
          </button>
        ))}
      </aside>

      <aside className="threads">
        <div className="pane-head">
          <span>Threads</span>
          <button onClick={openThread} disabled={projectId == null}>
            +
          </button>
        </div>
        {threads.map((t) =>
          t.id === renamingId ? (
            <input
              key={t.id}
              className="rename"
              value={renameDraft}
              autoFocus
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename(t.id);
                else if (e.key === "Escape") setRenamingId(null);
              }}
              onBlur={() => setRenamingId(null)}
            />
          ) : (
            <button
              key={t.id}
              className={t.id === threadId ? "item active" : "item"}
              onClick={() => setThreadId(t.id)}
              onDoubleClick={() => startRename(t)}
            >
              <span className={`dot ${t.status}`} />
              {t.title}
            </button>
          )
        )}
      </aside>

      <main className="chat">
        {threadId == null ? (
          <div className="empty">Pick a project, open a thread.</div>
        ) : (
          <>
            <div className="messages">
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  {m.role === "tool" ? (
                    <code>⚙ {m.tool_name}</code>
                  ) : (
                    <pre>{m.text}</pre>
                  )}
                </div>
              ))}
              {busy && <div className="msg system">…working…</div>}
              <div ref={bottomRef} />
            </div>
            <div className="composer">
              <textarea
                value={draft}
                placeholder="Message the agent…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <button onClick={send} disabled={busy || !draft.trim()}>
                Send
              </button>
            </div>
          </>
        )}
      </main>

      {settings && (
        <div className="overlay" onClick={() => setSettings(null)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Project settings</h2>
            <div className="field">
              <label>Approvals</label>
              <div className="segmented">
                {(["prompt", "auto"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={settings.approvalMode === mode ? "on" : ""}
                    onClick={() => patchSettings({ approvalMode: mode })}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Default model</label>
              <select
                value={settings.defaultModel}
                onChange={(e) => patchSettings({ defaultModel: e.target.value })}
              >
                <option value="">harness default</option>
                {settings.allowedModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Allowed models</label>
              <div className="checks">
                {MODELS.map((m) => (
                  <label key={m} className="check">
                    <input
                      type="checkbox"
                      checked={settings.allowedModels.includes(m)}
                      onChange={() => toggleModel(m)}
                    />
                    {m}
                  </label>
                ))}
              </div>
            </div>
            <div className="actions">
              <button onClick={() => setSettings(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {approval && (
        <div className="overlay">
          <div className="card approval">
            <h2>Permission request</h2>
            <p>
              Thread {approval.threadId ?? "?"} wants to run{" "}
              <code>{approval.tool}</code>
            </p>
            <pre>{JSON.stringify(approval.input, null, 2)}</pre>
            <div className="actions">
              <button className="deny" onClick={() => answerApproval(false)}>
                Deny
              </button>
              <button className="allow" onClick={() => answerApproval(true)}>
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
