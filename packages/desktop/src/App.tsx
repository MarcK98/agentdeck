import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActiveThread,
  ApprovalRequest,
  Board,
  Message,
  Project,
  ProjectSettings,
  Thread,
} from "./types";

// Spawn shell — Discord-shaped: projects rail / threads / active thread.
// Phase 2 adds the team-lead workspace: a read-only board (Trello or
// TASKS.md), a team-lead console (a normal chat thread), and a delegate
// panel that fans ticket threads out across projects.

// The full model menu; a project opts in per-model (fable is opt-in only).
const MODELS = ["haiku", "sonnet", "opus", "fable"];
// Delegate right-sizing knobs — the same options the bridge's delegate tool takes.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// ── ChatThread — message list + composer + streaming for ONE thread. Used by
// the project chat and the team-lead console alike, so the stream handling
// lives once. Busy state stays in App (per-thread, survives switching views).
function ChatThread({
  threadId,
  busy,
  markBusy,
}: {
  threadId: number;
  busy: boolean;
  markBusy: (threadId: number) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    window.spawn.listMessages(threadId).then(setMessages);
  }, [threadId]);

  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (ev.type !== "turn:text" && ev.type !== "turn:tool") return;
      if (ev.payload.threadId !== threadId) return;
      // The event ships the persisted row — append it; dedupe by id in case
      // of a double-deliver.
      const msg = ev.payload.message;
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    });
  }, [threadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    markBusy(threadId);
    await window.spawn.sendMessage(threadId, text);
    // One pull to pick up the persisted user row; streamed rows arrive as events.
    setMessages(await window.spawn.listMessages(threadId));
  };

  return (
    <>
      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "tool" ? <code>⚙ {m.tool_name}</code> : <pre>{m.text}</pre>}
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
  );
}

