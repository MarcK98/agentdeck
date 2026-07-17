import { useCallback, useEffect, useRef, useState } from "react";
import type { ActiveThread, ApprovalRequest, Project, UsageSummary } from "./types";
import OrchestrateView from "./OrchestrateView";
import ThreadsView from "./ThreadsView";
import MapView from "./MapView";
import ApprovalsView from "./ApprovalsView";
import UsageView from "./UsageView";
import SettingsView from "./SettingsView";
import Palette from "./Palette";
import DelegateSheet from "./DelegateSheet";

// Spawn — Mission Control shell (design 1a): top bar (⌘K, today's tokens,
// approvals bell), left nav (Orchestrate / Threads / Live map / Approvals /
// Usage / Settings + projects), views right. Approvals surface as a
// non-blocking toast + inbox, never a blocking modal.

type View = "orchestrate" | "threads" | "map" | "approvals" | "usage" | "settings";

const NAV: { view: View; label: string; icon: string }[] = [
  { view: "orchestrate", label: "Orchestrate", icon: "ph-kanban" },
  { view: "threads", label: "Threads", icon: "ph-chats-circle" },
  { view: "map", label: "Live map", icon: "ph-graph" },
  { view: "approvals", label: "Approvals", icon: "ph-tray" },
  { view: "usage", label: "Usage", icon: "ph-chart-line-up" },
];

const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

