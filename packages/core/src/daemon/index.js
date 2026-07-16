import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  askClaude,
  cancelRun,
  resetSession,
  getLastStats,
  pauseInactivity,
  resumeInactivity,
} from "../claude.js";
import { getOverrides, resolveProject } from "../projects.js";
// Board access is READ-ONLY by design: only isEnabled/readBoard (stateless
// Trello GETs). The daemon must never start the Trello poller/webhook or write
// cards — the Discord bridge owns board sync during the migration, and a
// second writer would race it.
import { isEnabled as trelloEnabled, readBoard } from "../trello.js";
import * as db from "../db/index.js";
import { getProjectSettings, updateProjectSettings } from "./project-settings.js";
import { createApprovalHub } from "./approvals.js";

// The Spawn daemon — a mastermind for Claude. This is the ONE API clients talk
// through; it runs as its OWN background process (server.js) and owns sessions,
// threads, and the SQLite store. The desktop app is just a client.
//
// It is wired DIRECTLY to Claude Code (claude.js) — Spawn orchestrates Claude,
// it is not a multi-provider platform, so there is deliberately no provider
// abstraction between here and the spawn/stream pipeline.
//
// Method-surface rules (so the local HTTP/WS transport in server.js — and any
// future remote transport — can expose it mechanically):
//   - every method takes/returns JSON-serializable values only
//   - streaming happens via the `events` emitter, never callbacks in args
//   - secrets NEVER appear in a method result or event — they stay
//     daemon-side; see project-settings.js
//
// sessionKey convention: "spawn:thread:<threadId>" — parallel threads never
// share a key, so Claude-run serialization applies per thread, not per
// project (the per-ticket isolation model).

const threadKey = (threadId) => `spawn:thread:${threadId}`;

