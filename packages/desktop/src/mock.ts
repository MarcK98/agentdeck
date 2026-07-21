import type {
  ActiveThread,
  ApprovalDecision,
  ApprovalRequest,
  Ticket,
  TicketComment,
  TicketAttachment,
  TicketDetail,
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
  liveTokens: t.id === 11 ? 312_000 : t.id === 12 ? 58_000 : null,
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
    // Markdown + fenced code so the browser harness exercises the real
    // ReactMarkdown + highlight.js renderer (headings, lists, inline code,
    // copy button) — every other fixture message is plain prose.
    id: 5,
    thread_id: 11,
    role: "assistant",
    text: [
      "Here's the boot hook. It runs **after** session restore so the board is authoritative:",
      "",
      "```js",
      "async function gcWorktrees(db, board) {",
      "  const done = new Set(await board.ticketsInState(['done', 'archived']));",
      "  for (const wt of await listWorktrees()) {",
      "    if (done.has(wt.ticketId) && !wt.dirty) {",
      "      await removeWorktree(wt.path);   // branch is kept — only the checkout goes",
      "      db.markThreadArchived(wt.threadId);",
      "    }",
      "  }",
      "}",
      "```",
      "",
      "### What it does",
      "- Scans `worktrees/` and cross-checks each against the board",
      "- Skips any worktree with **uncommitted changes** (`wt.dirty`)",
      "- Preserves every branch — only the on-disk checkout is removed",
      "",
      "Wired into `daemon/boot.js` right after `restoreSessions()`.",
    ].join("\n"),
    tool_name: null,
    tool_input: null,
    seq: 2,
    created_at: "2026-07-17T14:27:00Z",
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

const mkTicket = (
  id: number,
  projectId: number,
  title: string,
  status: Ticket["status"],
  threadId: number | null = null,
  branch: string | null = null,
  running = false
): Ticket => ({
  id,
  project_id: projectId,
  thread_id: threadId,
  title,
  body: "",
  status,
  created_at: "2026-07-17T10:00:00Z",
  updated_at: "2026-07-17T14:20:00Z",
  project_name: projects.find((p) => p.id === projectId)?.name ?? "?",
  branch,
  thread_status: threadId ? "active" : null,
  running,
});

let tickets: Ticket[] = [
  mkTicket(41, 1, "Rate-limit the delegate tool per project", "todo"),
  mkTicket(44, 1, "Usage export as CSV", "todo"),
  mkTicket(7, 2, "Dark-launch fable for the engine repo", "todo"),
  mkTicket(11, 1, "Worktree GC on daemon boot", "in-progress", 11, "ticket/11-worktree-gc", true),
  mkTicket(12, 1, "Stream tool output into thread view", "in-progress", 12, "ticket/12-stream-tools", true),
  mkTicket(13, 2, "Migrate sessions.json into SQLite", "blocked", 13, "ticket/13-sqlite-sessions"),
  mkTicket(38, 1, "Approvals inbox v1", "in-review", 14, "ticket/38-approvals-inbox"),
  mkTicket(30, 1, "Daemon auto-start from desktop app", "done"),
  mkTicket(29, 1, "Per-thread busy state", "done"),
];

let mockCommentId = 700;
let mockAttachmentId = 800;
const commentsByTicket = new Map<number, TicketComment[]>([
  [
    11,
    [
      { id: 501, ticket_id: 11, author_kind: "human", author_name: "you", body: "Make sure branches survive the GC.", created_at: "2026-07-19T10:00:00Z" },
      { id: 502, ticket_id: 11, author_kind: "lead", author_name: "team lead", body: "On it — delegated with the branch-preserve constraint.", created_at: "2026-07-19T10:01:00Z" },
      { id: 503, ticket_id: 11, author_kind: "agent", author_name: "agent", body: "GC hooked into boot; branches kept. PR open.", created_at: "2026-07-19T10:40:00Z" },
    ],
  ],
]);
const attachmentsByTicket = new Map<number, TicketAttachment[]>([
  [
    11,
    [
      { id: 601, ticket_id: 11, name: "gc-report.md", path: "~/dev/deliverables/spawnmy-ai/SPWN-11/gc-report.md", size: 2048, uploaded_by: "agent", created_at: "2026-07-19T10:41:00Z" },
    ],
  ],
]);

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
    process: running
      ? { running: true, pid: 48112, startedAt: Date.now() - 840e3, model: "opus", liveTokens: 312_000 }
      : { running: false },
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

let clipReads = 0; // mock clipboard read counter (token-capture flow)

// Real event bus: mutations emit the same events the daemon would, so the
// browser harness exercises streaming, busy states, unread badges and the
// approvals flow instead of dead-ending on no-ops.
type MockHandler = (ev: { type: string; payload: any }) => void;
const handlers = new Set<MockHandler>();
const emit = (type: string, payload: any) => {
  handlers.forEach((h) => h({ type, payload }));
};
let nextMsgId = 1000;
const appendMessage = (threadId: number, role: Message["role"], text: string, seq: number): Message => {
  const m: Message = {
    id: nextMsgId++,
    thread_id: threadId,
    role,
    text,
    tool_name: null,
    tool_input: null,
    seq,
    created_at: new Date().toISOString(),
  };
  messages.push(m);
  return m;
};
// Fake a streamed agent reply: turn:start → token deltas → turn:text → turn:done.
const streamReply = (threadId: number, reply: string) => {
  emit("turn:start", { threadId });
  const words = reply.split(" ");
  let i = 0;
  const tick = () => {
    if (i < words.length) {
      emit("turn:delta", { threadId, text: (i === 0 ? "" : " ") + words[i] });
      i++;
      setTimeout(tick, 40);
    } else {
      const m = appendMessage(threadId, "assistant", reply, 99);
      emit("turn:text", { threadId, message: m });
      emit("turn:done", { threadId, queued: 0 });
    }
  };
  setTimeout(tick, 350);
};

export function installMock() {
  window.spawn = {
    listProjects: async () => projects,
    listThreads: async (projectId) => threads.filter((t) => t.project_id === projectId),
    listAllThreads: async () =>
      threads.map((t) => ({ ...t, project_name: projects.find((p) => p.id === t.project_id)?.name ?? "?" })),
    createThread: async ({ projectId, title, kind }) => {
      const t = mkThread(90 + Math.floor(Math.random() * 100), projectId, (kind as Thread["kind"]) ?? "chat", title || "New thread");
      threads.push(t);
      emit("thread:created", { id: t.id });
      return t;
    },
    renameThread: async (threadId, title) => ({ ...threads[0], id: threadId, title }),
    setThreadStatus: async (threadId, status) => ({ ...threads[0], id: threadId, status }),
    deleteThread: async () => ({ ok: true }),
    listMessages: async (threadId) => messages.filter((m) => m.thread_id === threadId),
    sendMessage: async (threadId, text) => {
      appendMessage(threadId, "user", text, 98);
      streamReply(threadId, "Understood — I'll fold that in. Working on it now; I'll report back when the change is verified.");
      return { threadId, started: true };
    },
    cancelTurn: async () => true,
    resolveApproval: async (id, allow) => {
      const idx = approvals.findIndex((a) => a.id === id);
      if (idx >= 0) {
        const [a] = approvals.splice(idx, 1);
        decisions.unshift({ ...a, allow, at: Date.now() });
        emit("approval:resolved", { id });
      }
      return true;
    },
    // Clone on read to mirror the daemon's JSON-RPC boundary (fresh object each
    // call) — otherwise React bails on setSettings with the same mutated ref.
    getProjectSettings: async (projectId) =>
      structuredClone(settingsByProject.get(projectId) ?? defaultSettings()),
    updateProjectSettings: async (projectId, patch) => {
      const next = { ...(settingsByProject.get(projectId) ?? defaultSettings()), ...patch } as ProjectSettings;
      settingsByProject.set(projectId, next);
      return next;
    },
    setProjectMcpSecret: async (projectId, serverName, envKey, value) => {
      const s = settingsByProject.get(projectId) ?? defaultSettings();
      s.mcpServers = s.mcpServers.map((m) =>
        m.name === serverName
          ? {
              ...m,
              secretsSet: value.trim()
                ? Array.from(new Set([...(m.secretsSet ?? []), envKey]))
                : (m.secretsSet ?? []).filter((k) => k !== envKey),
            }
          : m
      );
      settingsByProject.set(projectId, s);
      return true;
    },
    clearProjectMcpSecret: async (projectId, serverName, envKey) => {
      const s = settingsByProject.get(projectId) ?? defaultSettings();
      s.mcpServers = s.mcpServers.map((m) =>
        m.name === serverName ? { ...m, secretsSet: (m.secretsSet ?? []).filter((k) => k !== envKey) } : m
      );
      settingsByProject.set(projectId, s);
      return true;
    },
    openExternal: async (url) => {
      console.info("[mock] openExternal", url);
      clipReads = 0; // reset so the next token-capture baseline read is empty
    },
    // Mock clipboard: empty on the baseline read, then a fake token — so the
    // token-page capture flow (baseline-diff) completes in the browser harness.
    readClipboard: async () => (clipReads++ === 0 ? "" : "sbp_mockclipboardtoken_0000"),
    pickFile: async () => "/Users/you/Downloads/AuthKey_MOCK123.p8",
    connectGcloud: async (projectId, serverName) => {
      const account = "marc@spawnmy.ai";
      const s = settingsByProject.get(projectId) ?? defaultSettings();
      s.mcpServers = s.mcpServers.map((m) =>
        m.name === serverName ? { ...m, account, credDir: `/mock/creds/gcloud/${serverName}` } : m
      );
      settingsByProject.set(projectId, s);
      return { ok: true, account };
    },
    importAppleKey: async (projectId, serverName) => {
      const s = settingsByProject.get(projectId) ?? defaultSettings();
      s.mcpServers = s.mcpServers.map((m) =>
        m.name === serverName
          ? { ...m, secretsSet: Array.from(new Set([...(m.secretsSet ?? []), "APP_STORE_CONNECT_P8_PATH"])) }
          : m
      );
      settingsByProject.set(projectId, s);
      return { ok: true, path: "/mock/creds/apple/AuthKey.p8" };
    },
    disconnectProvider: async (projectId, serverName) => {
      const s = settingsByProject.get(projectId) ?? defaultSettings();
      s.mcpServers = s.mcpServers.map((m) =>
        m.name === serverName ? { ...m, account: undefined, credDir: undefined, secretsSet: [] } : m
      );
      settingsByProject.set(projectId, s);
      return { ok: true };
    },
    listTickets: async () => tickets,
    createTicket: async ({ projectId, title, body, status }) => {
      const t = mkTicket(Math.floor(Math.random() * 1000) + 100, projectId, title, status ?? "todo");
      t.body = body ?? "";
      tickets = [t, ...tickets];
      return t;
    },
    updateTicket: async (ticketId, patch) => {
      tickets = tickets.map((t) => (t.id === ticketId ? { ...t, ...patch } : t));
      return tickets.find((t) => t.id === ticketId)!;
    },
    deleteTicket: async (ticketId) => {
      tickets = tickets.filter((t) => t.id !== ticketId);
      return true;
    },
    delegateTicket: async (ticketId) => {
      const t = tickets.find((x) => x.id === ticketId)!;
      const id = 90 + Math.floor(Math.random() * 900);
      tickets = tickets.map((x) =>
        x.id === ticketId ? { ...x, status: "in-progress" as const, thread_id: id, running: true } : x
      );
      const th = mkThread(id, t.project_id, "ticket", t.title, `ticket/${id}-mock`);
      threads.push(th);
      activeThreads.push({
        ...th,
        project_name: projects.find((p) => p.id === t.project_id)?.name ?? "?",
        running: true,
        liveTokens: 900,
      });
      emit("thread:created", { id });
      streamReply(id, "Reading the ticket and starting on it now.");
      return th;
    },
    getTicket: async (ticketId): Promise<TicketDetail> => {
      const t = tickets.find((x) => x.id === ticketId)!;
      return {
        ...t,
        comments: commentsByTicket.get(ticketId) ?? [],
        attachments: attachmentsByTicket.get(ticketId) ?? [],
      };
    },
    listTicketComments: async (ticketId) => commentsByTicket.get(ticketId) ?? [],
    addTicketComment: async (ticketId, body) => {
      const c: TicketComment = {
        id: ++mockCommentId,
        ticket_id: ticketId,
        author_kind: "human",
        author_name: "you",
        body,
        created_at: "2026-07-20T12:00:00Z",
      };
      commentsByTicket.set(ticketId, [...(commentsByTicket.get(ticketId) ?? []), c]);
      // Board-flow rule (mirrors the daemon): a human comment on a ticket
      // awaiting review is fresh feedback — pull it back into in-progress.
      const reviewed = tickets.find((x) => x.id === ticketId);
      if (reviewed?.status === "in-review") {
        const moved = { ...reviewed, status: "in-progress" as const };
        tickets = tickets.map((x) => (x.id === ticketId ? moved : x));
        emit("ticket:updated", moved);
      }
      // Fake the team lead acknowledging, so the loop is visible in browser QA.
      const ack: TicketComment = {
        id: ++mockCommentId,
        ticket_id: ticketId,
        author_kind: "lead",
        author_name: "team lead",
        body: "Got it — taking a look and I'll delegate this.",
        created_at: "2026-07-20T12:00:05Z",
      };
      commentsByTicket.set(ticketId, [...(commentsByTicket.get(ticketId) ?? []), ack]);
      return c;
    },
    listTicketAttachments: async (ticketId) => attachmentsByTicket.get(ticketId) ?? [],
    addTicketAttachment: async (ticketId, sourcePath) => {
      const name = sourcePath.split("/").pop() || "file";
      const a: TicketAttachment = {
        id: ++mockAttachmentId,
        ticket_id: ticketId,
        name,
        path: sourcePath,
        size: 1024,
        uploaded_by: "you",
        created_at: "2026-07-20T12:01:00Z",
      };
      attachmentsByTicket.set(ticketId, [...(attachmentsByTicket.get(ticketId) ?? []), a]);
      return a;
    },
    getTeamLeadProject: async () => projects[3],
    delegateTask: async ({ projectId, task }) => {
      const id = 90 + Math.floor(Math.random() * 900);
      const title = task.split("\n")[0].slice(0, 40);
      const t = mkThread(id, projectId, "ticket", title, `ticket/${id}-mock`);
      threads.push(t);
      activeThreads.push({
        ...t,
        project_name: projects.find((p) => p.id === projectId)?.name ?? "?",
        running: true,
        liveTokens: 1200,
      });
      tickets = [mkTicket(id, projectId, title, "in-progress", id, t.branch, true), ...tickets];
      emit("thread:created", { id });
      appendMessage(id, "user", task, 0);
      streamReply(id, "Picked up the task — scoping it now and starting on a branch.");
      return t;
    },
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
    listDeliverables: async (threadId) =>
      threadId === 11
        ? {
            dir: "~/dev/deliverables/spawnmy-ai/SPWN-11",
            files: [
              { path: "/tmp/report.pdf", name: "gc-analysis.pdf", size: 482_000, mtime: Date.now() },
              { path: "/tmp/data.xlsx", name: "worktree-audit.xlsx", size: 61_000, mtime: Date.now() - 3600e3 },
            ],
          }
        : { dir: null, files: [] },
    openDir: async () => {},
    revealFile: async () => {},
    // No native notifications in a plain browser — no-ops keep the harness happy.
    setNotificationsEnabled: async () => {},
    testNotification: async () => {},
    onEvent: (h) => {
      handlers.add(h as MockHandler);
      return () => handlers.delete(h as MockHandler);
    },
  };
}
