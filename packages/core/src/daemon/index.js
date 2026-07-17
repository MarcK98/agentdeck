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
  getActiveRun,
  pauseInactivity,
  resumeInactivity,
} from "../claude.js";
import { threadUsage, readUsageEvents } from "../usage-log.js";
import {
  isGitRepo,
  createWorktree,
  removeWorktree,
  worktreeStatus,
  prStatus,
} from "../worktrees.js";
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

  // Recent approval decisions, newest first (bounded; see listDecisions).
  const decisions = [];

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
        effort: opts.effort || settings.defaultEffort || undefined,
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
    //
    // Per-ticket isolation (Phase 3): when the project is a git repo, the
    // ticket gets its own worktree + branch (see worktrees.js) and the run's
    // cwd is that worktree — parallel tickets in one project never trample
    // each other. Isolation failure (or a non-git project) falls back to
    // running in the project dir, with a system row saying so; the delegation
    // itself never fails over it.
    delegateTask: async ({ projectId, task, model, effort, title }) => {
      const project = db.listProjects().find((p) => p.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const text = String(task ?? "").trim();
      if (!text) throw new Error("delegateTask needs a task");

      const line = text.split("\n")[0].trim();
      const derived = line.length > 48 ? `${line.slice(0, 47)}…` : line;
      let thread = db.createThread({ projectId, kind: "ticket", title: title || derived || "Ticket" });
      emit("thread:created", thread);

      // The task opens the thread as its user turn, so the transcript reads
      // like any other conversation.
      db.addMessage({ threadId: thread.id, role: "user", text });

      let wt = null;
      if (getProjectSettings(project.id).isolation !== false && (await isGitRepo(project.dir))) {
        try {
          wt = await createWorktree({
            repoDir: project.dir,
            projectName: project.name,
            threadId: thread.id,
            title: thread.title,
          });
          thread = db.updateThread(thread.id, { branch: wt.branch, worktree_path: wt.path });
          emit("thread:updated", thread);
        } catch (err) {
          log.warn(`Spawn daemon: worktree for thread ${thread.id} failed (${err.message}) — running in project dir`);
          db.addMessage({
            threadId: thread.id,
            role: "system",
            text: `Could not create an isolated worktree (${err.message}); running directly in ${project.dir}.`,
          });
        }
      }

      // Same wording as teamlead.js onDelegate — the delegate contract is one
      // prompt, wherever it's launched from. Isolated tickets get told about
      // their worktree so they commit to the ticket branch, not the mainline.
      const isolationNote = wt
        ? `\n\nYou are working in an isolated git worktree created for this ticket: ${wt.path} (branch ${wt.branch}, forked from ${wt.base}). Commit your work on this branch; push it and open a PR rather than committing to the base branch directly.`
        : "";
      const prompt = `You've been assigned a task by the team lead:\n\n${text}\n\nWork on it in this project. Commit/push or open a PR as appropriate. If you produce a document, report, export, or log Marc should see, share it with the mcp__approver__share_file tool (it uploads the file to this channel). When done or blocked, summarize the outcome in one short message.${isolationNote}`;
      launchTurn(thread, project, prompt, { model, effort, source: "spawn-delegate" });
      return thread;
    },

    // Everything the context panel shows for one thread: isolation (branch /
    // worktree / live git state), the PR (via gh, when one exists), the live
    // process, and cumulative cost. Sub-parts are best-effort nulls — this
    // never throws over a missing repo, remote, or gh.
    getThreadContext: async (threadId) => {
      const thread = db.getThread(threadId);
      if (!thread) throw new Error(`No such thread: ${threadId}`);
      const project = db.listProjects().find((p) => p.id === thread.project_id);
      const run = getActiveRun(threadKey(threadId));
      const stats = getLastStats(threadKey(threadId));
      const u = stats?.usage || null;
      const lastContextTokens = u
        ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
        : null;
      const dir = thread.worktree_path || project?.dir || null;
      const usage = threadUsage(threadId);
      return {
        threadId,
        kind: thread.kind,
        status: thread.status,
        branch: thread.branch,
        worktreePath: thread.worktree_path,
        git: thread.worktree_path ? await worktreeStatus(thread.worktree_path) : null,
        pr: thread.branch && dir ? await prStatus(dir, thread.branch) : null,
        process: run
          ? { running: true, pid: run.pid, startedAt: run.startedAt, model: run.model }
          : { running: false },
        cost: {
          totalUsd: usage.totalUsd,
          turns: usage.turns,
          lastContextTokens,
          lastModel: stats?.model ?? null,
        },
      };
    },

    // Retire a finished ticket: remove its worktree checkout (branch + commits
    // stay — cleanup reclaims disk, never work) and archive the thread.
    // Refuses while a run is active, and refuses a dirty worktree unless
    // force=true, so uncommitted work can't vanish on a misclick.
    cleanupThread: async (threadId, force = false) => {
      const thread = db.getThread(threadId);
      if (!thread) throw new Error(`No such thread: ${threadId}`);
      if (getActiveRun(threadKey(threadId))) return { ok: false, reason: "running" };
      if (thread.worktree_path) {
        const project = db.listProjects().find((p) => p.id === thread.project_id);
        if (!project) throw new Error(`Thread ${threadId} has no project`);
        const status = await worktreeStatus(thread.worktree_path);
        if (status && status.dirty > 0 && !force) {
          return { ok: false, reason: "dirty", dirty: status.dirty };
        }
        try {
          await removeWorktree({ repoDir: project.dir, path: thread.worktree_path, force });
        } catch (err) {
          // Already gone (deleted by hand) is fine — anything else is real.
          if (await worktreeStatus(thread.worktree_path)) {
            return { ok: false, reason: err.message };
          }
        }
      }
      const t = db.updateThread(threadId, { worktree_path: null, status: "archived" });
      emit("thread:updated", t);
      return { ok: true };
    },

    // Active threads across all projects, newest first (the workspace's
    // "what's running" list). `running` is live process truth — unlike the
    // client's event-derived busy set, it survives an app restart.
    listActiveThreads: () =>
      db.listActiveThreads().map((t) => ({ ...t, running: Boolean(getActiveRun(threadKey(t.id))) })),

    // Everything the live map draws, in one call: the team-lead project, the
    // projects that currently have active threads, and every active thread
    // with its isolation + process + cost state (a getThreadContext-lite per
    // thread, fanned out in parallel). PR/git lookups are best-effort nulls,
    // same as getThreadContext — the map renders whatever it gets.
    getMap: async () => {
      discoverProjects();
      const projects = db.listProjects();
      const tl = resolveTeamLeadProject();
      const active = db.listActiveThreads();
      const threads = await Promise.all(
        active.map(async (t) => {
          const dir = t.worktree_path || projects.find((p) => p.id === t.project_id)?.dir || null;
          const [git, pr] = await Promise.all([
            t.worktree_path ? worktreeStatus(t.worktree_path) : null,
            t.branch && dir ? prStatus(dir, t.branch) : null,
          ]);
          const run = getActiveRun(threadKey(t.id));
          const usage = threadUsage(t.id);
          return {
            id: t.id,
            projectId: t.project_id,
            kind: t.kind,
            title: t.title,
            status: t.status,
            branch: t.branch,
            worktreePath: t.worktree_path,
            dirty: git?.dirty ?? null,
            running: Boolean(run),
            pid: run?.pid ?? null,
            model: run?.model ?? null,
            costUsd: usage.totalUsd,
            turns: usage.turns,
            pr,
          };
        })
      );
      // Only projects that are actually on the map (have a live thread), plus
      // the team-lead's home — 25 idle project nodes would just be noise.
      const onMap = new Set(threads.map((t) => t.projectId));
      if (tl) onMap.add(tl.id);
      return {
        teamLeadProjectId: tl?.id ?? null,
        projects: projects
          .filter((p) => onMap.has(p.id))
          .map(({ id, name, dir }) => ({ id, name, dir })),
        threads,
      };
    },

    // The pending permission queue (the Approvals inbox) — client-shaped,
    // straight from the hub.
    listApprovals: () => hub.pending(),

    // Recent decisions, newest first (the inbox's "decided today" trail).
    // In-memory by design: it's a glanceable audit line, not durable history.
    listDecisions: () => [...decisions],

    // Answer a pending permission prompt (from the desktop's Allow/Deny).
    resolveApproval: (id, allow, updatedInput) => {
      const entry = hub.pending().find((p) => p.id === id);
      const settled = hub.resolve(id, allow, updatedInput);
      if (settled && entry) {
        decisions.unshift({ ...entry, allow: Boolean(allow), at: Date.now() });
        if (decisions.length > 50) decisions.pop();
      }
      return settled;
    },

    // Usage rollup for the Usage view, from the append-only ledger. `days`
    // bounds the window (1 = today-ish: last 24h). Everything here is
    // aggregation over readUsageEvents — no new state.
    getUsage: (days = 1) => {
      const cutoff = Date.now() - days * 86_400_000;
      const events = readUsageEvents().filter((r) => (r.ts ?? 0) >= cutoff);
      const tok = (r) =>
        (r.input_tokens || 0) +
        (r.output_tokens || 0) +
        (r.cache_read_input_tokens || 0) +
        (r.cache_creation_input_tokens || 0);

      const projects = db.listProjects();
      const projectName = (r) => {
        const m = /^spawn:thread:(\d+)$/.exec(r.sessionKey ?? "");
        if (m) {
          const t = db.getThread(Number(m[1]));
          const p = t && projects.find((x) => x.id === t.project_id);
          if (p) return p.name;
        }
        return r.channelName || "other";
      };

      let totalTokens = 0;
      let totalCost = 0;
      let turns = 0;
      const threadIds = new Set();
      const byModel = new Map();
      const byProject = new Map();
      // Series buckets: hourly for a 1-day window, daily beyond.
      const bucketMs = days <= 1 ? 3_600_000 : 86_400_000;
      const series = new Map();
      for (const r of events) {
        const t = tok(r);
        totalTokens += t;
        if (typeof r.cost_usd === "number") totalCost += r.cost_usd;
        turns++;
        if (r.threadId != null) threadIds.add(r.threadId);
        const model = r.model || "unknown";
        byModel.set(model, (byModel.get(model) || 0) + t);
        const proj = projectName(r);
        const p = byProject.get(proj) || { tokens: 0, turns: 0, threads: new Set() };
        p.tokens += t;
        p.turns++;
        if (r.threadId != null) p.threads.add(r.threadId);
        byProject.set(proj, p);
        const bucket = Math.floor((r.ts ?? 0) / bucketMs) * bucketMs;
        series.set(bucket, (series.get(bucket) || 0) + t);
      }

      // Live sessions: active threads with a known context size, running first.
      const sessions = db
        .listActiveThreads()
        .map((t) => {
          const stats = getLastStats(threadKey(t.id));
          const u = stats?.usage;
          const contextTokens = u
            ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
            : null;
          return {
            threadId: t.id,
            title: t.title,
            project: t.project_name,
            kind: t.kind,
            running: Boolean(getActiveRun(threadKey(t.id))),
            model: stats?.model ?? null,
            contextTokens,
          };
        })
        .filter((s) => s.running || s.contextTokens != null)
        .sort((a, b) => Number(b.running) - Number(a.running));

      return {
        days,
        totalTokens,
        totalCost,
        turns,
        threads: threadIds.size,
        byModel: [...byModel]
          .map(([model, tokens]) => ({ model, tokens }))
          .sort((a, b) => b.tokens - a.tokens),
        byProject: [...byProject]
          .map(([project, p]) => ({ project, tokens: p.tokens, turns: p.turns, threads: p.threads.size }))
          .sort((a, b) => b.tokens - a.tokens),
        series: [...series]
          .map(([ts, tokens]) => ({ ts, tokens }))
          .sort((a, b) => a.ts - b.ts),
        sessions,
      };
    },

    cancelTurn: (threadId) => cancelRun(threadKey(threadId)),
    resetThreadSession: (threadId) => resetSession(threadKey(threadId)),
    lastTurnStats: (threadId) => getLastStats(threadKey(threadId)),
  };
}
