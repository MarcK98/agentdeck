import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActiveThread, ApprovalRequest, Project, UsageSummary } from "./types";
import OrchestrateView from "./OrchestrateView";
import ThreadsView from "./ThreadsView";
import MapView from "./MapView";
import ApprovalsView from "./ApprovalsView";
import UsageView from "./UsageView";
import SettingsView from "./SettingsView";
import Palette from "./Palette";
import TicketSheet from "./TicketSheet";
import Brand from "./Brand";
import LoginView from "./LoginView";
import OnboardingView from "./OnboardingView";

// AgentDeck — Mission Control shell (design 1a): top bar (⌘K, today's tokens,
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

// Rail project prefs (order + hidden) — pure UI state, kept client-side.
interface ProjectPrefs {
  order: number[];
  hidden: number[];
}
const PREFS_KEY = "spawn.projectPrefs";
const loadPrefs = (): ProjectPrefs => {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "");
    return { order: Array.isArray(p.order) ? p.order : [], hidden: Array.isArray(p.hidden) ? p.hidden : [] };
  } catch {
    return { order: [], hidden: [] };
  }
};

// Last open view/project/thread — restored on relaunch so the app reopens
// where you left it (Discord behavior), not on a fixed home view.
const SESSION_KEY = "spawn.session";
const loadSession = (): { view: View; projectId: number | null; threadId: number | null } => {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "");
    const views: View[] = ["orchestrate", "threads", "map", "approvals", "usage", "settings"];
    return {
      view: views.includes(s.view) ? s.view : "orchestrate",
      projectId: typeof s.projectId === "number" ? s.projectId : null,
      threadId: typeof s.threadId === "number" ? s.threadId : null,
    };
  } catch {
    return { view: "orchestrate", projectId: null, threadId: null };
  }
};

// OS-notification preference (main process fires them; this is the on/off
// switch, mirrored to the daemon-agnostic main over IPC). Default on.
const NOTIF_KEY = "spawn.notificationsEnabled";
const loadNotifPref = (): boolean => {
  try {
    return localStorage.getItem(NOTIF_KEY) !== "0";
  } catch {
    return true;
  }
};

// First-run gates. `spawn.authed` is set once the user signs in (or explores
// the demo); `spawn.onboarded` once setup is done or skipped. Both are local —
// AgentDeck is bring-your-own-subscription, so there is no server account.
const AUTH_KEY = "spawn.authed";
const ONBOARD_KEY = "spawn.onboarded";
const readFlag = (k: string) => {
  try {
    return localStorage.getItem(k) === "1";
  } catch {
    return false;
  }
};
const writeFlag = (k: string) => {
  try {
    localStorage.setItem(k, "1");
  } catch {
    /* fine */
  }
};

