import type {
  ActiveThread,
  ApprovalDecision,
  ApprovalRequest,
  Board,
  MapData,
  Message,
  Project,
  ProjectSettings,
  Thread,
  ThreadContext,
  UsageSummary,
} from "./types";

// Fixture-backed window.spawn for plain-browser dev (no Electron preload, no
// daemon). Purely for eyeballing/screenshotting the UI — every mutation is a
// no-op or an in-memory echo. Never bundled into behavior: main.tsx installs
// it only when window.spawn is absent.

const projects: Project[] = [
  { id: 1, name: "spawnmy-ai", dir: "~/dev/spawnmy-ai", created_at: "" },
  { id: 2, name: "fable-engine", dir: "~/dev/fable-engine", created_at: "" },
  { id: 3, name: "site-refresh", dir: "~/dev/site-refresh", created_at: "" },
  { id: 4, name: "team-lead", dir: "~/dev/team-lead", created_at: "" },
  // Filler so the rail's project scrollview is exercised in browser QA.
  ...Array.from({ length: 14 }, (_, i) => ({
    id: 20 + i,
    name: `project-${String.fromCharCode(97 + i)}`,
    dir: `~/dev/project-${String.fromCharCode(97 + i)}`,
    created_at: "",
  })),
];

const mkThread = (
  id: number,
  projectId: number,
  kind: Thread["kind"],
  title: string,
  branch: string | null = null
): Thread => ({
  id,
  project_id: projectId,
  kind,
  title,
  ticket_key: null,
  branch,
  worktree_path: branch ? `~/dev/worktrees/p${projectId}/ticket-${id}` : null,
  status: "active",
  session_id: null,
  created_at: "2026-07-17T10:00:00Z",
  updated_at: "2026-07-17T14:20:00Z",
});

const threads: Thread[] = [
  mkThread(10, 4, "teamlead", "Team-lead console"),
  mkThread(11, 1, "ticket", "Worktree GC on daemon boot", "ticket/11-worktree-gc"),
  mkThread(12, 1, "ticket", "Stream tool output into thread view", "ticket/12-stream-tools"),
  mkThread(13, 2, "ticket", "Migrate sessions.json into SQLite", "ticket/13-sqlite-sessions"),
  mkThread(14, 1, "chat", "Ideas for the mobile client"),
];

const activeThreads: ActiveThread[] = threads.map((t) => ({
  ...t,
  project_name: projects.find((p) => p.id === t.project_id)?.name ?? "?",
  running: t.id === 11 || t.id === 12,
}));

const messages: Message[] = [
  {
    id: 1,
    thread_id: 11,
    role: "user",
    text: "You've been assigned a task by the team lead:\n\nOn boot, scan the worktrees dir for tickets that are done or archived and remove them. Keep branches.",
    tool_name: null,
    tool_input: null,
    seq: 0,
    created_at: "2026-07-17T14:18:00Z",
  },
  {
    id: 2,
    thread_id: 11,
    role: "assistant",
    text: "Plan: hook gcWorktrees() into daemon startup after session restore — confirming ticket states via the board first.",
    tool_name: null,
    tool_input: null,
    seq: 1,
    created_at: "2026-07-17T14:26:00Z",
  },
  {
    id: 3,
    thread_id: 11,
    role: "tool",
    text: "",
    tool_name: "Edit",
    tool_input: JSON.stringify({ file_path: "daemon/boot.js" }),
    seq: 2,
    created_at: "2026-07-17T14:29:00Z",
  },
  {
    id: 4,
    thread_id: 11,
    role: "tool",
    text: "",
    tool_name: "Bash",
    tool_input: JSON.stringify({ command: "npm test" }),
    seq: 3,
    created_at: "2026-07-17T14:31:00Z",
  },
];

const approvals: ApprovalRequest[] = [
  { id: 1, threadId: 13, tool: "Bash", input: { command: "rm -rf .wt/sqlite-sessions" } },
  { id: 2, threadId: 12, tool: "WebFetch", input: { url: "https://api.trello.com/1/boards/kX9/lists" } },
];

const decisions: ApprovalDecision[] = [
  { id: 3, threadId: 11, tool: "Bash", input: { command: "npm test" }, allow: true, at: Date.now() - 3600e3 },
  { id: 4, threadId: 12, tool: "Bash", input: { command: "git push --force" }, allow: false, at: Date.now() - 5400e3 },
];

