// Mirrors @spawn/core daemon rows/events (the IPC payloads are the SQLite rows).

export interface Project {
  id: number;
  name: string;
  dir: string;
  created_at: string;
}

export interface Thread {
  id: number;
  project_id: number;
  kind: "chat" | "ticket" | "teamlead";
  title: string;
  ticket_key: string | null;
  branch: string | null;
  worktree_path: string | null;
  status: "active" | "done" | "blocked" | "archived";
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: number;
  thread_id: number;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  tool_name: string | null;
  tool_input: string | null;
  seq: number;
  created_at: string;
}

// Client-visible per-project settings (daemon/project-settings.js — secrets
// never appear here by construction).
// One per-project MCP server (settings page). `command` is a single
// shell-like line for stdio servers; `url` for http. No env/secrets stored.
export interface McpServerDef {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  url?: string;
  enabled: boolean;
}

// One per-project connection: an account, cloud project, or deploy target
// this project is wired to. `value` is the non-secret identifier (email,
// project id, app name); `secretEnv` names the daemon env var carrying its
// token — the token itself is never stored.
export interface Connection {
  id: string;
  type: string; // key into CONNECTION_TYPES, or free-form
  label: string;
  value: string;
  url?: string;
  secretEnv?: string;
  notes?: string;
}

export interface ProjectSettings {
  approvalMode: "prompt" | "auto";
  allowedModels: string[];
  defaultModel: string;
  defaultEffort: string;
  isolation: boolean;
  mcpServers: McpServerDef[];
  disabledSkills: string[];
  rules: string;
  memory: string;
  connections: Connection[];
}

// A discovered skill (project .claude/skills or user ~/.claude/skills),
// with its per-project enablement resolved (daemon listSkills).
export interface SkillInfo {
  name: string;
  scope: "project" | "user";
  description: string;
  enabled: boolean;
}

// A pending permission prompt from a run in "prompt" approval mode.
export interface ApprovalRequest {
  id: number;
  threadId: number;
  tool: string;
  input: Record<string, unknown>;
}

// A native board ticket (daemon listTickets) — the source of truth. Backlog
// tickets have no thread yet; delegation links one, and the daemon moves
// status automatically (delegate → in-progress, run ok → in-review, run
// failed → blocked). `running`/`branch` are joined live thread state.
export type TicketStatus = "todo" | "in-progress" | "blocked" | "in-review" | "done";

export interface Ticket {
  id: number;
  project_id: number;
  thread_id: number | null;
  title: string;
  body: string;
  status: TicketStatus;
  created_at: string;
  updated_at: string;
  project_name: string;
  branch: string | null;
  thread_status: Thread["status"] | null;
  running: boolean;
}

// A thread row joined with its project name (daemon listActiveThreads).
// `running` is live process truth from the daemon, not event-derived.
export interface ActiveThread extends Thread {
  project_name: string;
  running: boolean;
}

// ── Per-thread context (daemon getThreadContext) — the Phase-3 isolation
// panel: branch/worktree/PR + live process + cumulative cost.
export interface ThreadGit {
  branch: string;
  dirty: number; // uncommitted paths in the worktree
  ahead: number;
  behind: number;
  lastCommit: string | null; // "abc1234 subject"
}

export interface ThreadPr {
  number: number;
  url: string;
  state: string; // OPEN | MERGED | CLOSED
  checks: "passing" | "failing" | "pending" | null;
}

export interface ThreadContext {
  threadId: number;
  kind: Thread["kind"];
  status: Thread["status"];
  branch: string | null;
  worktreePath: string | null;
  git: ThreadGit | null;
  pr: ThreadPr | null;
  process:
    | { running: true; pid: number; startedAt: number; model: string | null }
    | { running: false };
  cost: {
    totalUsd: number;
    turns: number;
    lastContextTokens: number | null;
    lastModel: string | null;
  };
}

export type CleanupResult =
  | { ok: true }
  | { ok: false; reason: string; dirty?: number };

// ── Live map (daemon getMap) — Phase 4. One thread node's worth of state:
// getThreadContext-lite, joined across every active thread.
export interface MapThread {
  id: number;
  projectId: number;
  kind: Thread["kind"];
  title: string;
  status: Thread["status"];
  branch: string | null;
  worktreePath: string | null;
  dirty: number | null;
  running: boolean;
  pid: number | null;
  model: string | null;
  costUsd: number;
  turns: number;
  pr: ThreadPr | null;
}

