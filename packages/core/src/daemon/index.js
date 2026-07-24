import { EventEmitter } from "node:events";
import { readdirSync, readFileSync, statSync, mkdirSync, existsSync, copyFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { config, tokenizeArgs, dataPath } from "../config.js";
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
  worktreeDiff,
  worktreeFileDiff,
  prStatus,
} from "../worktrees.js";
import { dirFor as deliverablesDirFor, commitAll as commitDeliverables, listFiles as listDeliverableFiles } from "../deliverables.js";
import { fileURLToPath } from "node:url";

// The team lead's board-archive MCP (spawned inside its Claude runs).
const BOARD_MCP_PATH = fileURLToPath(new URL("../mcp/board-server.js", import.meta.url));
import { getOverrides, resolveProject } from "../projects.js";
// No Trello here — the Orchestrate board is native (the tickets table is the
// source of truth). The Discord bridge keeps its own Trello sync; the daemon
// never touches it.
import * as db from "../db/index.js";
import {
  getProjectSettings,
  updateProjectSettings,
  setProjectMcpSecret,
  clearProjectMcpSecret,
  getProjectMcpSecrets,
} from "./project-settings.js";
import { createApprovalHub } from "./approvals.js";
import {
  gcloudLogin,
  gcloudDisconnect,
  appleDisconnect,
  importAppleKeyFile,
} from "./provider-connect.js";

