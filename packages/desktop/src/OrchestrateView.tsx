import { useCallback, useEffect, useState } from "react";
import type { ActiveThread, Board, Project, Thread, UsageSummary } from "./types";
import DelegateSheet from "./DelegateSheet";

// Orchestrate — Mission Control's home (design 1a): the board as a kanban,
// live Spawn runs pinned at the top of "in progress" (board cards are
// Trello-owned and read-only during the bridge migration; Spawn's own live
// tickets are a second, authoritative source and render as live cards), and
// the delegate dock on the right with active runs + today's burn.

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = ["haiku", "sonnet", "opus", "fable"];

function LiveTicketCard({ t, onOpen }: { t: ActiveThread; onOpen: () => void }) {
  return (
    <div className={`bcard ${t.running ? "live" : "paused"}`} onClick={onOpen}>
      <div className="title">
        {t.running ? <span className="dot-live pulse" /> : <span className="dot-idle" />}
        {t.title}
      </div>
      <div className="tags">
        <span className="tag tag-neutral" style={{ fontSize: 10.5 }}>
          {t.project_name}
        </span>
        {t.branch && (
          <span className="tag tag-outline" style={{ fontSize: 10.5, gap: 4 }}>
            <i className="ph ph-git-branch" />
            {t.branch.replace(/^ticket\//, "")}
          </span>
        )}
      </div>
      <div className="foot">
        <span>{t.kind}</span>
        <span style={{ marginLeft: "auto" }} className={t.running ? "ok-c" : ""}>
          {t.running ? "running…" : "idle"}
        </span>
      </div>
    </div>
  );
}

export default function OrchestrateView({
  projects,
  active,
  usage,
  onOpenThread,
  markBusy,
}: {
  projects: Project[];
  active: ActiveThread[];
  usage: UsageSummary | null;
  onOpenThread: (projectId: number, threadId: number) => void;
  markBusy: (threadId: number) => void;
}) {
  const [board, setBoard] = useState<Board | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Delegate dock state.
  const [task, setTask] = useState("");
  const [target, setTarget] = useState<number | "">("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [sending, setSending] = useState(false);

  const refreshBoard = useCallback(() => {
    window.spawn.getBoard().then(setBoard);
  }, []);
  useEffect(refreshBoard, [refreshBoard]);

  const liveTickets = active.filter((t) => t.kind === "ticket");

  const delegate = async () => {
    const text = task.trim();
    if (!text || target === "" || sending) return;
    setSending(true);
    try {
      const t = await window.spawn.delegateTask({
        projectId: target,
        task: text,
        model: model || undefined,
        effort: effort || undefined,
      });
      setTask("");
      markBusy(t.id);
      onOpenThread(t.project_id, t.id);
    } finally {
      setSending(false);
    }
  };

  const onDelegated = (t: Thread) => {
    markBusy(t.id);
    onOpenThread(t.project_id, t.id);
  };

  const cycle = (list: string[], cur: string, set: (v: string) => void) => {
    const i = list.indexOf(cur);
    set(i === list.length - 1 ? "" : list[i + 1] ?? list[0]);
  };

  return (
    <div className="orchestrate">
      <div className="board-wrap">
        <div className="view-head" style={{ padding: 0 }}>
          <h4>Board</h4>
          <span className="sub">
            {board?.source === "trello"
              ? "Trello · read-only while the bridge owns sync"
              : board?.source === "tasks-md"
                ? "TASKS.md"
                : board
                  ? "no board configured"
                  : "loading…"}
          </span>
          <span className="spacer" />
          <button className="btn btn-secondary small-btn" onClick={refreshBoard}>
            <i className="ph ph-arrows-clockwise" /> Refresh
          </button>
        </div>

        {board?.source === "trello" ? (
          <div className="board-cols">
            {board.columns.map((col) => (
              <div key={col.status} className="board-col">
                <div className={`col-head ${col.status}`}>
                  {col.status.replace("-", " ")}
                  <span className="n">
                    {col.cards.length + (col.status === "in-progress" ? liveTickets.length : 0)}
                  </span>
                </div>
                {col.status === "in-progress" &&
                  liveTickets.map((t) => (
                    <LiveTicketCard key={t.id} t={t} onOpen={() => onOpenThread(t.project_id, t.id)} />
                  ))}
                {col.cards.map((c) => (
                  <div key={c.ref} className="bcard">
                    <div className="title">
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noreferrer">
                          {c.title}
                        </a>
                      ) : (
                        c.title
                      )}
                    </div>
                    <div className="tags">
                      {(c.key || c.ref) && (
                        <span className="mono" style={{ fontSize: 10.5, color: "var(--color-neutral-500)" }}>
                          {c.key ?? c.ref}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {col.status === "todo" && (
                  <button className="ghost-card" onClick={() => setSheetOpen(true)}>
                    <i className="ph ph-plus" /> New ticket
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : board?.source === "tasks-md" ? (
          <>
            {liveTickets.length > 0 && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {liveTickets.map((t) => (
                  <div key={t.id} style={{ width: 260 }}>
                    <LiveTicketCard t={t} onOpen={() => onOpenThread(t.project_id, t.id)} />
                  </div>
                ))}
              </div>
            )}
            <pre className="board-tasks-md">{board.text}</pre>
          </>
        ) : board ? (
          <div className="empty">No board — enable Trello or add a TASKS.md to the team-lead project.</div>
        ) : (
          <div className="empty">Loading board…</div>
        )}
      </div>

      <aside className="dock fade-l">
        <div className="dock-title">
          <i className="ph ph-paper-plane-tilt" />
          Delegate
          <button
            className="btn btn-ghost small-btn"
            style={{ marginLeft: "auto" }}
            title="Open the full new-ticket sheet (⌘N)"
            onClick={() => setSheetOpen(true)}
          >
            <i className="ph ph-arrows-out-simple" />
          </button>
        </div>
        <div className="delegate-box">
          <textarea
            value={task}
            placeholder="Describe a task — pick a project, Spawn does the rest…"
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                delegate();
              }
            }}
          />
          <div className="knobs">
            <select
              className="f-select"
              style={{ width: "auto", flex: 1, minWidth: 0, padding: "4px 8px", fontSize: 11.5 }}
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
            <span
              className={`tag pick ${model ? "tag-accent" : "tag-outline"}`}
              title="Click to cycle models"
              onClick={() => cycle(MODELS, model, setModel)}
            >
              <i className="ph ph-brain" style={{ marginRight: 4 }} />
              {model || "model"}
            </span>
            <span
              className={`tag pick ${effort ? "tag-accent" : "tag-outline"}`}
              title="Click to cycle efforts"
              onClick={() => cycle(EFFORTS, effort, setEffort)}
            >
              <i className="ph ph-gauge" style={{ marginRight: 4 }} />
              {effort || "effort"}
            </span>
          </div>
          <div className="foot">
            <button
              className="btn btn-primary small-btn"
              style={{ marginLeft: "auto", padding: "5px 16px", fontSize: 12.5 }}
              disabled={!task.trim() || target === "" || sending}
              onClick={delegate}
            >
              {sending ? "…" : "Delegate ↵"}
            </button>
          </div>
        </div>

        <div className="sect" style={{ marginTop: 8 }}>
          <span>Active runs</span>
          <span className="line" />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {active.map((t) => (
            <button key={t.id} className="run-row" onClick={() => onOpenThread(t.project_id, t.id)}>
              {t.running ? <span className="dot-live pulse" /> : <span className="dot-idle" />}
              <span className="body">
                <span className="t">{t.title}</span>
                <span className="m" style={{ display: "block" }}>
                  {t.project_name} · {t.kind}
                </span>
              </span>
              <i className="ph ph-caret-right" style={{ color: "var(--color-neutral-600)" }} />
            </button>
          ))}
          {active.length === 0 && (
            <span style={{ fontSize: 12, color: "var(--color-neutral-600)", padding: "0 4px" }}>
              Nothing active.
            </span>
          )}
        </div>

        <div className="today-box">
          <div className="line1">
            <span className="lbl">Today</span>
            <span className="big">{usage ? `${(usage.totalTokens / 1e6).toFixed(2)}M tok` : "—"}</span>
            <span className="lbl" style={{ marginLeft: "auto" }}>
              {usage ? `${usage.turns} turns` : ""}
            </span>
          </div>
          {usage && usage.series.length > 1 && (
            <svg width="100%" height="34" viewBox="0 0 280 34" preserveAspectRatio="none" style={{ marginTop: 6 }}>
              <polyline
                points={usage.series
                  .map((p, i) => {
                    const max = Math.max(...usage.series.map((s) => s.tokens), 1);
                    const x = (i / (usage.series.length - 1)) * 280;
                    const y = 32 - (p.tokens / max) * 28;
                    return `${x},${y}`;
                  })
                  .join(" ")}
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="1.5"
                opacity="0.9"
              />
            </svg>
          )}
        </div>
      </aside>

      {sheetOpen && (
        <DelegateSheet
          projects={projects}
          initialProjectId={target === "" ? null : target}
          onClose={() => setSheetOpen(false)}
          onDelegated={onDelegated}
        />
      )}
    </div>
  );
}