export interface MapData {
  teamLeadProjectId: number | null;
  projects: { id: number; name: string; dir: string }[];
  threads: MapThread[];
}

// A settled approval, newest first (daemon listDecisions — in-memory trail).
export interface ApprovalDecision extends ApprovalRequest {
  allow: boolean;
  at: number;
}

// Usage rollup (daemon getUsage).
export interface UsageSummary {
  days: number;
  totalTokens: number;
  totalCost: number;
  turns: number;
  threads: number;
  byModel: { model: string; tokens: number }[];
  byProject: { project: string; tokens: number; turns: number; threads: number }[];
  series: { ts: number; tokens: number }[];
  sessions: {
    threadId: number;
    title: string;
    project: string;
    kind: Thread["kind"];
    running: boolean;
    model: string | null;
    contextTokens: number | null;
  }[];
}

export type SpawnEvent =
  | { type: "thread:created"; payload: Thread }
  | { type: "thread:updated"; payload: Thread }
  | { type: "turn:start"; payload: { threadId: number } }
  | { type: "turn:delta"; payload: { threadId: number; text: string } }
  | { type: "turn:text"; payload: { threadId: number; message: Message } }
  | { type: "turn:tool"; payload: { threadId: number; message: Message } }
  | {
      type: "turn:done";
      payload: { threadId: number; ok: boolean; cancelled: boolean; contextTokens: number | null };
    }
  | { type: "ticket:created"; payload: Ticket }
  | { type: "ticket:updated"; payload: Ticket }
  | { type: "ticket:deleted"; payload: { id: number } }
  | { type: "approval:request"; payload: ApprovalRequest }
  | { type: "approval:resolved"; payload: { id: number; threadId: number; allow: boolean } };

declare global {
  interface Window {
    spawn: {
      listProjects(): Promise<Project[]>;
      listThreads(projectId: number): Promise<Thread[]>;
      createThread(args: { projectId: number; title?: string; kind?: string }): Promise<Thread>;
      renameThread(threadId: number, title: string): Promise<Thread>;
      listMessages(threadId: number, opts?: { limit?: number }): Promise<Message[]>;
      sendMessage(threadId: number, text: string): Promise<{ threadId: number; started: boolean }>;
      cancelTurn(threadId: number): Promise<boolean>;
      resolveApproval(
        id: number,
        allow: boolean,
        updatedInput?: Record<string, unknown>
      ): Promise<boolean>;
      getProjectSettings(projectId: number): Promise<ProjectSettings>;
      updateProjectSettings(
        projectId: number,
        patch: Partial<ProjectSettings>
      ): Promise<ProjectSettings>;
      listTickets(): Promise<Ticket[]>;
      createTicket(args: {
        projectId: number;
        title: string;
        body?: string;
        status?: TicketStatus;
      }): Promise<Ticket>;
      updateTicket(ticketId: number, patch: Partial<Pick<Ticket, "title" | "body" | "status">>): Promise<Ticket>;
      deleteTicket(ticketId: number): Promise<boolean>;
      delegateTicket(ticketId: number, opts?: { model?: string; effort?: string }): Promise<Thread>;
      getTeamLeadProject(): Promise<Project | null>;
      delegateTask(args: {
        projectId: number;
        task: string;
        model?: string;
        effort?: string;
        title?: string;
      }): Promise<Thread>;
      listActiveThreads(): Promise<ActiveThread[]>;
      getThreadContext(threadId: number): Promise<ThreadContext>;
      cleanupThread(threadId: number, force?: boolean): Promise<CleanupResult>;
      getMap(): Promise<MapData>;
      listApprovals(): Promise<ApprovalRequest[]>;
      listDecisions(): Promise<ApprovalDecision[]>;
      getUsage(days?: number): Promise<UsageSummary>;
      resetThreadSession(threadId: number): Promise<boolean>;
      listSkills(projectId: number): Promise<SkillInfo[]>;
      onEvent(fn: (ev: SpawnEvent) => void): () => void;
    };
  }
}