const board: Board = {
  source: "trello",
  comments: [],
  columns: [
    {
      status: "todo",
      cards: [
        { key: "SPWN-41", ref: "c1", title: "Rate-limit the delegate tool per project", desc: "", status: "todo", url: "https://trello.com", attachments: [] },
        { key: "SPWN-44", ref: "c2", title: "Usage export as CSV", desc: "", status: "todo", url: "https://trello.com", attachments: [] },
        { key: "FAB-7", ref: "c3", title: "Dark-launch fable for the engine repo", desc: "", status: "todo", url: "https://trello.com", attachments: [] },
      ],
    },
    { status: "in-progress", cards: [] },
    { status: "blocked", cards: [] },
    {
      status: "in-review",
      cards: [
        { key: "SPWN-38", ref: "c4", title: "Approvals inbox v1", desc: "", status: "in-review", url: "https://trello.com", attachments: [] },
      ],
    },
    {
      status: "done",
      cards: [
        { key: "SPWN-30", ref: "c5", title: "Daemon auto-start from desktop app", desc: "", status: "done", url: "https://trello.com", attachments: [] },
        { key: "SPWN-29", ref: "c6", title: "Per-thread busy state", desc: "", status: "done", url: "https://trello.com", attachments: [] },
      ],
    },
  ],
};

const usage: UsageSummary = {
  days: 1,
  totalTokens: 1_240_000,
  totalCost: 14.6,
  turns: 38,
  threads: 9,
  byModel: [
    { model: "opus", tokens: 612_000 },
    { model: "sonnet", tokens: 465_000 },
    { model: "haiku", tokens: 163_000 },
  ],
  byProject: [
    { project: "spawnmy-ai", tokens: 742_000, turns: 24, threads: 5 },
    { project: "fable-engine", tokens: 386_000, turns: 11, threads: 3 },
    { project: "site-refresh", tokens: 112_000, turns: 3, threads: 1 },
  ],
  series: Array.from({ length: 14 }, (_, i) => ({
    ts: Date.now() - (13 - i) * 3600e3,
    tokens: [21, 15, 29, 43, 19, 51, 67, 45, 87, 73, 105, 81, 115, 142][i] * 1000,
  })),
  sessions: [
    { threadId: 10, title: "Team-lead console", project: "team-lead", kind: "teamlead", running: false, model: "opus", contextTokens: 92_000 },
    { threadId: 11, title: "Worktree GC on daemon boot", project: "spawnmy-ai", kind: "ticket", running: true, model: "opus", contextTokens: 84_000 },
    { threadId: 13, title: "Migrate sessions.json into SQLite", project: "fable-engine", kind: "ticket", running: false, model: "sonnet", contextTokens: 41_000 },
  ],
};

const ctxFor = (threadId: number): ThreadContext => {
  const t = threads.find((x) => x.id === threadId) ?? threads[0];
  const running = threadId === 11 || threadId === 12;
  return {
    threadId,
    kind: t.kind,
    status: t.status,
    branch: t.branch,
    worktreePath: t.worktree_path,
    git: t.branch ? { branch: t.branch, dirty: threadId === 13 ? 3 : 0, ahead: 3, behind: 0, lastCommit: "ac3b85a feat: gc worktrees on boot" } : null,
    pr:
      threadId === 12
        ? { number: 212, url: "https://github.com", state: "OPEN", checks: "passing" }
        : null,
    process: running ? { running: true, pid: 48112, startedAt: Date.now() - 840e3, model: "opus" } : { running: false },
    cost: { totalUsd: 3.12, turns: 12, lastContextTokens: 84_000, lastModel: "opus" },
  };
};