export default function App() {
  const [view, setView] = useState<View>("orchestrate");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [threadId, setThreadId] = useState<number | null>(null);
  const [teamLeadProjectId, setTeamLeadProjectId] = useState<number | null>(null);
  const [active, setActive] = useState<ActiveThread[]>([]);
  const [busyThreads, setBusyThreads] = useState<Set<number>>(new Set());
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [toast, setToast] = useState<ApprovalRequest | null>(null);
  const [usageToday, setUsageToday] = useState<UsageSummary | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // Cross-view jump: set thread after the Threads view loads its list.
  const jumpRef = useRef<number | null>(null);

  const markBusy = useCallback((id: number) => {
    setBusyThreads((prev) => new Set(prev).add(id));
  }, []);

  const refreshShared = useCallback(() => {
    window.spawn.listActiveThreads().then(setActive).catch(() => {});
    window.spawn.listApprovals().then(setPendingApprovals).catch(() => {});
    window.spawn.getUsage(1).then(setUsageToday).catch(() => {});
  }, []);

  useEffect(() => {
    window.spawn.listProjects().then(setProjects);
    window.spawn
      .getTeamLeadProject()
      .then((p) => setTeamLeadProjectId(p?.id ?? null))
      .catch(() => {});
    refreshShared();
  }, [refreshShared]);

  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (
        ev.type === "thread:created" ||
        ev.type === "thread:updated" ||
        ev.type === "turn:start" ||
        ev.type === "turn:done"
      ) {
        setRefreshTick((n) => n + 1);
        refreshShared();
      }
      if (ev.type === "turn:start") {
        setBusyThreads((prev) => new Set(prev).add(ev.payload.threadId));
      }
      if (ev.type === "turn:done") {
        setBusyThreads((prev) => {
          const next = new Set(prev);
          next.delete(ev.payload.threadId);
          return next;
        });
        setToast((cur) => (cur?.threadId === ev.payload.threadId ? null : cur));
      }
      if (ev.type === "approval:request") {
        setPendingApprovals((prev) => (prev.some((p) => p.id === ev.payload.id) ? prev : [...prev, ev.payload]));
        setToast(ev.payload);
      }
      if (ev.type === "approval:resolved") {
        setPendingApprovals((prev) => prev.filter((p) => p.id !== ev.payload.id));
        setToast((cur) => (cur?.id === ev.payload.id ? null : cur));
      }
    });
  }, [refreshShared]);

  // ⌘K palette, ⌘N delegate sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        setSheetOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openThread = useCallback(
    (pId: number, tId: number) => {
      setView("threads");
      if (pId === projectId) {
        setThreadId(tId);
      } else {
        jumpRef.current = tId;
        setProjectId(pId);
        setThreadId(tId);
      }
    },
    [projectId]
  );
  const openProject = useCallback((pId: number) => {
    setView("threads");
    setProjectId(pId);
    setThreadId(null);
  }, []);
  const openTeamLead = useCallback(() => {
    if (teamLeadProjectId != null) openProject(teamLeadProjectId);
    else setView("threads");
  }, [teamLeadProjectId, openProject]);

  const runningByProject = new Map<number, number>();
  for (const t of active) {
    if (t.running) runningByProject.set(t.project_id, (runningByProject.get(t.project_id) ?? 0) + 1);
  }
  const toastThread = toast ? (active.find((t) => t.id === toast.threadId) ?? null) : null;

  const answerToast = (allow: boolean) => {
    if (!toast) return;
    window.spawn.resolveApproval(toast.id, allow);
    setToast(null);
  };

  return (
    <div className="shell">
      <header className="topbar fade-b">
        <div className="brand">
          <i className="ph-fill ph-broadcast" />
          Spawn
        </div>
        <div className="palette-trigger">
          <button onClick={() => setPaletteOpen(true)}>
            <i className="ph ph-magnifying-glass" />
            Jump to thread, delegate, run a command…
            <span className="kbd">⌘K</span>
          </button>
        </div>
        <div className="topbar-right">
          <span className="tag tag-outline tok-today" title="Tokens across all projects today">
            <i className="ph ph-stack" />
            {usageToday ? `${fmtTok(usageToday.totalTokens)} tok today` : "— today"}
          </span>
          <button className="inbox-bell" title="Approvals inbox" onClick={() => setView("approvals")}>
            <i className="ph ph-tray" />
            {pendingApprovals.length > 0 && <span className="count">{pendingApprovals.length}</span>}
          </button>
        </div>
      </header>

      <div className="content">
        <nav className="sidenav fade-r">
          {NAV.map((n) => (
            <button
              key={n.view}
              className={`nav-item ${view === n.view ? "active" : ""}`}
              onClick={() => setView(n.view)}
            >
              <i className={`ph ${n.icon}`} />
              {n.label}
              {n.view === "threads" && active.length > 0 && <span className="meta">{active.length}</span>}
              {n.view === "approvals" && pendingApprovals.length > 0 && (
                <span className="tag tag-accent" style={{ marginLeft: "auto", padding: "0 7px", fontSize: 10.5 }}>
                  {pendingApprovals.length}
                </span>
              )}
            </button>
          ))}

          <div className="nav-head">Projects</div>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`nav-project ${view === "threads" && p.id === projectId ? "active" : ""}`}
              title={p.dir}
              onClick={() => openProject(p.id)}
            >
              <span
                className="chip"
                style={p.id === teamLeadProjectId ? { background: "var(--color-accent-500)" } : undefined}
              />
              <span className="name">{p.name}</span>
              {(runningByProject.get(p.id) ?? 0) > 0 && (
                <span className="run-count">● {runningByProject.get(p.id)}</span>
              )}
            </button>
          ))}

          <div className="nav-bottom">
            <button
              className={`nav-item ${view === "settings" ? "active" : ""}`}
              onClick={() => setView("settings")}
            >
              <i className="ph ph-gear-six" />
              Settings
            </button>
          </div>
        </nav>

        {view === "orchestrate" ? (
          <OrchestrateView
            projects={projects}
            active={active}
            usage={usageToday}
            onOpenThread={openThread}
            markBusy={markBusy}
          />
        ) : view === "threads" ? (
          <ThreadsView
            projectId={projectId}
            projects={projects}
            threadId={threadId ?? jumpRef.current}
            setThreadId={(id) => {
              jumpRef.current = null;
              setThreadId(id);
            }}
            busyThreads={busyThreads}
            markBusy={markBusy}
            teamLeadProjectId={teamLeadProjectId}
            refreshTick={refreshTick}
          />
        ) : view === "map" ? (
          <MapView onOpenTeamLead={openTeamLead} onOpenProject={openProject} onOpenThread={openThread} />
        ) : view === "approvals" ? (
          <ApprovalsView active={active} onOpenThread={openThread} />
        ) : view === "usage" ? (
          <UsageView />
        ) : (
          <SettingsView projects={projects} initialProjectId={projectId} />
        )}
      </div>

      {paletteOpen && (
        <Palette
          projects={projects}
          active={active}
          actions={[
            {
              id: "delegate",
              label: "Delegate a task…",
              kind: "action",
              icon: "ph-paper-plane-tilt",
              run: () => setSheetOpen(true),
            },
            ...(teamLeadProjectId != null
              ? [
                  {
                    id: "teamlead",
                    label: "Team-lead console",
                    kind: "console",
                    icon: "ph-compass",
                    run: openTeamLead,
                  },
                ]
              : []),
            ...NAV.map((n) => ({
              id: `view-${n.view}`,
              label: n.label,
              kind: "view",
              icon: n.icon,
              run: () => setView(n.view),
            })),
          ]}
          onOpenThread={openThread}
          onOpenProject={openProject}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {sheetOpen && (
        <DelegateSheet
          projects={projects}
          initialProjectId={projectId}
          onClose={() => setSheetOpen(false)}
          onDelegated={(t) => {
            markBusy(t.id);
            openThread(t.project_id, t.id);
          }}
        />
      )}

      {toast && view !== "approvals" && (
        <div className="toast">
          <div className="head">
            <i className="ph-fill ph-hand-palm" />
            {toast.tool} wants to run
          </div>
          <div className="body">
            {toastThread ? `${toastThread.title} · ${toastThread.project_name}` : `thread ${toast.threadId ?? "?"}`}
          </div>
          <div className="acts">
            <button className="btn btn-primary small-btn" onClick={() => answerToast(true)}>
              Allow
            </button>
            <button className="btn btn-ghost small-btn" onClick={() => answerToast(false)}>
              Deny
            </button>
            <button
              className="btn btn-ghost small-btn"
              style={{ marginLeft: "auto" }}
              onClick={() => {
                setView("approvals");
                setToast(null);
              }}
            >
              Open inbox
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
