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
export interface ProjectSettings {
  approvalMode: "prompt" | "auto";
  allowedModels: string[];
  defaultModel: string;
  mcps: string[];
  skills: string[];
}

// A pending permission prompt from a run in "prompt" approval mode.
export interface ApprovalRequest {
  id: number;
  threadId: number;
  tool: string;
  input: Record<string, unknown>;
}

export type SpawnEvent =
  | { type: "thread:created"; payload: Thread }
  | { type: "thread:updated"; payload: Thread }
  | { type: "turn:start"; payload: { threadId: number } }
  | { type: "turn:text"; payload: { threadId: number; message: Message } }
  | { type: "turn:tool"; payload: { threadId: number; message: Message } }
  | {
      type: "turn:done";
      payload: { threadId: number; ok: boolean; cancelled: boolean; contextTokens: number | null };
    }
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
      onEvent(fn: (ev: SpawnEvent) => void): () => void;
    };
  }
}