export function createDaemon() {
  const events = new EventEmitter();
  const emit = (type, payload) => events.emit("event", { type, payload });

  // Approval hub: receives permission prompts from runs started in "prompt"
  // mode (see approvals.js) and surfaces them as approval:* events; clients
  // answer via resolveApproval below.
  const hub = createApprovalHub({
    emit,
    pauseInactivity,
    resumeInactivity,
    timeoutMs: config.approvals.timeoutMs,
  });

  // ── Projects: union of dirs under PROJECTS_ROOT and projects.json overrides,
  // mirrored into SQLite so threads can reference them.
  const discoverProjects = () => {
    const root = config.projects.root;
    const dirs = new Map(); // name -> dir
    if (root) {
      try {
        for (const entry of readdirSync(root)) {
          if (entry.startsWith(".")) continue;
          const dir = join(root, entry);
          try {
            if (statSync(dir).isDirectory()) dirs.set(entry, dir);
          } catch {
            /* unreadable entry */
          }
        }
      } catch (err) {
        log.warn(`Spawn daemon: cannot read PROJECTS_ROOT ${root}: ${err.message}`);
      }
    }
    for (const [name, dir] of Object.entries(getOverrides())) {
      dirs.set(basename(name), dir);
    }
    return [...dirs].map(([name, dir]) => db.upsertProject(name, dir));
  };

  // The team-lead's home project: TEAMLEAD_CHANNEL resolved like any bridge
  // channel (override by name, else <PROJECTS_ROOT>/<name>). Null when unset
  // or unresolvable — the client shows a "set TEAMLEAD_CHANNEL" note instead.
  const resolveTeamLeadProject = () => {
    const channel = process.env.TEAMLEAD_CHANNEL;
    if (!channel) return null;
    const dir = resolveProject({ channelName: channel });
    return dir ? db.upsertProject(basename(dir), dir) : null;
  };

  // Launch one Claude turn in a thread and stream it out as events:
  //   turn:start {threadId} → turn:text {threadId,message}* / turn:tool
  //   {threadId,message}* → turn:done {threadId, ok, ...}
  // `message` is the persisted row (same shape as listMessages rows), so
  // clients append incrementally instead of re-pulling history. Callers insert
  // their own prompting rows first (sendMessage: the user's text; delegateTask:
  // the task) — promptText is what actually goes to Claude.
  const launchTurn = (thread, project, promptText, opts = {}) => {
    const threadId = thread.id;
    const settings = getProjectSettings(project.id);
    emit("turn:start", { threadId });

    let seq = 0;
    const done = askClaude(
      threadKey(threadId),
      promptText,
      thread.worktree_path || project.dir,
      (t) => {
        const message = db.addMessage({ threadId, role: "assistant", text: t, seq: seq++ });
        emit("turn:text", { threadId, message });
      },
      {
        // An explicit per-turn model/effort (delegation right-sizing) beats the
        // project default — same precedence claude.js applies internally.
        model: opts.model || settings.defaultModel || undefined,
        effort: opts.effort || undefined,
        // ticket threads are ephemeral (fresh context per ticket); chat and
        // teamlead threads resume across turns
        persistSessions: thread.kind !== "ticket",
        // Approval routing (per-project): "prompt" surfaces permission
        // prompts as approval:* events via the hub; "auto" runs unattended.
        // Prompt mode pins permissionMode to "" — a CLAUDE_PERMISSION_MODE
        // of bypassPermissions (the bridge's usual .env) would otherwise
        // leak in and silently skip every prompt.
        ...(settings.approvalMode === "auto"
          ? { approvals: false, permissionMode: "bypassPermissions" }
          : { approvals: true, approvalPort: hub.port, permissionMode: "" }),
        onProgress: ({ tool, input }) => {
          const message = db.addMessage({ threadId, role: "tool", toolName: tool, toolInput: input, seq: seq++ });
          emit("turn:tool", { threadId, message });
        },
        meta: { source: opts.source || "spawn-daemon", threadId },
      }
    );

    done.then((res) => {
      // Final text arrives via onText already when streamed; store the result
      // only if nothing streamed (e.g. an error string) — and ship the row so
      // clients (who no longer re-pull on turn:done) still see it.
      if (res.text && !res.streamed) {
        const message = db.addMessage({ threadId, role: res.ok ? "assistant" : "system", text: res.text, seq: seq++ });
        emit("turn:text", { threadId, message });
      }
      emit("turn:done", {
        threadId,
        ok: res.ok,
        cancelled: res.cancelled ?? false,
        contextTokens: res.contextTokens ?? null,
      });
    });

    return { threadId, started: true };
  };

  return {
    events,

    // Not a method (server.js only exposes functions) — lets the transport
    // close the hub's socket on shutdown without putting close() on the RPC
    // surface.
    _approvalHub: hub,

    listProjects: () => {
      discoverProjects();
      return db.listProjects();
    },

    getProjectSettings: (projectId) => getProjectSettings(projectId),
    updateProjectSettings: (projectId, patch) => updateProjectSettings(projectId, patch),

    listThreads: (projectId) => db.listThreads(projectId),
    getThread: (threadId) => db.getThread(threadId),
    listMessages: (threadId, opts) => db.listMessages(threadId, opts),

    createThread: ({ projectId, title, kind = "chat", ticketKey = null }) => {
      // Untitled is fine — the first message auto-titles it (see sendMessage).
      const thread = db.createThread({ projectId, kind, title: title || "New thread", ticketKey });
      emit("thread:created", thread);
      return thread;
    },

    renameThread: (threadId, title) => {
      const t = db.updateThread(threadId, { title });
      emit("thread:updated", t);
      return t;
    },

    // Send one user turn into a thread; Claude's reply streams out via
    // launchTurn (see above for the event contract).
    sendMessage: (threadId, text) => {
      const thread = db.getThread(threadId);
      if (!thread) throw new Error(`No such thread: ${threadId}`);
      const project = db.listProjects().find((p) => p.id === thread.project_id);
      if (!project) throw new Error(`Thread ${threadId} has no project`);

      // Auto-title: a first message into a placeholder-titled thread names it
      // (first line, clipped), so the thread list reads like an index.
      const autoTitled =
        !thread.title || thread.title === "New thread" || thread.title.startsWith("Thread ");
      if (autoTitled && db.listMessages(threadId, { limit: 1 }).length === 0) {
        const line = text.trim().split("\n")[0].trim();
        const title = line.length > 48 ? `${line.slice(0, 47)}…` : line;
        if (title) emit("thread:updated", db.updateThread(threadId, { title }));
      }

      db.addMessage({ threadId, role: "user", text });
      return launchTurn(thread, project, text);
    },

    // The team-lead's board, read-only. Trello when wired (bucketed into the
    // five configured columns), else the team-lead project's TASKS.md verbatim,
    // else nothing — and never a throw, so the client can always render it.
    getBoard: async () => {
      if (trelloEnabled()) {
        try {
          const r = await readBoard({ limit: 20 });
          if (r.ok) {
            // Column order = config.trello.lists key order (todo → done).
            // A card whose status is a raw list name (or null) still shows —
            // filed under todo rather than dropped.
            const columns = Object.keys(config.trello.lists).map((status) => ({ status, cards: [] }));
            const byStatus = new Map(columns.map((c) => [c.status, c]));
            for (const card of r.cards) {
              (byStatus.get(card.status) ?? byStatus.get("todo")).cards.push(card);
            }
            return { source: "trello", columns, comments: r.comments };
          }
          log.warn(`Spawn daemon: board read failed (${r.error}) — falling back to TASKS.md`);
        } catch (err) {
          log.warn(`Spawn daemon: board read failed (${err.message}) — falling back to TASKS.md`);
        }
      }
      const tl = resolveTeamLeadProject();
      if (tl) {
        try {
          return { source: "tasks-md", text: readFileSync(join(tl.dir, "TASKS.md"), "utf8") };
        } catch {
          /* no TASKS.md */
        }
      }
      return { source: "none" };
    },

    getTeamLeadProject: () => resolveTeamLeadProject(),

    // Delegate a task from the team-lead workspace: an ephemeral ticket thread
    // in the target project, running the same prompt the bridge's delegate
    // tool uses. Concurrent delegations are fine — askClaude serializes per
    // sessionKey and every ticket thread has its own key.
    delegateTask: ({ projectId, task, model, effort, title }) => {
      const project = db.listProjects().find((p) => p.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const text = String(task ?? "").trim();
      if (!text) throw new Error("delegateTask needs a task");

      const line = text.split("\n")[0].trim();
      const derived = line.length > 48 ? `${line.slice(0, 47)}…` : line;
      const thread = db.createThread({ projectId, kind: "ticket", title: title || derived || "Ticket" });
      emit("thread:created", thread);

      // The task opens the thread as its user turn, so the transcript reads
      // like any other conversation.
      db.addMessage({ threadId: thread.id, role: "user", text });

      // Same wording as teamlead.js onDelegate — the delegate contract is one
      // prompt, wherever it's launched from.
      const prompt = `You've been assigned a task by the team lead:\n\n${text}\n\nWork on it in this project. Commit/push or open a PR as appropriate. If you produce a document, report, export, or log Marc should see, share it with the mcp__approver__share_file tool (it uploads the file to this channel). When done or blocked, summarize the outcome in one short message.`;
      launchTurn(thread, project, prompt, { model, effort, source: "spawn-delegate" });
      return thread;
    },

    // Active threads across all projects, newest first (the workspace's
    // "what's running" list).
    listActiveThreads: () => db.listActiveThreads(),

    // Answer a pending permission prompt (from the desktop's Allow/Deny).
    resolveApproval: (id, allow, updatedInput) => hub.resolve(id, allow, updatedInput),

    cancelTurn: (threadId) => cancelRun(threadKey(threadId)),
    resetThreadSession: (threadId) => resetSession(threadKey(threadId)),
    lastTurnStats: (threadId) => getLastStats(threadKey(threadId)),
  };
}
