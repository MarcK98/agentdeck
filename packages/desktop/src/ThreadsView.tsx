import { useEffect, useRef, useState } from "react";
import type { Project, Thread } from "./types";
import ChatThread from "./ChatThread";
import ContextRail from "./ContextRail";
import ContextMenu, { type MenuEntry } from "./ContextMenu";

// Threads — thread list for the selected project (project picked in the side
// nav), chat center, context rail right. The team-lead console is the pinned
// first entry when the selected project IS the team-lead's home (kind
// teamlead, create-or-open, same contract as the old workspace).
//
// Right-clicking a thread opens a manage menu (rename, status, session reset,
// worktree, delete) — see the ContextMenu wiring below.

export default function ThreadsView({
  projectId,
  projects,
  threadId,
  setThreadId,
  busyThreads,
  markBusy,
  teamLeadProjectId,
  refreshTick,
}: {
  projectId: number | null;
  projects: Project[];
  threadId: number | null;
  setThreadId: (id: number | null) => void;
  busyThreads: Set<number>;
  markBusy: (id: number) => void;
  teamLeadProjectId: number | null;
  refreshTick: number;
}) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const project = projects.find((p) => p.id === projectId) ?? null;
  const isTeamLeadProject = projectId != null && projectId === teamLeadProjectId;

  // Right-click menu target + position; inline-rename state; a transient note
  // banner (worktree copied, reset done, why a delete/cleanup was refused).
  const [menu, setMenu] = useState<{ x: number; y: number; thread: Thread } | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Thread | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  const flash = (msg: string) => {
    setNote(msg);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), 3500);
  };

  useEffect(() => {
    if (projectId == null) return setThreads([]);
    let stale = false;
    (async () => {
      let list = await window.spawn.listThreads(projectId);
      // Team-lead home: make sure the console thread exists, pin it first.
      if (projectId === teamLeadProjectId && !list.some((t) => t.kind === "teamlead")) {
        await window.spawn.createThread({ projectId, title: "Team-lead console", kind: "teamlead" });
        list = await window.spawn.listThreads(projectId);
      }
      if (stale) return;
      list.sort((a, b) => (a.kind === "teamlead" ? -1 : b.kind === "teamlead" ? 1 : 0));
      setThreads(list);
    })();
    return () => {
      stale = true;
    };
  }, [projectId, teamLeadProjectId, refreshTick]);

  // Focus the rename box as soon as it appears.
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  const openThread = async () => {
    if (projectId == null) return;
    const t = await window.spawn.createThread({ projectId, title: "" });
    setThreads((prev) => (prev.some((x) => x.id === t.id) ? prev : [t, ...prev]));
    setThreadId(t.id);
  };

  const startRename = (t: Thread) => setRenaming({ id: t.id, text: t.title });
  const commitRename = async () => {
    if (!renaming) return;
    const title = renaming.text.trim();
    const t = threads.find((x) => x.id === renaming.id);
    setRenaming(null);
    if (t && title && title !== t.title) await window.spawn.renameThread(renaming.id, title);
  };

  const setStatus = async (t: Thread, status: Thread["status"]) => {
    await window.spawn.setThreadStatus(t.id, status);
  };

  const cleanup = async (t: Thread) => {
    const r = await window.spawn.cleanupThread(t.id);
    if (r.ok) return flash("Worktree cleaned up — thread archived.");
    if (r.reason === "running") return flash("Can't clean up: a run is still active. Stop it first.");
    if (r.reason === "dirty")
      return flash(`Worktree has ${r.dirty} uncommitted change(s) — discard from the thread's rail.`);
    flash(`Clean up failed: ${r.reason}`);
  };

  const doDelete = async (t: Thread) => {
    setConfirmDelete(null);
    const r = await window.spawn.deleteThread(t.id);
    if (r.ok) {
      setThreads((prev) => prev.filter((x) => x.id !== t.id));
      if (threadId === t.id) setThreadId(null);
      return;
    }
    if (r.reason === "running") return flash("Can't delete: a run is still active. Stop it first.");
    flash(`Delete failed: ${r.reason}`);
  };

  // The menu entries for the right-clicked thread. The team-lead console is a
  // system thread (auto-recreated) — offer only the safe actions.
  const menuItems = (t: Thread): MenuEntry[] => {
    const isTeamLead = t.kind === "teamlead";
    const items: MenuEntry[] = [
      { label: "Rename", icon: "ph-pencil-simple", onClick: () => startRename(t) },
      { label: "Reset session", icon: "ph-arrow-counter-clockwise", onClick: async () => {
          await window.spawn.resetThreadSession(t.id);
          flash("Session reset — next message starts a fresh Claude session.");
        } },
    ];
    if (!isTeamLead) {
      items.push("sep");
      if (t.status !== "done")
        items.push({ label: "Mark as done", icon: "ph-check-circle", onClick: () => setStatus(t, "done") });
      if (t.status !== "active")
        items.push({ label: "Reopen (active)", icon: "ph-arrow-u-up-left", onClick: () => setStatus(t, "active") });
      if (t.status !== "blocked")
        items.push({ label: "Mark blocked", icon: "ph-warning-circle", onClick: () => setStatus(t, "blocked") });
    }
    if (t.branch)
      items.push({ label: "Copy branch name", icon: "ph-git-branch", onClick: async () => {
          await navigator.clipboard.writeText(t.branch!);
          flash(`Copied "${t.branch}".`);
        } });
    if (t.worktree_path) {
      items.push({ label: "Open worktree in Finder", icon: "ph-folder-open", onClick: () => window.spawn.openDir(t.worktree_path!) });
      if (!isTeamLead)
        items.push({ label: "Clean up worktree", icon: "ph-broom", onClick: () => cleanup(t) });
    }
    if (!isTeamLead) {
      items.push("sep");
      items.push({ label: "Delete thread", icon: "ph-trash", danger: true, onClick: () => setConfirmDelete(t) });
    }
    return items;
  };

  const current = threads.find((t) => t.id === threadId) ?? null;

  return (
    <div className="threads-view">
      <div className="thread-list fade-r">
        <div className="sect" style={{ padding: "0 10px 10px" }}>
          <span>{project ? project.name : "Threads"}</span>
          <span className="line" />
          <button className="btn btn-ghost small-btn" onClick={openThread} disabled={projectId == null}>
            <i className="ph ph-plus" />
          </button>
        </div>
        {note && <div className="thread-note">{note}</div>}
        {projectId == null && (
          <span style={{ fontSize: 12, color: "var(--color-neutral-600)", padding: "0 10px" }}>
            Pick a project in the sidebar.
          </span>
        )}
        {threads.map((t) =>
          renaming?.id === t.id ? (
            <div key={t.id} className="thread-item">
              <span className="dot-idle" />
              <input
                ref={renameRef}
                className="thread-rename"
                value={renaming.text}
                onChange={(e) => setRenaming({ id: t.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={commitRename}
              />
            </div>
          ) : (
            <button
              key={t.id}
              className={`thread-item ${t.id === threadId ? "active" : ""} ${
                menu?.thread.id === t.id ? "menu-target" : ""
              }`}
              onClick={() => setThreadId(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, thread: t });
              }}
            >
              {busyThreads.has(t.id) ? (
                <span className="dot-live pulse" />
              ) : t.kind === "teamlead" ? (
                <i className="ph ph-compass" style={{ color: "var(--color-accent)", fontSize: 14 }} />
              ) : (
                <span className={t.status === "active" ? "dot-idle" : "chip"} />
              )}
              <span className="t">{t.title}</span>
              <span className="k">{t.kind === "chat" ? "" : t.kind}</span>
            </button>
          )
        )}
      </div>

      <div className="chat-col">
        {current == null ? (
          <div className="empty">
            {isTeamLeadProject ? "Opening the console…" : "Pick a thread, or open a new one."}
          </div>
        ) : (
          <>
            <div className="chat-head fade-b">
              {current.kind === "teamlead" && <i className="ph ph-compass" style={{ color: "var(--color-accent)", fontSize: 16 }} />}
              <span className="name">{current.title}</span>
              <span className="sub">
                {current.kind === "teamlead" ? "orchestrates every project" : current.kind}
              </span>
            </div>
            <ChatThread
              threadId={current.id}
              busy={busyThreads.has(current.id)}
              markBusy={markBusy}
              placeholder={
                current.kind === "teamlead"
                  ? "Message the lead — delegate, ask status, plan…"
                  : "Steer the agent — add context, change course…"
              }
            />
          </>
        )}
      </div>

      {current != null ? <ContextRail threadId={current.id} /> : <aside className="rail fade-l" />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.thread)} onClose={() => setMenu(null)} />
      )}

      {confirmDelete && (
        <div className="overlay center" onPointerDown={() => setConfirmDelete(null)}>
          <div className="sheet" style={{ width: 420 }} onPointerDown={(e) => e.stopPropagation()}>
            <div className="s-head">
              <i className="ph ph-trash" style={{ color: "oklch(0.72 0.15 25)" }} />
              Delete thread
            </div>
            <p style={{ fontSize: 13, color: "var(--color-neutral-300)", lineHeight: 1.5, margin: 0 }}>
              Delete <strong>“{confirmDelete.title}”</strong> and its messages? This can't be undone.
              {confirmDelete.worktree_path && " Its worktree checkout is removed; the branch and commits stay in the repo."}
            </p>
            <div className="s-foot" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => doDelete(confirmDelete)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