// The AgentDeck daemon — a mastermind for Claude. This is the ONE API clients talk
// through; it runs as its OWN background process (server.js) and owns sessions,
// threads, and the SQLite store. The desktop app is just a client.
//
// It is wired DIRECTLY to Claude Code (claude.js) — AgentDeck orchestrates Claude,
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
  // Keyed by dir, not name: projects.dir is UNIQUE, and an override key (a
  // channel name OR id, e.g. TEAMLEAD_CHANNEL's Discord id) can point at a
  // dir that root discovery already found under its real name — one dir must
  // resolve to exactly one project row. The display name is always the dir's
  // basename.
  const discoverProjects = () => {
    const root = config.projects.root;
    const dirs = new Map(); // dir -> name
    if (root) {
      try {
        for (const entry of readdirSync(root)) {
          if (entry.startsWith(".")) continue;
          const dir = join(root, entry);
          try {
            if (statSync(dir).isDirectory()) dirs.set(dir, entry);
          } catch {
            /* unreadable entry */
          }
        }
      } catch (err) {
        log.warn(`AgentDeck daemon: cannot read PROJECTS_ROOT ${root}: ${err.message}`);
      }
    }
    for (const dir of Object.values(getOverrides())) {
      dirs.set(dir, basename(dir));
    }
    return [...dirs].map(([dir, name]) => db.upsertProject(name, dir));
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

  // Per-project MCP servers → the shape claude.js merges into --mcp-config.
  // Reserved names (the built-ins) are dropped daemon-side too, so a settings
  // row can never shadow the approver.
  const RESERVED_MCP = new Set(["approver", "chrome-devtools"]);
  const mcpServersFor = (projectId, settings) => {
    const out = {};
    for (const s of settings.mcpServers ?? []) {
      if (!s?.enabled || !s.name || RESERVED_MCP.has(s.name)) continue;
      // Pasted tokens (project_secrets, encrypted) become this server's env
      // (stdio) or a bearer header (http). Decrypted here only, for injection.
      const secrets = getProjectMcpSecrets(projectId, s.name); // {ENV_KEY: value}
      if (s.transport === "http" && s.url) {
        const def = { type: "http", url: s.url };
        // The first declared secret (e.g. Expo's EXPO_TOKEN) is the PAT bearer.
        const bearer = secrets[(s.secretKeys ?? [])[0]];
        if (bearer) def.headers = { Authorization: `Bearer ${bearer}` };
        out[s.name] = def;
      } else if (s.command) {
        const [command, ...args] = tokenizeArgs(String(s.command));
        if (command) {
          const env = { ...(s.env ?? {}), ...secrets };
          // Google Cloud connections: point the gcloud MCP at this connection's
          // isolated config dir + pin its account (set by connectGcloud).
          if (s.credDir) {
            env.CLOUDSDK_CONFIG = s.credDir;
            if (s.account) env.CLOUDSDK_CORE_ACCOUNT = s.account;
          }
          out[s.name] = Object.keys(env).length ? { command, args, env } : { command, args };
        }
      }
    }
    return out;
  };

  // Skills visible to runs in a project: the project's .claude/skills plus
  // the user-level ~/.claude/skills. Read fresh per call — skills are files
  // on disk and can change under us. Description = first non-empty line of
  // the SKILL.md frontmatter's description, best-effort.
  const scanSkills = (dir, scope) => {
    const out = [];
    try {
      for (const entry of readdirSync(dir)) {
        const skillMd = join(dir, entry, "SKILL.md");
        try {
          const text = readFileSync(skillMd, "utf8");
          const m = /^description:\s*(.+)$/m.exec(text);
          out.push({
            name: entry,
            scope,
            description: m ? m[1].trim().replace(/^["']|["']$/g, "").slice(0, 140) : "",
          });
        } catch {
          /* not a skill dir */
        }
      }
    } catch {
      /* no skills dir */
    }
    return out;
  };

  // The per-project context block injected into every run's system prompt:
  // rules (how to behave), memory (what's true), connections (what this
  // project is wired to). Empty settings → null → no flag at all. Bounded so
  // a runaway blob can't eat the context window.
  const contextBlockFor = (settings) => {
    const parts = [];
    if (settings.rules?.trim()) {
      parts.push(`## Project rules\n${settings.rules.trim()}`);
    }
    if (settings.memory?.trim()) {
      parts.push(`## Project memory\n${settings.memory.trim()}`);
    }
    const conns = (settings.connections ?? []).filter((c) => c?.type && c?.value);
    if (conns.length) {
      const lines = conns.map((c) => {
        let line = `- ${c.type}${c.label ? ` (${c.label})` : ""}: ${c.value}`;
        if (c.url) line += ` — ${c.url}`;
        if (c.secretEnv) line += ` — credentials in the ${c.secretEnv} env var`;
        if (c.notes) line += ` — ${c.notes}`;
        return line;
      });
      parts.push(
        `## Project connections\nThis project's accounts and infrastructure. Use these — never guess at or create parallel ones:\n${lines.join("\n")}`
      );
    }
    if (!parts.length) return null;
    return parts.join("\n\n").slice(0, 8000);
  };

  // Launch one Claude turn in a thread and stream it out as events:
  //   turn:start {threadId} → turn:text {threadId,message}* / turn:tool
  //   {threadId,message}* → turn:done {threadId, ok, ...}
  // `message` is the persisted row (same shape as listMessages rows), so
  // clients append incrementally instead of re-pulling history. Callers insert
  // their own prompting rows first (sendMessage: the user's text; delegateTask:
  // the task) — promptText is what actually goes to Claude.
  // Where this thread's non-code outputs go (see deliverables.js).
  const deliverablesDirForThread = (thread, project) =>
    deliverablesDirFor({
      projectName: project.name,
      ticketId: db.getTicketByThread(thread.id)?.id ?? null,
    });

  // One turn at a time per thread. `activeTurns` marks a thread whose turn is
  // in flight (set synchronously when the turn is launched, not when the child
  // process finally spawns — so a message sent in the gap still queues instead
  // of racing a parallel run). `messageQueues` holds user messages sent while a
  // turn was running; they're drained FIFO on turn:done, one follow-up turn
  // each. In-memory only — a daemon restart mid-queue drops pending messages,
  // and the user just re-sends (rare; daemon restarts are code changes).
  const activeTurns = new Set(); // threadId
  const messageQueues = new Map(); // threadId -> string[]

  // Pull the next queued message for a thread (if any) and continue the chain
  // by launching it; otherwise release the thread. `activeTurns` is kept set
  // across the hand-off so a message arriving here still queues. Called from
  // every turn's completion — see launchTurn's done handler.
  const drainQueue = (threadId) => {
    const q = messageQueues.get(threadId);
    const nextText = q && q.length ? q.shift() : null;
    if (q && q.length === 0) messageQueues.delete(threadId);
    if (nextText != null) {
      const thread = db.getThread(threadId);
      const project = thread && db.listProjects().find((p) => p.id === thread.project_id);
      if (thread && project) {
        launchTurn(thread, project, nextText); // activeTurns stays set
        return;
      }
      // Thread/project vanished under us — drop the rest of the queue.
      messageQueues.delete(threadId);
    }
    activeTurns.delete(threadId);
  };

  const launchTurn = (thread, project, promptText, opts = {}) => {
    const threadId = thread.id;
    const settings = getProjectSettings(project.id);
    activeTurns.add(threadId);
    emit("turn:start", { threadId });

    // Deliverables: give the run a managed output dir (pre-created, permitted
    // via --add-dir) and tell it what belongs there.
    const outDir = deliverablesDirForThread(thread, project);
    const deliverablesNote = `## Output files\nWhen this task asks for a non-code deliverable (a PDF, spreadsheet, presentation, report, export, or any file that IS the requested output rather than a code change), save it under ${outDir} — you already have write access there, and everything in it is versioned automatically. Code changes still belong in the repo.`;

    // Team-lead runs see the board — OPEN tickets only. Done is deliberately
    // absent from the lead's context: the Done column is the archive, not
    // working memory.
    let boardNote = null;
    if (thread.kind === "teamlead") {
      const open = db.listTickets().filter((k) => k.status !== "done");
      const lines = open.slice(0, 60).map((k) => {
        const run = k.thread_id != null && getActiveRun(threadKey(k.thread_id)) ? " · running" : "";
        return `- SPWN-${k.id} [${k.status}] ${k.project_name}: ${k.title}${k.branch ? ` (${k.branch})` : ""}${run}`;
      });
      boardNote = `## Board (open tickets)\n${lines.length ? lines.join("\n") : "No open tickets."}${open.length > 60 ? `\n…and ${open.length - 60} more.` : ""}\nCompleted tickets are archived in the board's Done column and intentionally omitted here. To look up past/finished work when asked, search the archive with the board tools: mcp__board__search_tickets and mcp__board__get_ticket.`;
    }

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
        // Typewriter stream: token deltas as ephemeral events. Never
        // persisted — the complete message row (turn:text above) follows and
        // replaces the client's accumulated draft.
        onDelta: (text) => emit("turn:delta", { threadId, text }),
        // Live in-flight token total for this run (one event per API call).
        onUsage: (liveTokens) => emit("turn:usage", { threadId, liveTokens }),
        // An explicit per-turn model/effort (delegation right-sizing) beats the
        // project default — same precedence claude.js applies internally.
        model: opts.model || settings.defaultModel || undefined,
        effort: opts.effort || settings.defaultEffort || undefined,
        // ticket threads are ephemeral (fresh context per ticket); chat and
        // teamlead threads resume across turns
        persistSessions: thread.kind !== "ticket",
        // Per-project MCP servers + skill denials (settings page). Team-lead
        // runs also get the board archive tools (search incl. done tickets).
        // Board MCP: the team lead gets it (archive search + comment/delegate
        // back), and so do ticket runs (so the working agent can comment on /
        // attach files to its own ticket). The role + ticket id are passed via
        // env so the board tools default to the right ticket and author kind.
        mcpServers: {
          ...mcpServersFor(project.id, settings),
          ...(thread.kind === "teamlead"
            ? { board: { command: process.execPath, args: [BOARD_MCP_PATH], env: { SPAWN_BOARD_ROLE: "lead" } } }
            : thread.kind === "ticket"
              ? {
                  board: {
                    command: process.execPath,
                    args: [BOARD_MCP_PATH],
                    env: { SPAWN_BOARD_ROLE: "agent", SPAWN_BOARD_TICKET_ID: String(db.getTicketByThread(thread.id)?.id ?? "") },
                  },
                }
              : {}),
        },
        disallowedTools: (settings.disabledSkills ?? []).map((s) => `Skill(${s})`),
        // Rules / memory / connections + the deliverables note, as a
        // system-prompt suffix.
        appendSystemPrompt: [contextBlockFor(settings), boardNote, deliverablesNote]
          .filter(Boolean)
          .join("\n\n"),
        // Write access to the output dir without a permission prompt.
        addDirs: [outDir],
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
        meta: { source: opts.source || "agentdeck-daemon", threadId },
      }
    );

    // Board flow: a run starting/finishing moves the linked ticket. Manual
    // column moves are respected — only the expected prior status advances.
    const ticket = db.getTicketByThread(threadId);
    if (ticket && ticket.status !== "in-progress" && ticket.status !== "done") {
      emit("ticket:updated", db.updateTicket(ticket.id, { status: "in-progress" }));
    }

    done.then((res) => {
      // Bookkeeping (final text row, ticket status, deliverables) is guarded so
      // a hiccup here never strands the message queue — the drain below must
      // always run, or a thread could get stuck holding queued follow-ups.
      try {
        // Final text arrives via onText already when streamed; store the result
        // only if nothing streamed (e.g. an error string) — and ship the row so
        // clients (who no longer re-pull on turn:done) still see it.
        if (res.text && !res.streamed) {
          const message = db.addMessage({ threadId, role: res.ok ? "assistant" : "system", text: res.text, seq: seq++ });
          emit("turn:text", { threadId, message });
        }
        const k = db.getTicketByThread(threadId);
        if (k && k.status === "in-progress") {
          const status = res.ok ? "in-review" : res.cancelled ? "in-progress" : "blocked";
          if (status !== k.status) emit("ticket:updated", db.updateTicket(k.id, { status }));
        }
        // Version any new/changed output files (repo-wide snapshot; the message
        // names the run that triggered it). Fire-and-forget by design.
        commitDeliverables(`${project.name}${k ? ` SPWN-${k.id}` : ""}: ${thread.title}`).then((files) => {
          if (files.length) emit("deliverables:updated", { threadId, files });
        });
      } catch (err) {
        log.warn(`[daemon] post-turn bookkeeping for thread ${threadId} failed: ${err.message}`);
      }
      // `queued` = messages still waiting after this one hands off (the next is
      // drained just below), so clients can render an accurate "N queued" chip.
      emit("turn:done", {
        threadId,
        ok: res.ok,
        cancelled: res.cancelled ?? false,
        contextTokens: res.contextTokens ?? null,
        queued: Math.max(0, (messageQueues.get(threadId)?.length ?? 0) - 1),
      });
      drainQueue(threadId);
    });

    return { threadId, started: true };
  };

  // ── Ticket attachments (files) + the human-comment → team-lead nudge ────────
  const ticketFilesDir = (ticketId) => {
    const dir = dataPath(join("ticket-files", String(ticketId)));
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const storeTicketAttachment = (ticketId, sourcePath, uploadedBy) => {
    if (!sourcePath || !existsSync(sourcePath)) throw new Error(`No such file: ${sourcePath}`);
    const dir = ticketFilesDir(ticketId);
    let dest = join(dir, basename(sourcePath));
    if (existsSync(dest)) {
      const base = basename(sourcePath);
      const dot = base.lastIndexOf(".");
      const n = db.listTicketAttachments(ticketId).length + 1;
      dest = join(dir, dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`);
    }
    copyFileSync(sourcePath, dest);
    return db.addTicketAttachment({ ticketId, name: basename(dest), path: dest, size: statSync(dest).size, uploadedBy });
  };

  // Store an attachment from raw bytes — the remote/mobile path, where the file
  // lives on the phone and there's no host path to copy from. `name` is the
  // display filename (basename-sanitized), `base64` the file contents.
  const storeTicketAttachmentBytes = (ticketId, name, base64, uploadedBy) => {
    const safe = basename(String(name || "attachment").replace(/[/\\]/g, "_")) || "attachment";
    const buf = Buffer.from(String(base64 || ""), "base64");
    if (!buf.length) throw new Error("empty attachment");
    const maxBytes = (config.attachments?.maxMb || 25) * 1024 * 1024;
    if (buf.length > maxBytes)
      throw new Error(`file is ${(buf.length / 1048576).toFixed(1)}MB, over the ${config.attachments?.maxMb || 25}MB limit`);
    const dir = ticketFilesDir(ticketId);
    let dest = join(dir, safe);
    if (existsSync(dest)) {
      const dot = safe.lastIndexOf(".");
      const n = db.listTicketAttachments(ticketId).length + 1;
      dest = join(dir, dot > 0 ? `${safe.slice(0, dot)}-${n}${safe.slice(dot)}` : `${safe}-${n}`);
    }
    writeFileSync(dest, buf);
    return db.addTicketAttachment({ ticketId, name: basename(dest), path: dest, size: buf.length, uploadedBy });
  };

  // A human comment wakes the team lead: it reads the ticket + comment and
  // takes the next action (delegate if backlog, steer/relay if in progress),
  // then comments back. No-op if no team-lead project is configured.
  const nudgeTeamLeadForComment = (ticketId, comment) => {
    const tlProject = resolveTeamLeadProject();
    if (!tlProject) return;
    let tl = db.listThreads(tlProject.id).find((t) => t.kind === "teamlead");
    if (!tl) {
      tl = db.createThread({ projectId: tlProject.id, kind: "teamlead", title: "Team-lead console" });
      emit("thread:created", tl);
    }
    const k = db.getTicket(ticketId);
    const prompt =
      `New comment on SPWN-${ticketId} — ${k.project_name}: "${k.title}" [${k.status}]${k.branch ? ` (${k.branch})` : ""}.\n\n` +
      `Comment from the owner:\n${comment.body}\n\n` +
      `Read the full ticket (comments + attachments) with mcp__board__get_ticket. Then take the next action:\n` +
      `- If it isn't delegated yet, delegate the implementation with mcp__board__delegate_ticket.\n` +
      `- If it's already in progress, decide whether to steer, wait, or just acknowledge.\n` +
      `When you've acted, reply to the owner on the ticket with mcp__board__comment_on_ticket. Keep replies short.`;
    launchTurn(tl, tlProject, prompt, { source: "spawn-ticket-comment" });
  };

  const daemonApi = {
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

    // MCP token write paths. Values are stored encrypted and never echoed back
    // (return a bare boolean). Local-only by intent — not routed to remote/
    // mobile clients, so pasted tokens never leave this host.
    setProjectMcpSecret: (projectId, serverName, envKey, value) =>
      setProjectMcpSecret(projectId, serverName, envKey, value),
    clearProjectMcpSecret: (projectId, serverName, envKey) =>
      clearProjectMcpSecret(projectId, serverName, envKey),

    // One-click Google Cloud connect: browser OAuth into an isolated per-
    // connection config dir, then pin the logged-in account onto the server.
    // Streams connect:status / connect:url events for the UI. Local-only.
    connectGcloud: async (projectId, serverName) => {
      emit("connect:status", { serverName, provider: "gcloud", state: "connecting" });
      try {
        const { account, credDir } = await gcloudLogin(projectId, serverName, {
          onUrl: (url) => emit("connect:url", { serverName, url }),
        });
        const cur = getProjectSettings(projectId);
        const mcpServers = cur.mcpServers.map((s) =>
          s.name === serverName ? { ...s, account, credDir } : s
        );
        updateProjectSettings(projectId, { mcpServers });
        emit("connect:status", { serverName, provider: "gcloud", state: "connected", account });
        return { ok: true, account };
      } catch (err) {
        emit("connect:status", { serverName, provider: "gcloud", state: "failed", error: err.message });
        return { ok: false, error: err.message };
      }
    },

    // Import a downloaded App Store Connect .p8 key file; stored isolated, its
    // path injected as APP_STORE_CONNECT_P8_PATH at run time.
    importAppleKey: (projectId, serverName, sourcePath) => {
      const dest = importAppleKeyFile(projectId, serverName, sourcePath);
      setProjectMcpSecret(projectId, serverName, "APP_STORE_CONNECT_P8_PATH", dest);
      return { ok: true, path: dest };
    },

    // Drop a connection's credentials: isolated dirs + stored secrets, and the
    // account/credDir pins on the server def.
    disconnectProvider: (projectId, serverName) => {
      gcloudDisconnect(projectId, serverName);
      appleDisconnect(projectId, serverName);
      const cur = getProjectSettings(projectId);
      const prefix = `mcp:${serverName}:`;
      for (const k of db.listSecretKeys(projectId, prefix)) {
        clearProjectMcpSecret(projectId, serverName, k.slice(prefix.length));
      }
      const mcpServers = cur.mcpServers.map((s) =>
        s.name === serverName ? { ...s, account: undefined, credDir: undefined } : s
      );
      updateProjectSettings(projectId, { mcpServers });
      return { ok: true };
    },

    // Skills available to runs in this project (project .claude/skills +
    // user ~/.claude/skills), each flagged enabled per the project's
    // disabledSkills setting.
    listSkills: (projectId) => {
      const project = db.listProjects().find((p) => p.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const disabled = new Set(getProjectSettings(projectId).disabledSkills ?? []);
      const seen = new Map(); // name -> skill (project scope wins on collision)
      for (const s of [
        ...scanSkills(join(project.dir, ".claude", "skills"), "project"),
        ...scanSkills(join(homedir(), ".claude", "skills"), "user"),
      ]) {
        if (!seen.has(s.name)) seen.set(s.name, s);
      }
      return [...seen.values()]
        .map((s) => ({ ...s, enabled: !disabled.has(s.name) }))
        .sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
    },

    listThreads: (projectId) => db.listThreads(projectId),
    listAllThreads: () => db.listAllThreads(),
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

    // Set a thread's lifecycle status (active | done | blocked | archived) —
    // the manual counterpart to the board's automatic moves, driven by the
    // threads list right-click menu. Validates against the schema's CHECK set.
    setThreadStatus: (threadId, status) => {
      const allowed = ["active", "done", "blocked", "archived"];
      if (!allowed.includes(status)) throw new Error(`Bad thread status: ${status}`);
      const t = db.updateThread(threadId, { status });
      emit("thread:updated", t);
      return t;
    },

    // Hard-delete a thread from the list. Refuses while a run is live (kill it
    // first). Reclaims the worktree checkout the same way cleanupThread does —
    // force, since this is an explicit, confirmed destroy — but the branch and
    // its commits stay in the repo. Messages cascade; a linked ticket keeps its
    // row (thread_id nulled) so no board work is lost.
    deleteThread: async (threadId) => {
      const thread = db.getThread(threadId);
      if (!thread) return { ok: false, reason: "gone" };
      if (getActiveRun(threadKey(threadId))) return { ok: false, reason: "running" };
      if (thread.worktree_path) {
        const project = db.listProjects().find((p) => p.id === thread.project_id);
        if (project) {
          try {
            await removeWorktree({ repoDir: project.dir, path: thread.worktree_path, force: true });
          } catch (err) {
            // Already gone (removed by hand) is fine; a real failure isn't —
            // don't orphan a live checkout by deleting its row.
            if (await worktreeStatus(thread.worktree_path)) {
              return { ok: false, reason: err.message };
            }
          }
        }
      }
      db.deleteThread(threadId);
      emit("thread:deleted", { id: threadId });
      return { ok: true };
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

      // A turn is already running (or messages are already queued behind one):
      // don't start a parallel run — queue this message and let drainQueue send
      // it as its own turn when the current one finishes. The user row above is
      // persisted either way, so the message shows in the transcript at once.
      if (activeTurns.has(threadId)) {
        const q = messageQueues.get(threadId) ?? [];
        q.push(text);
        messageQueues.set(threadId, q);
        emit("turn:queued", { threadId, depth: q.length });
        return { threadId, queued: true, depth: q.length };
      }

      return launchTurn(thread, project, text);
    },

    // ── The native board: tickets are the source of truth ─────────────────
    listTickets: () =>
      db.listTickets().map((k) => ({
        ...k,
        running: k.thread_id != null && Boolean(getActiveRun(threadKey(k.thread_id))),
      })),

    createTicket: ({ projectId, title, body = "", status = "todo" }) => {
      const project = db.listProjects().find((p) => p.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const text = String(title ?? "").trim();
      if (!text) throw new Error("createTicket needs a title");
      const ticket = db.createTicket({ projectId, title: text, body: String(body ?? ""), status });
      emit("ticket:created", db.getTicket(ticket.id));
      return db.getTicket(ticket.id);
    },

    updateTicket: (ticketId, patch) => {
      const ticket = db.updateTicket(ticketId, patch);
      if (!ticket) throw new Error(`No such ticket: ${ticketId}`);
      // Done is done: retire the linked thread so the ticket vanishes from
      // every live surface (active runs, map, lead context) — the board's
      // Done column keeps the row as the archive. Dragging back out of Done
      // resurrects the thread.
      if (patch.status && ticket.thread_id) {
        const thread = db.getThread(ticket.thread_id);
        if (patch.status === "done" && thread?.status === "active") {
          emit("thread:updated", db.updateThread(ticket.thread_id, { status: "done" }));
        } else if (patch.status !== "done" && thread?.status === "done") {
          emit("thread:updated", db.updateThread(ticket.thread_id, { status: "active" }));
        }
      }
      emit("ticket:updated", ticket);
      return ticket;
    },

    // Archive search for the team lead's board tool — done tickets included.
    // `project` is a name (how the lead sees them); resolved to an id here.
    searchTickets: (opts) => {
      const { query, status, project, limit } = opts ?? {};
      const projectId = project
        ? (db.listProjects().find((p) => p.name === project)?.id ?? -1)
        : null;
      return db.searchTickets({ query, status, projectId, limit });
    },

    // One ticket with its outcome: the closing assistant/system lines of its
    // thread, so "what happened with X?" is answerable from the archive.
    getTicketDetail: (ticketId) => {
      const ticket = db.getTicket(ticketId);
      if (!ticket) throw new Error(`No such ticket: ${ticketId}`);
      let outcome = [];
      if (ticket.thread_id) {
        outcome = db
          .listMessages(ticket.thread_id, { limit: 50 })
          .filter((m) => m.role === "assistant" || m.role === "system")
          .slice(-3)
          .map((m) => m.text);
      }
      return { ...ticket, outcome };
    },

    // Full detail for the desktop ticket modal: ticket + comment thread +
    // attachments in one round trip.
    getTicket: (ticketId) => {
      const ticket = db.getTicket(ticketId);
      if (!ticket) throw new Error(`No such ticket: ${ticketId}`);
      return {
        ...ticket,
        comments: db.listTicketComments(ticketId),
        attachments: db.listTicketAttachments(ticketId),
      };
    },

    listTicketComments: (ticketId) => db.listTicketComments(ticketId),

    // Post a comment. authorKind: "human" (desktop/mobile), "lead"/"agent"
    // (board MCP). A HUMAN comment auto-wakes the team lead to act + reply.
    addTicketComment: (ticketId, opts) => {
      const { authorKind = "human", authorName = "", body } = opts ?? {};
      const ticket = db.getTicket(ticketId);
      if (!ticket) throw new Error(`No such ticket: ${ticketId}`);
      const text = String(body ?? "").trim();
      if (!text) throw new Error("addTicketComment needs a body");
      const comment = db.addTicketComment({ ticketId, authorKind, authorName, body: text });
      emit("ticket:comment", { ticketId, comment });
      if (authorKind === "human") {
        // A human comment on a ticket awaiting review is fresh feedback to
        // act on — pull it back into in-progress (board-flow rule, mirrors
        // the run-start/finish transitions above).
        if (ticket.status === "in-review") {
          emit("ticket:updated", db.updateTicket(ticketId, { status: "in-progress" }));
        }
        try {
          nudgeTeamLeadForComment(ticketId, comment);
        } catch (e) {
          log.warn?.(`[teamlead] nudge on comment failed: ${e.message}`);
        }
      }
      return comment;
    },

    listTicketAttachments: (ticketId) => db.listTicketAttachments(ticketId),

    // Copy a host file into the ticket's attachments dir + record it.
    addTicketAttachment: (ticketId, sourcePath, uploadedBy = "you") => {
      if (!db.getTicket(ticketId)) throw new Error(`No such ticket: ${ticketId}`);
      const attachment = storeTicketAttachment(ticketId, sourcePath, uploadedBy);
      emit("ticket:attachment", { ticketId, attachment });
      return attachment;
    },

    // Store an uploaded file from raw bytes — the remote/mobile path (no host
    // file to copy). Allowed through the relay (unlike addTicketAttachment,
    // which reads a daemon-host path and is remote-denied).
    addTicketAttachmentBytes: (ticketId, name, base64, uploadedBy = "you") => {
      if (!db.getTicket(ticketId)) throw new Error(`No such ticket: ${ticketId}`);
      const attachment = storeTicketAttachmentBytes(ticketId, name, base64, uploadedBy);
      emit("ticket:attachment", { ticketId, attachment });
      return attachment;
    },

    deleteTicket: (ticketId) => {
      db.deleteTicket(ticketId);
      emit("ticket:deleted", { id: ticketId });
      return true;
    },

    // Launch a run for an existing (backlog) ticket: creates its thread,
    // links it, moves it to in-progress (via launchTurn's board flow).
    delegateTicket: (ticketId, opts) => {
      const { model, effort } = opts ?? {};
      const ticket = db.getTicket(ticketId);
      if (!ticket) throw new Error(`No such ticket: ${ticketId}`);
      if (ticket.thread_id) throw new Error(`Ticket ${ticketId} already has a thread`);
      const task = [ticket.title, ticket.body].filter(Boolean).join("\n\n");
      return daemonApi.delegateTask({
        projectId: ticket.project_id,
        task,
        model,
        effort,
        title: ticket.title,
        ticketId,
      });
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
    delegateTask: async ({ projectId, task, model, effort, title, ticketId = null }) => {
      const project = db.listProjects().find((p) => p.id === projectId);
      if (!project) throw new Error(`No such project: ${projectId}`);
      const text = String(task ?? "").trim();
      if (!text) throw new Error("delegateTask needs a task");

      const line = text.split("\n")[0].trim();
      const derived = line.length > 48 ? `${line.slice(0, 47)}…` : line;
      let thread = db.createThread({ projectId, kind: "ticket", title: title || derived || "Ticket" });
      emit("thread:created", thread);

      // Board is the source of truth: every delegation is a ticket row.
      // Freeform delegations (dock, palette) create one; delegateTicket links
      // its existing backlog row instead.
      if (ticketId != null) {
        emit("ticket:updated", db.updateTicket(ticketId, { thread_id: thread.id }));
      } else {
        const k = db.createTicket({ projectId, title: thread.title, body: text, status: "todo" });
        emit("ticket:created", db.updateTicket(k.id, { thread_id: thread.id }));
      }

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
          log.warn(`AgentDeck daemon: worktree for thread ${thread.id} failed (${err.message}) — running in project dir`);
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
      const prompt = `You've been assigned a task by the team lead:\n\n${text}\n\nWork on it in this project. Commit/push or open a PR as appropriate. If you produce a document, report, export, or log the owner should see, share it with the mcp__approver__share_file tool (it uploads the file to this channel). You can also post progress or questions on this ticket with mcp__board__comment_on_ticket, and attach result files (reports, screenshots, exports) to it with mcp__board__upload_ticket_attachment — those show up on the ticket the owner is watching. When done or blocked, summarize the outcome in one short message.${isolationNote}`;
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
          ? { running: true, pid: run.pid, startedAt: run.startedAt, model: run.model, liveTokens: run.liveTokens }
          : { running: false },
        cost: {
          totalUsd: usage.totalUsd,
          turns: usage.turns,
          lastContextTokens,
          lastModel: stats?.model ?? null,
        },
      };
    },

    // The GitHub-style "files changed" list for a thread's code view: every
    // path this thread's branch touched vs its base, plus untracked files.
    // Empty (not an error) for threads with no worktree — team-lead / plain
    // chat threads that never got an isolated branch.
    getThreadDiff: async (threadId) => {
      const thread = db.getThread(threadId);
      if (!thread) throw new Error(`No such thread: ${threadId}`);
      if (!thread.worktree_path) {
        return { branch: thread.branch, worktreePath: null, base: null, files: [], additions: 0, deletions: 0 };
      }
      const d = await worktreeDiff(thread.worktree_path);
      return {
        branch: thread.branch,
        worktreePath: thread.worktree_path,
        base: d?.base ?? null,
        files: d?.files ?? [],
        additions: d?.additions ?? 0,
        deletions: d?.deletions ?? 0,
      };
    },

    // The unified diff for one file in a thread's worktree (lazy-loaded when the
    // code view expands a file). Raw git-diff text; the client parses hunks.
    getThreadFileDiff: async (threadId, path) => {
      const thread = db.getThread(threadId);
      if (!thread) throw new Error(`No such thread: ${threadId}`);
      if (!thread.worktree_path || !path) return { path, diff: "" };
      return { path, diff: await worktreeFileDiff(thread.worktree_path, path) };
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
      db.listActiveThreads().map((t) => {
        const run = getActiveRun(threadKey(t.id));
        return { ...t, running: Boolean(run), liveTokens: run?.liveTokens ?? null };
      }),

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
    getUsage: (rawDays) => {
      const days = rawDays ?? 1; // RPC/JSON turns an omitted arg into null, not undefined
      const now = Date.now();
      const windowMs = days * 86_400_000; // days may be fractional (hour-scale ranges)
      const cutoff = now - windowMs;
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
      // Series bucket size adapts to the window so short (hour-scale) ranges
      // still show a shape: 5-min bars ≤2h, 15-min ≤6h, hourly ≤1d, else daily.
      const bucketMs =
        windowMs <= 2 * 3_600_000
          ? 5 * 60_000
          : windowMs <= 6 * 3_600_000
            ? 15 * 60_000
            : windowMs <= 86_400_000
              ? 3_600_000
              : 86_400_000;
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

      // Zero-fill every bucket across the window so the chart's x-axis is
      // linear in time (bars are index-positioned in the view). An empty
      // window stays empty so the "No runs recorded" state still shows.
      const denseSeries = [];
      if (events.length > 0) {
        const firstBucket = Math.floor(cutoff / bucketMs) * bucketMs;
        const lastBucket = Math.floor(now / bucketMs) * bucketMs;
        for (let b = firstBucket; b <= lastBucket; b += bucketMs) {
          denseSeries.push({ ts: b, tokens: series.get(b) || 0 });
        }
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
        series: denseSeries,
        sessions,
      };
    },

    // Output files for one thread's deliverables dir (context rail).
    listDeliverables: (threadId) => {
      const thread = db.getThread(threadId);
      if (!thread) throw new Error(`No such thread: ${threadId}`);
      const project = db.listProjects().find((p) => p.id === thread.project_id);
      if (!project) return { dir: null, files: [] };
      const dir = deliverablesDirForThread(thread, project);
      return { dir, files: listDeliverableFiles(dir) };
    },

    // Stop the live turn. Cancelling is a deliberate "take over" — so any
    // messages queued behind it are dropped too, rather than firing once the
    // killed run's turn:done drains them.
    cancelTurn: (threadId) => {
      if (messageQueues.has(threadId)) {
        messageQueues.delete(threadId);
        emit("turn:queued", { threadId, depth: 0 });
      }
      return cancelRun(threadKey(threadId));
    },
    resetThreadSession: (threadId) => resetSession(threadKey(threadId)),
    lastTurnStats: (threadId) => getLastStats(threadKey(threadId)),
  };
  return daemonApi;
}
