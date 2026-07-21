import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, ProjectSettings, TicketDetail, TicketStatus } from "./types";
import { useEscapeToClose, useFocusTrap } from "./hooks";
import { MODELS, EFFORTS } from "./constants";

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

const AUTHOR_LABEL: Record<string, string> = { human: "you", lead: "team lead", agent: "agent" };
const AVATAR_ICON: Record<string, string> = { human: "ph-user", lead: "ph-crown-simple", agent: "ph-robot" };

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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const commentsEnd = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, !confirmingDelete);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(confirmRef, confirmingDelete);

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

  // Project's allowed-models gating (same source SettingsView/TicketSheet
  // read) — dims/skips models the project has switched off.
  useEffect(() => {
    if (t == null) return;
    window.spawn.getProjectSettings(t.project_id).then(setSettings).catch(() => setSettings(null));
  }, [t?.project_id]);

  // Live: any comment/attachment/status change on THIS ticket re-fetches.
  // Turn events refetch only when they belong to this ticket's thread —
  // unrelated runs shouldn't hammer getTicket.
  const threadIdRef = useRef<number | null>(null);
  threadIdRef.current = t?.thread_id ?? null;
  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (
        ((ev.type === "ticket:comment" || ev.type === "ticket:attachment") && ev.payload.ticketId === ticketId) ||
        (ev.type === "ticket:updated" && ev.payload.id === ticketId) ||
        ((ev.type === "turn:start" || ev.type === "turn:done") &&
          threadIdRef.current != null &&
          ev.payload.threadId === threadIdRef.current)
      ) {
        load();
      }
    });
  }, [ticketId, load]);

  useEscapeToClose(onClose, confirmingDelete === false);
  useEscapeToClose(() => setConfirmingDelete(false), confirmingDelete);

  // Follow new comments only while the reader is already near the bottom.
  const commentsBox = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = commentsBox.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) commentsEnd.current?.scrollIntoView({ block: "end" });
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
    setConfirmingDelete(false);
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

  // Same gating signal TicketSheet shows — the daemon is the real enforcer,
  // this just warns before a delegate call gets rejected server-side.
  const allowedModels = settings?.allowedModels ?? MODELS.filter((m) => m !== "fable");
  const modelNotAllowed = model !== "" && !allowedModels.includes(model);

  return (
    <div className="overlay center" onPointerDown={onClose}>
      <div className="sheet tk-modal" ref={modalRef} onPointerDown={(e) => e.stopPropagation()}>
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
            <button className="btn btn-secondary small-btn" onClick={() => onOpenThread(t.project_id, t.thread_id!)}>
              <i className="ph ph-arrow-square-out" /> Open thread
            </button>
          )}
          <button className="icon-btn" onClick={onClose} title="Close">
            <i className="ph ph-x" />
          </button>
        </div>

        <div className="tk-cols">
          {/* LEFT PANE — title, description, controls, attachments */}
          <div className="tk-main">
            <input
              className="f-static tk-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title !== t.title && saveField({ title: title.trim() })}
              placeholder="Ticket title"
            />

            <div className="tk-block">
              <div className="tk-sect">
                <i className="ph ph-text-align-left" />
                <span className="tk-sect-label">Description</span>
                <span className="line" />
              </div>
              <textarea
                className="task tk-desc"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onBlur={() => body !== t.body && saveField({ body })}
                placeholder="Describe the work…"
              />
            </div>

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
                    style={modelNotAllowed ? { opacity: 0.55 } : undefined}
                    onClick={() => cycle(MODELS, model, setModel)}
                    title={modelNotAllowed ? "Not enabled for this project — Settings → Behavior" : "Click to cycle models"}
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
                    <i className={`ph ${busy ? "ph-circle-notch spin" : "ph-paper-plane-tilt"}`} /> Delegate
                  </button>
                </>
              )}
            </div>

            {/* Attachments — anchored at the bottom of the card, Trello-style */}
            <div className="tk-block">
              <div className="tk-sect">
                <i className="ph ph-paperclip" />
                <span className="tk-sect-label">Attachments</span>
                <span className="line" />
                <button className="btn btn-ghost small-btn" onClick={attach}>
                  <i className="ph ph-plus" /> Add
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
            </div>

            <span className="tk-spring" />
            <button className="tk-delete" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              <i className="ph ph-trash" /> Delete ticket
            </button>
          </div>

          {/* RIGHT PANE — comments thread + compose */}
          <div className="tk-side">
            <div className="tk-side-head">
              <i className="ph ph-chat-teardrop-text" />
              <span className="tk-sect-label">Comments</span>
              {t.comments.length > 0 && <span className="tk-count">{t.comments.length}</span>}
            </div>
            <div className="tk-comments" ref={commentsBox}>
              {t.comments.length === 0 && <div className="tk-empty">No comments yet.</div>}
              {t.comments.map((c) => (
                <div key={c.id} className={`tk-c ${c.author_kind}`}>
                  <span className={`tk-avatar ${c.author_kind}`}>
                    <i className={`ph ${AVATAR_ICON[c.author_kind] ?? "ph-user"}`} />
                  </span>
                  <div className="tk-c-main">
                    <div className="tk-c-head">
                      <span className={`tk-who ${c.author_kind}`}>
                        {AUTHOR_LABEL[c.author_kind] ?? c.author_kind}
                      </span>
                      <span className="tk-when">{fmtTime(c.created_at)}</span>
                    </div>
                    <div className="tk-c-body">{c.body}</div>
                  </div>
                </div>
              ))}
              <div ref={commentsEnd} />
            </div>
            <div className="tk-compose">
              <textarea
                className="task"
                value={comment}
                placeholder="Write a comment… (the team lead is notified and will act on it)"
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    post();
                  }
                }}
              />
              <button
                className="btn btn-primary small-btn"
                style={{ alignSelf: "flex-end" }}
                onClick={post}
                disabled={!comment.trim() || posting}
              >
                {posting ? <i className="ph ph-circle-notch spin" /> : "Comment ⌘↵"}
              </button>
            </div>
          </div>
        </div>

        {confirmingDelete && (
          <div className="overlay center" onPointerDown={() => setConfirmingDelete(false)}>
            <div className="sheet" ref={confirmRef} style={{ width: 400 }} onPointerDown={(e) => e.stopPropagation()}>
              <div className="s-head">
                <i className="ph ph-trash" style={{ color: "oklch(0.72 0.15 25)" }} />
                Delete ticket
              </div>
              <p style={{ fontSize: 13, color: "var(--color-neutral-300)", lineHeight: 1.5, margin: 0 }}>
                Delete <strong>SPWN-{t.id}</strong> and its comments? This can't be undone.
              </p>
              <div className="s-foot" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-secondary" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
                <button className="btn danger" onClick={remove}>
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
