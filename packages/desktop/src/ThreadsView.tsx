import { useEffect, useRef, useState } from "react";
import type { Project, ProjectThread, Thread } from "./types";
import ChatThread from "./ChatThread";
import ContextRail from "./ContextRail";
import CodePanel from "./CodePanel";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import { useEscapeToClose, useFocusTrap } from "./hooks";

// Threads — a global list of every thread across every project (each row
// tagged with its project name), chat center, context rail right. The
// team-lead console is the pinned first entry (kind teamlead, create-or-open,
// same contract as the old workspace). The side-nav's selected project is only
// the target for the "new thread" button, not a filter on the list.
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
  unread,
}: {
  projectId: number | null;
  projects: Project[];
  threadId: number | null;
  setThreadId: (id: number | null) => void;
  busyThreads: Set<number>;
  markBusy: (id: number) => void;
  teamLeadProjectId: number | null;
  refreshTick: number;
  unread: Map<number, number>;
}) {
  const [threads, setThreads] = useState<ProjectThread[]>([]);
  // Which panel fills the thread's right column: the isolation/PR context rail,
  // or the GitHub-style Changes/diff review (SPWN-41). Sticky across threads —
  // a dev reviewing code stays in code mode as they move between threads.
  const [rightPane, setRightPane] = useState<"context" | "code">("context");

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
    let stale = false;
    (async () => {
      let list = await window.agentdeck.listAllThreads();
      // Make sure the team-lead console exists (in its home project), pin first.
      if (teamLeadProjectId != null && !list.some((t) => t.kind === "teamlead")) {
        await window.agentdeck.createThread({ projectId: teamLeadProjectId, title: "Team-lead console", kind: "teamlead" });
        list = await window.agentdeck.listAllThreads();
      }
      if (stale) return;
      // DB already orders newest-first; a stable sort just lifts the console up.
      list.sort((a, b) => (a.kind === "teamlead" ? -1 : b.kind === "teamlead" ? 1 : 0));
      setThreads(list);
    })();
    return () => {
      stale = true;
    };
  }, [teamLeadProjectId, refreshTick]);

  // Focus the rename box as soon as it appears.
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming]);

  useEscapeToClose(() => setConfirmDelete(null), confirmDelete != null);
  const confirmRef = useRef<HTMLDivElement>(null);
  useFocusTrap(confirmRef, confirmDelete != null);

  const openThread = async () => {
    if (projectId == null) return;
    const t = await window.agentdeck.createThread({ projectId, title: "" });
    const project_name = projects.find((p) => p.id === projectId)?.name ?? "";
    const row: ProjectThread = { ...t, project_name };
    setThreads((prev) => (prev.some((x) => x.id === t.id) ? prev : [row, ...prev]));
    setThreadId(t.id);
  };

  const startRename = (t: Thread) => setRenaming({ id: t.id, text: t.title });
  const commitRename = async () => {
    if (!renaming) return;
    const title = renaming.text.trim();
    const t = threads.find((x) => x.id === renaming.id);
    setRenaming(null);
    if (t && title && title !== t.title) await window.agentdeck.renameThread(renaming.id, title);
  };

  const setStatus = async (t: Thread, status: Thread["status"]) => {
    await window.agentdeck.setThreadStatus(t.id, status);
  };

  const cleanup = async (t: Thread) => {
    const r = await window.agentdeck.cleanupThread(t.id);
    if (r.ok) return flash("Worktree cleaned up — thread archived.");
    if (r.reason === "running") return flash("Can't clean up: a run is still active. Stop it first.");
    if (r.reason === "dirty")
      return flash(`Worktree has ${r.dirty} uncommitted change(s) — discard from the thread's rail.`);
    flash(`Clean up failed: ${r.reason}`);
  };

  const doDelete = async (t: Thread) => {
    setConfirmDelete(null);
    const r = await window.agentdeck.deleteThread(t.id);
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
          await window.agentdeck.resetThreadSession(t.id);
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
      items.push({ label: "Open worktree in Finder", icon: "ph-folder-open", onClick: () => window.agentdeck.openDir(t.worktree_path!) });
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

  // Roving arrow-key nav across the list — Tab still works row-by-row, but
  // Up/Down moves focus without leaving the list (Discord/mail-app pattern).
  const listRef = useRef<HTMLDivElement>(null);
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(".thread-item") ?? []);
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    const next = i === -1 ? 0 : e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0);
    items[next].focus();
  };

  return (
    <div className={`threads-view ${current != null && rightPane === "code" ? "code-mode" : ""}`}>
      <div className="thread-list fade-r" ref={listRef} onKeyDown={onListKeyDown}>
        <div className="sect" style={{ padding: "0 10px 10px" }}>
          <span>All threads</span>
          <span className="line" />
          <button
            className="btn btn-ghost small-btn"
            onClick={openThread}
            disabled={projectId == null}
            title={projectId == null ? "Pick a project in the sidebar to start a thread" : "New thread"}
          >
            <i className="ph ph-plus" />
          </button>
        </div>
        {note && <div className="thread-note">{note}</div>}
        {threads.length === 0 && (
          <span style={{ fontSize: 12, color: "var(--color-neutral-600)", padding: "0 10px" }}>
            No threads yet.
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
              } ${(unread.get(t.id) ?? 0) > 0 ? "unread" : ""}`}
              onClick={() => setThreadId(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, thread: t });
              }}
              onKeyDown={(e) => {
                // The keyboard equivalent of right-click (Menu key, or
                // Shift+F10 on keyboards without one) — the manage menu
                // otherwise has no non-mouse path in.
                if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: r.left + 24, y: r.bottom, thread: t });
                }
              }}
            >
              {busyThreads.has(t.id) ? (
                <span className="dot-live pulse" />
              ) : (unread.get(t.id) ?? 0) > 0 ? (
                <span className="unread-dot" />
              ) : t.kind === "teamlead" ? (
                <i className="ph ph-compass" style={{ color: "var(--color-accent)", fontSize: 14 }} />
              ) : (
                <span className={t.status === "active" ? "dot-idle" : "chip"} />
              )}
              <span className="t">{t.title}</span>
              {(unread.get(t.id) ?? 0) > 0 ? (
                <span className="unread-count">{unread.get(t.id)}</span>
              ) : (
                // Global view — tag each row with its project so you know where
                // it lives; the console's home project is implied by its icon.
                <span className="k">{t.kind === "teamlead" ? "" : t.project_name}</span>
              )}
            </button>
          )
        )}
      </div>

      <div className="chat-col">
        {current == null ? (
          <div className="empty">Pick a thread, or open a new one.</div>
        ) : (
          <>
            <div className="chat-head fade-b">
              {current.kind === "teamlead" && <i className="ph ph-compass" style={{ color: "var(--color-accent)", fontSize: 16 }} />}
              <span className="name">{current.title}</span>
              <span className="sub">
                {current.kind === "teamlead" ? "orchestrates every project" : current.kind}
              </span>
              <div className="pane-toggle" role="tablist" aria-label="Right panel">
                <button
                  role="tab"
                  aria-selected={rightPane === "context"}
                  className={rightPane === "context" ? "on" : ""}
                  onClick={() => setRightPane("context")}
                >
                  <i className="ph ph-info" /> Context
                </button>
                <button
                  role="tab"
                  aria-selected={rightPane === "code"}
                  className={rightPane === "code" ? "on" : ""}
                  onClick={() => setRightPane("code")}
                  title="Review the code this thread changed"
                >
                  <i className="ph ph-git-diff" /> Changes
                </button>
              </div>
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

      {current != null ? (
        rightPane === "code" ? (
          <CodePanel threadId={current.id} />
        ) : (
          <ContextRail threadId={current.id} />
        )
      ) : (
        <aside className="rail fade-l" />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.thread)} onClose={() => setMenu(null)} />
      )}

      {confirmDelete && (
        <div className="overlay center" onPointerDown={() => setConfirmDelete(null)}>
          <div className="sheet" ref={confirmRef} style={{ width: 420 }} onPointerDown={(e) => e.stopPropagation()}>
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