export default function App() {
  const [authed, setAuthed] = useState(readFlag(AUTH_KEY));
  const [onboarded, setOnboarded] = useState(readFlag(ONBOARD_KEY));
  const [session] = useState(loadSession);
  const [view, setView] = useState<View>(session.view);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<number | null>(session.projectId);
  const [threadId, setThreadId] = useState<number | null>(session.threadId);
  // Session-scoped unread counts per thread — bumped when a reply lands in a
  // thread that isn't open, cleared on open. Feeds the thread list, the
  // projects rail and the Threads nav badge.
  const [unread, setUnread] = useState<Map<number, number>>(new Map());
  const [teamLeadProjectId, setTeamLeadProjectId] = useState<number | null>(null);
  const [active, setActive] = useState<ActiveThread[]>([]);
  const [busyThreads, setBusyThreads] = useState<Set<number>>(new Set());
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([]);
  const [toast, setToast] = useState<ApprovalRequest | null>(null);
  const [usageToday, setUsageToday] = useState<UsageSummary | null>(null);
  // Live in-flight tokens per running thread (turn:usage events; cleared on
  // turn:done). The top-bar chip shows the sum across all agents.
  const [liveTokens, setLiveTokens] = useState<Map<number, number>>(new Map());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  // A ticket to pop open on the board — set when an OS notification for a new
  // comment is clicked; OrchestrateView opens its detail modal, then clears it.
  const [focusTicketId, setFocusTicketId] = useState<number | null>(null);
  // Cross-view jump: set thread after the Threads view loads its list.
  const jumpRef = useRef<number | null>(null);
  // Rail projects: custom order + hidden set, with a manage mode for
  // drag-reordering and eye-toggling. Persisted in localStorage.
  const [prefs, setPrefsState] = useState<ProjectPrefs>(loadPrefs);
  const [manageProjects, setManageProjects] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const savePrefs = useCallback((p: ProjectPrefs) => {
    setPrefsState(p);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
      /* storage full/unavailable — order just won't persist */
    }
  }, []);

  const orderedProjects = useMemo(() => {
    const idx = new Map(prefs.order.map((id, i) => [id, i]));
    return [...projects].sort(
      (a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9) || a.name.localeCompare(b.name)
    );
  }, [projects, prefs.order]);
  const railProjects = manageProjects
    ? orderedProjects
    : orderedProjects.filter((p) => !prefs.hidden.includes(p.id));

  const moveProject = (from: number, to: number) => {
    if (from === to) return;
    const ids = orderedProjects.map((p) => p.id);
    const [id] = ids.splice(from, 1);
    ids.splice(to, 0, id);
    savePrefs({ ...prefs, order: ids });
  };
  const toggleHidden = (id: number) => {
    savePrefs({
      ...prefs,
      hidden: prefs.hidden.includes(id) ? prefs.hidden.filter((x) => x !== id) : [...prefs.hidden, id],
    });
  };

  const markBusy = useCallback((id: number) => {
    setBusyThreads((prev) => new Set(prev).add(id));
  }, []);

  const refreshShared = useCallback(() => {
    window.agentdeck
      .listActiveThreads()
      .then((a) => {
        setActive(a);
        // Seed busy from the daemon's view — after an app reload mid-run the
        // live turn:start already happened and would otherwise be missed.
        setBusyThreads((prev) => {
          const next = new Set(prev);
          for (const t of a) if (t.running) next.add(t.id);
          return next;
        });
      })
      .catch(() => {});
    window.agentdeck.listApprovals().then(setPendingApprovals).catch(() => {});
    window.agentdeck.getUsage(1).then(setUsageToday).catch(() => {});
  }, []);

  // Persist where we are (view/project/thread) for relaunch restore.
  useEffect(() => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ view, projectId, threadId }));
    } catch {
      /* fine */
    }
  }, [view, projectId, threadId]);

  useEffect(() => {
    window.agentdeck.listProjects().then(setProjects);
    window.agentdeck
      .getTeamLeadProject()
      .then((p) => setTeamLeadProjectId(p?.id ?? null))
      .catch(() => {});
    refreshShared();
  }, [refreshShared]);

  // Live refs so the event handler can tell whether a thread is on screen
  // without resubscribing on every navigation.
  const viewRef = useRef(view);
  viewRef.current = view;
  const threadRef = useRef(threadId);
  threadRef.current = threadId;

  useEffect(() => {
    return window.agentdeck.onEvent((ev) => {
      if (
        ev.type === "thread:created" ||
        ev.type === "thread:updated" ||
        ev.type === "thread:deleted" ||
        ev.type === "turn:start" ||
        ev.type === "turn:done"
      ) {
        setRefreshTick((n) => n + 1);
        refreshShared();
      }
      if (ev.type === "thread:deleted") {
        // If the open thread just got deleted (here or elsewhere), drop the
        // selection so the chat pane doesn't keep pointing at a dead row.
        setThreadId((cur) => (cur === ev.payload.id ? null : cur));
        if (jumpRef.current === ev.payload.id) jumpRef.current = null;
        setUnread((prev) => {
          if (!prev.has(ev.payload.id)) return prev;
          const next = new Map(prev);
          next.delete(ev.payload.id);
          return next;
        });
      }
      if (ev.type === "turn:text") {
        // A reply landed. If that thread isn't the one on screen, mark it
        // unread — the core Discord mechanic.
        const tId = ev.payload.threadId;
        const onScreen = viewRef.current === "threads" && threadRef.current === tId;
        if (!onScreen) setUnread((prev) => new Map(prev).set(tId, (prev.get(tId) ?? 0) + 1));
      }
      if (ev.type === "turn:start") {
        setBusyThreads((prev) => new Set(prev).add(ev.payload.threadId));
      }
      if (ev.type === "turn:usage") {
        setLiveTokens((prev) => new Map(prev).set(ev.payload.threadId, ev.payload.liveTokens));
      }
      if (ev.type === "turn:done") {
        setBusyThreads((prev) => {
          const next = new Set(prev);
          next.delete(ev.payload.threadId);
          return next;
        });
        setLiveTokens((prev) => {
          const next = new Map(prev);
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

  // Sync the saved notification preference to the main process on boot (it
  // defaults on, but honor a prior "off"), and route notification clicks to
  // the thing they're about.
  useEffect(() => {
    window.agentdeck.setNotificationsEnabled?.(loadNotifPref());
    return window.agentdeck.onNotificationClick?.((c) => {
      if (c.kind === "ticket") {
        setView("orchestrate");
        setFocusTicketId(c.ticketId);
      } else if (c.kind === "approval") {
        setView("approvals");
      }
    });
  }, []);

  // ⌘K palette, ⌘N delegate sheet — gated so shortcuts don't stack overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (sheetOpen) return;
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        if (paletteOpen || sheetOpen) return;
        e.preventDefault();
        setSheetOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, sheetOpen]);

  const clearUnread = useCallback((tId: number) => {
    setUnread((prev) => {
      if (!prev.has(tId)) return prev;
      const next = new Map(prev);
      next.delete(tId);
      return next;
    });
  }, []);

  const openThread = useCallback(
    (pId: number, tId: number) => {
      setView("threads");
      clearUnread(tId);
      if (pId === projectId) {
        setThreadId(tId);
      } else {
        jumpRef.current = tId;
        setProjectId(pId);
        setThreadId(tId);
      }
    },
    [projectId, clearUnread]
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
  const unreadTotal = [...unread.values()].reduce((a, b) => a + b, 0);
  const unreadByProject = new Map<number, number>();
  for (const t of active) {
    const c = unread.get(t.id);
    if (c) unreadByProject.set(t.project_id, (unreadByProject.get(t.project_id) ?? 0) + c);
  }
  // Merge event-fresh live token counts over the polled active list.
  const activeLive = active.map((t) => ({ ...t, liveTokens: liveTokens.get(t.id) ?? t.liveTokens }));
  const totalLive = [...liveTokens.values()].reduce((a, b) => a + b, 0);
  const toastThread = toast ? (active.find((t) => t.id === toast.threadId) ?? null) : null;

  const toastBusy = useRef(false);
  const answerToast = (allow: boolean) => {
    if (!toast || toastBusy.current) return;
    toastBusy.current = true;
    window.agentdeck.resolveApproval(toast.id, allow).finally(() => {
      toastBusy.current = false;
    });
    setToast(null);
  };

  if (!authed) {
    return (
      <LoginView
        onAuthed={() => {
          writeFlag(AUTH_KEY);
          setAuthed(true);
        }}
      />
    );
  }
  if (!onboarded) {
    return (
      <OnboardingView
        onDone={() => {
          writeFlag(ONBOARD_KEY);
          setOnboarded(true);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <header className="topbar fade-b">
        <div className="brand">
          <Brand s={13} />
          AgentDeck
        </div>
        <div className="palette-trigger">
          <button onClick={() => setPaletteOpen(true)}>
            <i className="ph ph-magnifying-glass" />
            Jump to thread, delegate, run a command…
            <span className="kbd">⌘K</span>
          </button>
        </div>
        <div className="topbar-right">
          {totalLive > 0 && (
            <span className="tag tag-accent tok-today" title="Tokens consumed by runs in flight right now (all agents)">
              <span className="dot-live pulse" style={{ width: 6, height: 6 }} />
              {fmtTok(totalLive)} in flight
            </span>
          )}
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
              {n.view === "threads" && unreadTotal > 0 && <span className="unread-count">{unreadTotal}</span>}
              {n.view === "threads" && unreadTotal === 0 && active.length > 0 && (
                <span className="meta">{active.length}</span>
              )}
              {n.view === "approvals" && pendingApprovals.length > 0 && (
                <span className="tag tag-accent" style={{ marginLeft: "auto", padding: "0 7px", fontSize: 10.5 }}>
                  {pendingApprovals.length}
                </span>
              )}
            </button>
          ))}

          <div className="nav-head">
            Projects
            <button
              className={`nav-edit ${manageProjects ? "on" : ""}`}
              title={manageProjects ? "Done — save order & visibility" : "Reorder / hide projects"}
              onClick={() => setManageProjects((m) => !m)}
            >
              <i className={`ph ${manageProjects ? "ph-check" : "ph-sliders-horizontal"}`} />
            </button>
          </div>
          <div className="nav-projects">
            {railProjects.map((p, i) => {
              const hidden = prefs.hidden.includes(p.id);
              return (
                <button
                  key={p.id}
                  className={`nav-project ${view === "threads" && p.id === projectId ? "active" : ""} ${
                    manageProjects && hidden ? "hidden-p" : ""
                  }`}
                  title={p.dir}
                  draggable={manageProjects}
                  onDragStart={() => {
                    dragFrom.current = i;
                  }}
                  onDragOver={(e) => {
                    if (!manageProjects || dragFrom.current == null) return;
                    e.preventDefault();
                    if (dragFrom.current !== i) {
                      moveProject(dragFrom.current, i);
                      dragFrom.current = i;
                    }
                  }}
                  onDragEnd={() => {
                    dragFrom.current = null;
                  }}
                  onClick={() => {
                    if (!manageProjects) openProject(p.id);
                  }}
                >
                  {manageProjects ? (
                    <i className="ph ph-dots-six-vertical grip" />
                  ) : (
                    <span
                      className="chip"
                      style={p.id === teamLeadProjectId ? { background: "var(--color-accent-500)" } : undefined}
                    />
                  )}
                  <span className="name">{p.name}</span>
                  {manageProjects ? (
                    <span
                      className="eye"
                      title={hidden ? "Show in sidebar" : "Hide from sidebar"}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleHidden(p.id);
                      }}
                    >
                      <i className={`ph ${hidden ? "ph-eye-slash" : "ph-eye"}`} />
                    </span>
                  ) : (unreadByProject.get(p.id) ?? 0) > 0 ? (
                    <span className="unread-count">{unreadByProject.get(p.id)}</span>
                  ) : (
                    (runningByProject.get(p.id) ?? 0) > 0 && (
                      <span className="run-count">● {runningByProject.get(p.id)}</span>
                    )
                  )}
                </button>
              );
            })}
            {!manageProjects && prefs.hidden.length > 0 && (
              <div className="nav-hidden-note">{prefs.hidden.length} hidden</div>
            )}
          </div>

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

        {/* Views stay mounted (scroll/board/settings state survives switching);
            the wrapper toggles display. MapView is the exception — react-flow
            plus its poll loop is only worth running while visible. */}
        <div className={`view-wrap ${view === "orchestrate" ? "" : "off"}`}>
          <OrchestrateView
            projects={projects}
            active={activeLive}
            usage={usageToday}
            onOpenThread={openThread}
            markBusy={markBusy}
            focusTicketId={focusTicketId}
            onFocusHandled={() => setFocusTicketId(null)}
          />
        </div>
        <div className={`view-wrap ${view === "threads" ? "" : "off"}`}>
          <ThreadsView
            projectId={projectId}
            projects={projects}
            threadId={threadId ?? jumpRef.current}
            setThreadId={(id) => {
              jumpRef.current = null;
              if (id != null) clearUnread(id);
              setThreadId(id);
            }}
            busyThreads={busyThreads}
            markBusy={markBusy}
            teamLeadProjectId={teamLeadProjectId}
            refreshTick={refreshTick}
            unread={unread}
          />
        </div>
        {view === "map" && (
          <MapView onOpenTeamLead={openTeamLead} onOpenProject={openProject} onOpenThread={openThread} />
        )}
        <div className={`view-wrap ${view === "approvals" ? "" : "off"}`}>
          <ApprovalsView active={activeLive} onOpenThread={openThread} />
        </div>
        <div className={`view-wrap ${view === "usage" ? "" : "off"}`}>
          <UsageView />
        </div>
        <div className={`view-wrap ${view === "settings" ? "" : "off"}`}>
          <SettingsView projects={projects} initialProjectId={projectId} />
        </div>
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
        <TicketSheet
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
