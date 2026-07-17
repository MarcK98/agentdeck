import { useEffect, useState } from "react";
import type { Project, Thread } from "./types";
import ChatThread from "./ChatThread";
import ContextRail from "./ContextRail";

// Threads — thread list for the selected project (project picked in the side
// nav), chat center, context rail right. The team-lead console is the pinned
// first entry when the selected project IS the team-lead's home (kind
// teamlead, create-or-open, same contract as the old workspace).

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

  const openThread = async () => {
    if (projectId == null) return;
    const t = await window.spawn.createThread({ projectId, title: "" });
    setThreads((prev) => (prev.some((x) => x.id === t.id) ? prev : [t, ...prev]));
    setThreadId(t.id);
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
        {projectId == null && (
          <span style={{ fontSize: 12, color: "var(--color-neutral-600)", padding: "0 10px" }}>
            Pick a project in the sidebar.
          </span>
        )}
        {threads.map((t) => (
          <button
            key={t.id}
            className={`thread-item ${t.id === threadId ? "active" : ""}`}
            onClick={() => setThreadId(t.id)}
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
        ))}
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
    </div>
  );
}
