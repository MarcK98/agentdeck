import { useCallback, useEffect, useRef, useState } from "react";
import type { ActiveThread, Project, Thread, Ticket, TicketStatus, UsageSummary } from "./types";
import TicketSheet from "./TicketSheet";
import TicketModal from "./TicketModal";
import { MODELS, EFFORTS } from "./constants";

// Orchestrate — the native board (source of truth: the tickets table). Cards
// are tickets; drag between columns to change status; click to edit a
// backlog ticket or jump into a delegated one's thread. Delegate dock on the
// right, per design 1a.

const COLUMNS: { key: TicketStatus; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "in-progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "in-review", label: "In review" },
  { key: "done", label: "Done" },
];

function TicketCard({
  t,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  t: Ticket;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className={`bcard ${t.running ? "live" : t.status === "blocked" ? "paused" : ""} ${
        t.status === "done" ? "dim" : ""
      }`}
      style={{ cursor: "pointer" }}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      <div className="title">
        {t.running && <span className="dot-live pulse" />}
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
        <span className="mono" style={{ fontSize: 10.5 }}>
          SPWN-{t.id}
        </span>
        <span style={{ marginLeft: "auto" }} className={t.running ? "ok-c" : ""}>
          {t.running ? "running…" : t.thread_id != null ? "" : t.status === "todo" ? "backlog" : "not delegated"}
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
  focusTicketId,
  onFocusHandled,
}: {
  projects: Project[];
  active: ActiveThread[];
  usage: UsageSummary | null;
  onOpenThread: (projectId: number, threadId: number) => void;
  markBusy: (threadId: number) => void;
  // When set (from an OS-notification click), pop this ticket's detail modal
  // open, then call onFocusHandled so the same click doesn't re-fire it.
  focusTicketId?: number | null;
  onFocusHandled?: () => void;
}) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [sheet, setSheet] = useState<{ open: boolean; ticket: Ticket | null }>({ open: false, ticket: null });
  const [modalTicket, setModalTicket] = useState<number | null>(null);
  const dragTicket = useRef<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<TicketStatus | null>(null);
  // Delegate dock state.
  const [task, setTask] = useState("");
  const [target, setTarget] = useState<number | "">("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [sending, setSending] = useState(false);

  const refresh = useCallback(() => {
    window.agentdeck.listTickets().then(setTickets).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  // A notification click asked us to open a specific ticket — do it, then clear
  // the request so it fires exactly once.
  useEffect(() => {
    if (focusTicketId == null) return;
    setModalTicket(focusTicketId);
    onFocusHandled?.();
  }, [focusTicketId, onFocusHandled]);
  useEffect(() => {
    return window.agentdeck.onEvent((ev) => {
      if (
        ev.type === "ticket:created" ||
        ev.type === "ticket:updated" ||
        ev.type === "ticket:deleted" ||
        ev.type === "turn:start" ||
        ev.type === "turn:done"
      ) {
        refresh();
      }
    });
  }, [refresh]);

  const dropOn = async (status: TicketStatus) => {
    setDragOverCol(null);
    const id = dragTicket.current;
    dragTicket.current = null;
    if (id == null) return;
    const t = tickets.find((x) => x.id === id);
    if (!t || t.status === status) return;
    const prevStatus = t.status;
    setTickets((prev) => prev.map((x) => (x.id === id ? { ...x, status } : x)));
    try {
      await window.agentdeck.updateTicket(id, { status });
    } catch {
      // Roll the optimistic move back — the card must not lie about where
      // the daemon thinks it is.
      setTickets((prev) => prev.map((x) => (x.id === id ? { ...x, status: prevStatus } : x)));
    }
  };

  // Clicking any card — backlog or delegated — opens the detail modal
  // (title/description, comments, attachments). Jumping into the run's thread
  // is a button inside the modal.
  const openTicket = (t: Ticket) => setModalTicket(t.id);

  const delegate = async () => {
    const text = task.trim();
    if (!text || target === "" || sending) return;
    setSending(true);
    try {
      const t = await window.agentdeck.delegateTask({
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
    // Stay on the orchestrate board after delegating — mark the ticket busy and
    // let the sheet's onClose refresh the board. (Don't route to the thread view.)
    markBusy(t.id);
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
          <span className="sub">source of truth — drag cards to move, click to open</span>
          <span className="spacer" />
          <button
            className="btn btn-primary small-btn"
            onClick={() => setSheet({ open: true, ticket: null })}
          >
            <i className="ph ph-plus" /> New ticket
          </button>
        </div>

        <div className="board-cols">
          {COLUMNS.map((col) => {
            const colTickets = tickets.filter((t) => t.status === col.key);
            return (
              <div
                key={col.key}
                className={`board-col ${dragOverCol === col.key ? "drop-target" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverCol(col.key);
                }}
                onDragLeave={() => setDragOverCol((c) => (c === col.key ? null : c))}
                onDrop={() => dropOn(col.key)}
              >
                <div className={`col-head ${col.key}`}>
                  {col.label}
                  <span className="n">{colTickets.length}</span>
                </div>
                {colTickets.map((t) => (
                  <TicketCard
                    key={t.id}
                    t={t}
                    onOpen={() => openTicket(t)}
                    onDragStart={() => {
                      dragTicket.current = t.id;
                    }}
                    onDragEnd={() => {
                      // Dropped outside any column — clear the highlight.
                      dragTicket.current = null;
                      setDragOverCol(null);
                    }}
                  />
                ))}
                {col.key === "todo" && (
                  <button className="ghost-card" onClick={() => setSheet({ open: true, ticket: null })}>
                    <i className="ph ph-plus" /> New ticket
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <aside className="dock fade-l">
        <div className="dock-title">
          <i className="ph ph-paper-plane-tilt" />
          Delegate
        </div>
        <div className="delegate-box">
          <textarea
            value={task}
            placeholder="Describe a task — it lands on the board and runs immediately…"
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
              {sending ? (
                <>
                  <i className="ph ph-circle-notch spin" /> Delegating…
                </>
              ) : (
                "Delegate ⌘↵"
              )}
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
                  {t.running && t.liveTokens != null && t.liveTokens > 0 && (
                    <span className="ok-c">
                      {" "}
                      · {t.liveTokens >= 1e6
                        ? `${(t.liveTokens / 1e6).toFixed(1)}M`
                        : `${Math.round(t.liveTokens / 1e3)}k`}{" "}
                      tok
                    </span>
                  )}
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

      {sheet.open && (
        <TicketSheet
          projects={projects}
          initialProjectId={target === "" ? null : target}
          ticket={sheet.ticket}
          onClose={() => {
            setSheet({ open: false, ticket: null });
            refresh();
          }}
          onDelegated={onDelegated}
        />
      )}

      {modalTicket != null && (
        <TicketModal
          ticketId={modalTicket}
          projects={projects}
          onOpenThread={(pid, tid) => {
            setModalTicket(null);
            onOpenThread(pid, tid);
          }}
          onClose={() => {
            setModalTicket(null);
            refresh();
          }}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
