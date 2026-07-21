import { useEffect, useRef, useState } from "react";
import type { Project, ProjectSettings, Thread, Ticket, TicketStatus } from "./types";
import { useEscapeToClose, useFocusTrap } from "./hooks";
import { MODELS, EFFORTS } from "./constants";

// Ticket sheet (design 3a) — create a backlog ticket, create-and-delegate in
// one move, or edit an existing ticket (title/body/column, delegate, delete).
// The board is the source of truth: everything here is a ticket row first.

const COLUMNS: { key: TicketStatus; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "in-progress", label: "In progress" },
  { key: "blocked", label: "Blocked" },
  { key: "in-review", label: "In review" },
  { key: "done", label: "Done" },
];

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export default function TicketSheet({
  projects,
  initialProjectId,
  ticket = null,
  onClose,
  onDelegated,
}: {
  projects: Project[];
  initialProjectId?: number | null;
  ticket?: Ticket | null; // non-null = edit mode
  onClose: () => void;
  onDelegated: (t: Thread) => void;
}) {
  const editing = ticket != null;
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [body, setBody] = useState(ticket?.body ?? "");
  const [projectId, setProjectId] = useState<number | "">(ticket?.project_id ?? initialProjectId ?? "");
  const [status, setStatus] = useState<TicketStatus>(ticket?.status ?? "todo");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [settings, setSettings] = useState<ProjectSettings | null>(null);
  const [busyAction, setBusyAction] = useState<"" | "create" | "delegate" | "delete">("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (projectId === "") return setSettings(null);
    window.spawn.getProjectSettings(projectId).then(setSettings).catch(() => setSettings(null));
  }, [projectId]);

  useEscapeToClose(onClose);
  const sheetRef = useRef<HTMLDivElement>(null);
  useFocusTrap(sheetRef);

  // Isolation is a project-level setting (the daemon reads it per delegation),
  // so the ticket-sheet toggle flips it on the project — same as SettingsView.
  const toggleIsolation = async () => {
    if (projectId === "" || !settings) return;
    setSettings(await window.spawn.updateProjectSettings(projectId, { isolation: settings.isolation === false }));
  };

  const allowed = settings?.allowedModels ?? MODELS.filter((m) => m !== "fable");
  const branchPreview = title.trim() ? `ticket/<id>-${slugify(title.trim())}` : "ticket/<id>-<slug>";
  const canDelegate = editing ? ticket.thread_id == null : true;

  const save = async (): Promise<Ticket | null> => {
    if (!title.trim() || projectId === "") return null;
    if (editing) {
      return window.spawn.updateTicket(ticket.id, { title: title.trim(), body, status });
    }
    return window.spawn.createTicket({ projectId, title: title.trim(), body, status });
  };

  const create = async () => {
    setBusyAction("create");
    setError("");
    try {
      if (await save()) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction("");
    }
  };

  const delegate = async () => {
    setBusyAction("delegate");
    setError("");
    try {
      const saved = await save();
      if (!saved) return;
      const thread = await window.spawn.delegateTicket(saved.id, {
        model: model || undefined,
        effort: effort || undefined,
      });
      onDelegated(thread);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction("");
    }
  };

  const remove = async () => {
    if (!editing) return;
    setBusyAction("delete");
    setError("");
    try {
      await window.spawn.deleteTicket(ticket.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction("");
    }
  };

  return (
    // pointerdown, not click: a text-selection drag released over the
    // backdrop must not destroy the form.
    <div className="overlay center" onPointerDown={onClose}>
      <div
        className="sheet"
        ref={sheetRef}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // The buttons advertise ↵ — honor ⌘/Ctrl+Enter anywhere in the sheet.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            if (canDelegate) delegate();
            else create();
          }
        }}
      >
        <div className="s-head">
          <i className={`ph ${editing ? "ph-pencil-simple" : "ph-plus-circle"}`} />
          {editing ? `Ticket #${ticket.id}` : "New ticket"}
          <button className="x" onClick={onClose}>
            <i className="ph ph-x" />
          </button>
        </div>
        <input
          className="f-static"
          style={{ fontSize: 14, fontWeight: 500 }}
          autoFocus={!editing}
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <textarea
          className="task"
          value={body}
          placeholder="Describe the task — the agent reads this verbatim when delegated. Paste logs, link files, reference PRs…"
          onChange={(e) => setBody(e.target.value)}
        />
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <div className="f-label">Project</div>
            <select
              className="f-select"
              disabled={editing}
              value={projectId === "" ? "" : String(projectId)}
              onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">pick a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <div className="f-label">Column</div>
            <select
              className="f-select"
              value={status}
              onChange={(e) => setStatus(e.target.value as TicketStatus)}
            >
              {COLUMNS.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {canDelegate && (
          <>
            <div>
              <div className="f-label">
                Model <span style={{ color: "var(--color-neutral-600)" }}>(auto = the team lead right-sizes)</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span
                  className={`tag pick ${model === "" ? "tag-accent" : "tag-neutral"}`}
                  onClick={() => setModel("")}
                >
                  auto
                </span>
                {MODELS.map((m) => (
                  <span
                    key={m}
                    className={`tag pick ${model === m ? "tag-accent" : "tag-neutral"}`}
                    style={allowed.includes(m) ? undefined : { opacity: 0.4 }}
                    onClick={() => setModel(model === m ? "" : m)}
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="f-label">Effort</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <span
                  className={`tag pick ${effort === "" ? "tag-accent" : "tag-neutral"}`}
                  onClick={() => setEffort("")}
                >
                  auto
                </span>
                {EFFORTS.map((x) => (
                  <span
                    key={x}
                    className={`tag pick ${effort === x ? "tag-accent" : "tag-neutral"}`}
                    onClick={() => setEffort(effort === x ? "" : x)}
                  >
                    {x}
                  </span>
                ))}
              </div>
            </div>
            <div className="toggle-row" style={{ marginTop: 0 }}>
              <button
                type="button"
                className={`toggle ${settings?.isolation !== false ? "on" : ""}`}
                disabled={!settings}
                onClick={toggleIsolation}
              />
              <span>{settings?.isolation !== false ? "Isolated in a worktree" : "Isolation off for this project"}</span>
              <span className="hint mono">{settings?.isolation !== false ? branchPreview : ""}</span>
            </div>
          </>
        )}
        {error && (
          <div className="err-c" style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
            <i className="ph ph-warning-circle" />
            {error}
          </div>
        )}
        <div className="s-foot">
          {editing && (
            <button className="btn btn-ghost small-btn err-c" disabled={busyAction !== ""} onClick={remove}>
              Delete
            </button>
          )}
          {canDelegate && (
            <span style={{ fontSize: 11, color: "var(--color-neutral-500)" }}>
              {model || settings?.defaultModel || "auto"} · {effort || settings?.defaultEffort || "auto"}
            </span>
          )}
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
            <button
              className="btn btn-ghost small-btn"
              style={{ padding: "5px 14px", fontSize: 12 }}
              disabled={!title.trim() || projectId === "" || busyAction !== ""}
              onClick={create}
            >
              {editing ? "Save" : "Create"}
            </button>
            {canDelegate && (
              <button
                className="btn btn-primary small-btn"
                style={{ padding: "5px 14px", fontSize: 12 }}
                disabled={!title.trim() || projectId === "" || busyAction !== ""}
                onClick={delegate}
              >
                {busyAction === "delegate" ? (
                <>
                  <i className="ph ph-circle-notch spin" /> Delegating…
                </>
              ) : editing ? (
                "Delegate ⌘↵"
              ) : (
                "Create & delegate ⌘↵"
              )}
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