// ── BoardView — the team-lead board, read-only (no drag, no edit). Trello
// columns when wired, TASKS.md verbatim as the fallback, a hint otherwise.
function BoardView() {
  const [board, setBoard] = useState<Board | null>(null);

  const refresh = useCallback(() => {
    window.spawn.getBoard().then(setBoard);
  }, []);
  useEffect(refresh, [refresh]);

  return (
    <section className="board">
      <div className="pane-head">
        <span>Board</span>
        <button title="Refresh board" onClick={refresh}>
          ↻
        </button>
      </div>
      {!board ? (
        <div className="empty">Loading board…</div>
      ) : board.source === "trello" ? (
        <div className="board-columns">
          {board.columns.map((col) => (
            <div key={col.status} className="board-col">
              <h3>{col.status}</h3>
              {col.cards.map((c) => (
                <div key={c.ref} className="board-card">
                  <span className={`dot ${col.status}`} />
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.title}
                    </a>
                  ) : (
                    <span>{c.title}</span>
                  )}
                  {(c.key || c.ref) && <span className="badge">{c.key ?? c.ref}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : board.source === "tasks-md" ? (
        <pre className="board-tasks">{board.text}</pre>
      ) : (
        <div className="empty">No board — enable Trello or add a TASKS.md to the team-lead project.</div>
      )}
    </section>
  );
}

// ── TeamLeadWorkspace — board + team-lead console + delegate/active panel.
function TeamLeadWorkspace({
  projects,
  busyThreads,
  markBusy,
  refreshTick,
}: {
  projects: Project[];
  busyThreads: Set<number>;
  markBusy: (threadId: number) => void;
  refreshTick: number;
}) {
  // undefined = still resolving; null = TEAMLEAD_CHANNEL unset/unresolvable.
  const [tlProject, setTlProject] = useState<Project | null | undefined>(undefined);
  const [consoleThreadId, setConsoleThreadId] = useState<number | null>(null);
  // What the console area currently shows: the team-lead thread, or a ticket
  // thread opened from the delegate form / active list.
  const [openThreadId, setOpenThreadId] = useState<number | null>(null);
  const [openTitle, setOpenTitle] = useState("Team-lead console");
  const [active, setActive] = useState<ActiveThread[]>([]);
  // Delegate form.
  const [target, setTarget] = useState<number | "">("");
  const [task, setTask] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");

  useEffect(() => {
    let stale = false;
    window.spawn.getTeamLeadProject().then(async (p) => {
      if (stale) return;
      setTlProject(p);
      if (!p) return;
      // The console is the project's teamlead-kind thread — create-or-open.
      const threads = await window.spawn.listThreads(p.id);
      const existing = threads.find((t) => t.kind === "teamlead");
      const t =
        existing ??
        (await window.spawn.createThread({ projectId: p.id, title: "Team-lead console", kind: "teamlead" }));
      if (stale) return;
      setConsoleThreadId(t.id);
      setOpenThreadId((cur) => cur ?? t.id);
    });
    return () => {
      stale = true;
    };
  }, []);

  // Live list of active threads; refreshTick bumps on thread:created /
  // thread:updated / turn:done, so the panel tracks the daemon.
  useEffect(() => {
    window.spawn.listActiveThreads().then(setActive);
  }, [refreshTick]);

  const openThread = (id: number, title: string) => {
    setOpenThreadId(id);
    setOpenTitle(id === consoleThreadId ? "Team-lead console" : title);
  };

  const delegate = async () => {
    const text = task.trim();
    if (!text || target === "") return;
    setTask("");
    const t = await window.spawn.delegateTask({
      projectId: target,
      task: text,
      model: model || undefined,
      effort: effort || undefined,
    });
    markBusy(t.id);
    openThread(t.id, t.title);
    setActive(await window.spawn.listActiveThreads());
  };

  return (
    <main className="workspace">
      <BoardView />

      <section className="console">
        <div className="pane-head">
          <span>{openTitle}</span>
          {openThreadId !== consoleThreadId && consoleThreadId != null && (
            <button onClick={() => openThread(consoleThreadId, "Team-lead console")}>
              ← console
            </button>
          )}
        </div>
        {tlProject === undefined ? (
          <div className="empty">Loading…</div>
        ) : tlProject === null ? (
          <div className="empty">Set TEAMLEAD_CHANNEL to enable the team-lead workspace.</div>
        ) : openThreadId == null ? (
          <div className="empty">Opening the console…</div>
        ) : (
          <ChatThread
            threadId={openThreadId}
            busy={busyThreads.has(openThreadId)}
            markBusy={markBusy}
          />
        )}
      </section>

      <aside className="side">
        <div className="pane-head">
          <span>Delegate</span>
        </div>
        <div className="delegate">
          <select
            value={target === "" ? "" : String(target)}
            onChange={(e) => setTarget(e.target.value ? Number(e.target.value) : "")}
          >
            <option value="">project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <textarea
            value={task}
            placeholder="Task for the delegate…"
            onChange={(e) => setTask(e.target.value)}
          />
          <div className="delegate-knobs">
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">model</option>
              {MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <select value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">effort</option>
              {EFFORTS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
            <button onClick={delegate} disabled={!task.trim() || target === ""}>
              Delegate
            </button>
          </div>
        </div>

        <div className="pane-head">
          <span>Active threads</span>
        </div>
        {active.map((t) => (
          <button
            key={t.id}
            className={t.id === openThreadId ? "item active" : "item"}
            onClick={() => openThread(t.id, t.title)}
            title={`${t.project_name} · ${t.kind}`}
          >
            <span className={`dot ${t.status}`} />
            {t.project_name} · {t.title}
          </button>
        ))}
        {active.length === 0 && <div className="side-empty">Nothing active.</div>}
      </aside>
    </main>
  );
}

export default function App() {
  // "project" = the classic rail/threads/chat; "teamlead" = the workspace.
  const [view, setView] = useState<"project" | "teamlead">("project");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<number | null>(null);
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
  // Bumped on thread lifecycle events so the workspace's lists re-pull.
  const [refreshTick, setRefreshTick] = useState(0);

  const markBusy = useCallback((id: number) => {
    setBusyThreads((prev) => new Set(prev).add(id));
  }, []);

  useEffect(() => {
    window.spawn.listProjects().then(setProjects);
  }, []);

  useEffect(() => {
    if (projectId == null) return;
    window.spawn.listThreads(projectId).then(setThreads);
    setThreadId(null);
    setSettings(null);
  }, [projectId]);

  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (ev.type === "thread:created" || ev.type === "thread:updated" || ev.type === "turn:done") {
        setRefreshTick((n) => n + 1);
      }
      if (ev.type === "thread:created") {
        // A ticket delegated into the open project shows up in its pane too.
        if (ev.payload.project_id === projectId) {
          setThreads((prev) => (prev.some((t) => t.id === ev.payload.id) ? prev : [ev.payload, ...prev]));
        }
        return;
      }
      if (ev.type === "thread:updated") {
        setThreads((prev) => prev.map((t) => (t.id === ev.payload.id ? ev.payload : t)));
        return;
      }
      if (ev.type === "turn:start") {
        setBusyThreads((prev) => new Set(prev).add(ev.payload.threadId));
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
      }
    });
  }, [projectId]);

  const openThread = async () => {
    if (projectId == null) return;
    // Untitled — the daemon defaults it and the first message auto-titles it.
    const t = await window.spawn.createThread({ projectId, title: "" });
    setThreads((prev) => (prev.some((x) => x.id === t.id) ? prev : [t, ...prev]));
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

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-head">
          <h1>Spawn</h1>
          <button
            className="gear"
            title="Project settings"
            onClick={openSettings}
            disabled={projectId == null || view !== "project"}
          >
            ⚙
          </button>
        </div>
        <button
          className={view === "teamlead" ? "item teamlead active" : "item teamlead"}
          onClick={() => setView("teamlead")}
        >
          🧭 Team Lead
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            className={view === "project" && p.id === projectId ? "item active" : "item"}
            onClick={() => {
              setProjectId(p.id);
              setView("project");
            }}
            title={p.dir}
          >
            {p.name}
          </button>
        ))}
      </aside>

      {view === "teamlead" ? (
        <TeamLeadWorkspace
          projects={projects}
          busyThreads={busyThreads}
          markBusy={markBusy}
          refreshTick={refreshTick}
        />
      ) : (
        <>
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
              <ChatThread threadId={threadId} busy={busyThreads.has(threadId)} markBusy={markBusy} />
            )}
          </main>
        </>
      )}

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