const settingsByProject = new Map<number, ProjectSettings>();
const defaultSettings = (): ProjectSettings => ({
  approvalMode: "prompt",
  allowedModels: ["haiku", "sonnet", "opus"],
  defaultModel: "sonnet",
  defaultEffort: "medium",
  isolation: true,
  mcpServers: [
    { name: "trello", transport: "stdio", command: "npx @spawn/mcp-trello", enabled: true },
    { name: "sentry", transport: "http", url: "https://mcp.sentry.dev", enabled: false },
  ],
  disabledSkills: ["deck-builder"],
  rules: "Always open a PR — never push to main.\nRun npm test before committing.",
  memory: "Staging lives at staging.spawnmy.dev. Marc reviews all schema changes.",
  connections: [
    { id: "c1", type: "google-account", label: "prod", value: "marc@spawnmy.ai", url: "https://console.cloud.google.com" },
    { id: "c2", type: "firebase", label: "prod", value: "spawnmy-prod", url: "https://console.firebase.google.com", secretEnv: "FIREBASE_TOKEN" },
    { id: "c3", type: "supabase", label: "", value: "xyzabc123ref", secretEnv: "SUPABASE_ACCESS_TOKEN" },
    { id: "c4", type: "vercel", label: "web", value: "spawnmy-web", url: "https://vercel.com/spawnmy" },
    { id: "c5", type: "heroku", label: "api", value: "spawnmy-api" },
  ],
});

const map: MapData = {
  teamLeadProjectId: 4,
  projects: projects.filter((p) => [1, 2, 4].includes(p.id)),
  threads: [
    { id: 11, projectId: 1, kind: "ticket", title: "Worktree GC on daemon boot", status: "active", branch: "ticket/11-worktree-gc", worktreePath: "…", dirty: 0, running: true, pid: 48112, model: "opus", costUsd: 3.12, turns: 12, pr: null },
    { id: 12, projectId: 1, kind: "ticket", title: "Stream tool output", status: "active", branch: "ticket/12-stream-tools", worktreePath: "…", dirty: 0, running: true, pid: 48520, model: "sonnet", costUsd: 0.94, turns: 5, pr: { number: 212, url: "https://github.com", state: "OPEN", checks: "passing" } },
    { id: 13, projectId: 2, kind: "ticket", title: "Migrate sessions → SQLite", status: "active", branch: "ticket/13-sqlite-sessions", worktreePath: "…", dirty: 3, running: false, pid: null, model: null, costUsd: 1.7, turns: 8, pr: null },
  ],
};

export function installMock() {
  window.spawn = {
    listProjects: async () => projects,
    listThreads: async (projectId) => threads.filter((t) => t.project_id === projectId),
    createThread: async ({ projectId, title, kind }) =>
      mkThread(90 + Math.floor(Math.random() * 100), projectId, (kind as Thread["kind"]) ?? "chat", title || "New thread"),
    renameThread: async (threadId, title) => ({ ...threads[0], id: threadId, title }),
    listMessages: async (threadId) => messages.filter((m) => m.thread_id === threadId),
    sendMessage: async (threadId) => ({ threadId, started: true }),
    cancelTurn: async () => true,
    resolveApproval: async () => true,
    getProjectSettings: async (projectId) => settingsByProject.get(projectId) ?? defaultSettings(),
    updateProjectSettings: async (projectId, patch) => {
      const next = { ...(settingsByProject.get(projectId) ?? defaultSettings()), ...patch } as ProjectSettings;
      settingsByProject.set(projectId, next);
      return next;
    },
    getBoard: async () => board,
    getTeamLeadProject: async () => projects[3],
    delegateTask: async ({ projectId, task }) => mkThread(91, projectId, "ticket", task.split("\n")[0].slice(0, 40), "ticket/91-mock"),
    listActiveThreads: async () => activeThreads,
    getThreadContext: async (threadId) => ctxFor(threadId),
    cleanupThread: async () => ({ ok: true }),
    getMap: async () => map,
    listApprovals: async () => approvals,
    listDecisions: async () => decisions,
    getUsage: async () => usage,
    resetThreadSession: async () => true,
    listSkills: async (projectId) => {
      const disabled = new Set((settingsByProject.get(projectId) ?? defaultSettings()).disabledSkills);
      return [
        { name: "code-review", scope: "project" as const, description: "Review the diff", enabled: !disabled.has("code-review") },
        { name: "release-notes", scope: "project" as const, description: "Draft release notes", enabled: !disabled.has("release-notes") },
        { name: "deck-builder", scope: "user" as const, description: "Build slide decks", enabled: !disabled.has("deck-builder") },
        { name: "pdf-reader", scope: "user" as const, description: "Read PDFs", enabled: !disabled.has("pdf-reader") },
      ];
    },
    onEvent: () => () => {},
  };
}
