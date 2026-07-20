import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, TicketDetail, TicketStatus } from "./types";

// Ticket detail modal (opened by clicking any card on the Orchestrate board).
// Shows title + description (editable), the comment thread, and attachments.
// A human comment is posted via addTicketComment, which wakes the team lead —
// it reads the ticket and delegates / steers / replies, commenting back here.
// Both the lead and the working agent can also upload attachments.

const STATUSES: { key: TicketStatus; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "in-progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "in-review", label: "In review" },
  { key: "done", label: "Done" },
];
const EFFORTS = ["low", "medium", "high"];
const MODELS = ["haiku", "sonnet", "opus", "fable"];

const AUTHOR_LABEL: Record<string, string> = { human: "you", lead: "team lead", agent: "agent" };

const fmtTime = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const fmtSize = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`;

export default function TicketModal({
  ticketId,
  projects: _projects,
  onOpenThread,
  onClose,
  onChanged,
}: {
  ticketId: number;
  projects: Project[];
  onOpenThread: (projectId: number, threadId: number) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [t, setT] = useState<TicketDetail | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [comment, setComment] = useState("");
  const [posting, setPosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const commentsEnd = useRef<HTMLDivElement | null>(null);

  // Refresh the ticket (comments/attachments/status) without clobbering any
  // in-progress edits to the title/body drafts.
  const load = useCallback(() => {
    window.spawn
      .getTicket(ticketId)
      .then(setT)
      .catch(() => {});
  }, [ticketId]);

  // First load: seed the editable fields from the fetched ticket.
  useEffect(() => {
    window.spawn
      .getTicket(ticketId)
      .then((d) => {
        setT(d);
        setTitle(d.title);
        setBody(d.body);
      })
      .catch(() => {});
  }, [ticketId]);

  // Live: any comment/attachment/status change on THIS ticket re-fetches.
  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (
        ((ev.type === "ticket:comment" || ev.type === "ticket:attachment") && ev.payload.ticketId === ticketId) ||
        (ev.type === "ticket:updated" && ev.payload.id === ticketId) ||
        ev.type === "turn:start" ||
        ev.type === "turn:done"
      ) {
        load();
      }
    });
  }, [ticketId, load]);

  useEffect(() => {
    commentsEnd.current?.scrollIntoView({ block: "end" });
  }, [t?.comments.length]);

  if (!t) return null;

  const backlog = t.thread_id == null;

  const saveField = async (patch: { title?: string; body?: string; status?: TicketStatus }) => {
    await window.spawn.updateTicket(ticketId, patch);
    onChanged();
    load();
  };

  const post = async () => {
    const text = comment.trim();
    if (!text || posting) return;
    setPosting(true);
    try {
      await window.spawn.addTicketComment(ticketId, text);
      setComment("");
      load();
    } finally {
      setPosting(false);
    }
  };

  const attach = async () => {
    const path = await window.spawn.pickFile();
    if (!path) return;
    await window.spawn.addTicketAttachment(ticketId, path);
    load();
  };

  const delegate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await window.spawn.delegateTicket(ticketId, {
        model: model || undefined,
        effort: effort || undefined,
      });
      onChanged();
      load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await window.spawn.deleteTicket(ticketId);
      onChanged();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const cycle = (list: string[], cur: string, set: (v: string) => void) => {
    const i = list.indexOf(cur);
    set(i === list.length - 1 ? "" : list[i + 1] ?? list[0]);
  };

  return (
    <div className="overlay center" onClick={onClose}>
      <div className="sheet tk-modal" onClick={(e) => e.stopPropagation()}>
        <div className="s-head">
          <span className="mono" style={{ fontSize: 11.5, color: "var(--color-neutral-600)" }}>
            SPWN-{t.id}
          </span>
          <span className="tag tag-neutral" style={{ fontSize: 10.5 }}>
            {t.project_name}
          </span>
          <span className={`tag col-pill ${t.status}`} style={{ fontSize: 10.5 }}>
            {STATUSES.find((s) => s.key === t.status)?.label ?? t.status}
          </span>
          <span className="spacer" style={{ marginLeft: "auto" }} />
          {t.thread_id != null && (
            <button className="btn small-btn" onClick={() => onOpenThread(t.project_id, t.thread_id!)}>
              <i className="ph ph-arrow-square-out" /> Open thread
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="Close">
            <i className="ph ph-x" />
          </button>
        </div>

        <div className="tk-body">
          <input
            className="f-static tk-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== t.title && saveField({ title: title.trim() })}
            placeholder="Ticket title"
          />
          <textarea
            className="task tk-desc"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => body !== t.body && saveField({ body })}
            placeholder="Describe the work…"
          />

          <div className="tk-controls">
            <select
              className="f-select"
              style={{ width: "auto", padding: "4px 8px", fontSize: 11.5 }}
              value={t.status}
              onChange={(e) => saveField({ status: e.target.value as TicketStatus })}
            >
              {STATUSES.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            {backlog && (
              <>
                <span
                  className={`tag pick ${model ? "tag-accent" : "tag-outline"}`}
                  onClick={() => cycle(MODELS, model, setModel)}
                  title="Click to cycle models"
                >
                  <i className="ph ph-brain" style={{ marginRight: 4 }} />
                  {model || "model"}
                </span>
                <span
                  className={`tag pick ${effort ? "tag-accent" : "tag-outline"}`}
                  onClick={() => cycle(EFFORTS, effort, setEffort)}
                  title="Click to cycle efforts"
                >
                  <i className="ph ph-gauge" style={{ marginRight: 4 }} />
                  {effort || "effort"}
                </span>
                <button className="btn btn-primary small-btn" disabled={busy} onClick={delegate}>
                  <i className="ph ph-paper-plane-tilt" /> Delegate
                </button>
              </>
            )}
          </div>

          {/* Attachments */}
          <div className="tk-sect">
            <span>Attachments</span>
            <span className="line" />
            <button className="btn small-btn" onClick={attach}>
              <i className="ph ph-paperclip" /> Add file
            </button>
          </div>
          {t.attachments.length === 0 ? (
            <div className="tk-empty">No files yet.</div>
          ) : (
            <div className="tk-files">
              {t.attachments.map((a) => (
                <button key={a.id} className="tk-file" onClick={() => window.spawn.revealFile(a.path)}>
                  <i className="ph ph-file" />
                  <span className="nm">{a.name}</span>
                  <span className="mt">
                    {fmtSize(a.size)} · {a.uploaded_by || "?"}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Comments */}
          <div className="tk-sect">
            <span>Comments</span>
            <span className="line" />
          </div>
          <div className="tk-comments">
            {t.comments.length === 0 && <div className="tk-empty">No comments yet.</div>}
            {t.comments.map((c) => (
              <div key={c.id} className={`tk-c ${c.author_kind}`}>
                <div className="tk-c-head">
                  <span className={`tk-who ${c.author_kind}`}>{AUTHOR_LABEL[c.author_kind] ?? c.author_kind}</span>
                  <span className="tk-when">{fmtTime(c.created_at)}</span>
                </div>
                <div className="tk-c-body">{c.body}</div>
              </div>
            ))}
            <div ref={commentsEnd} />
          </div>
        </div>

        <div className="s-foot tk-compose">
          <textarea
            className="task"
            value={comment}
            placeholder="Comment… (the team lead is notified and will act on it)"
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                post();
              }
            }}
          />
          <div className="tk-compose-foot">
            <button className="btn danger small-btn" onClick={remove} disabled={busy}>
              <i className="ph ph-trash" /> Delete
            </button>
            <span style={{ marginLeft: "auto" }} />
            <button className="btn btn-primary small-btn" onClick={post} disabled={!comment.trim() || posting}>
              {posting ? "…" : "Comment ↵"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
