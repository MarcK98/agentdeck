#!/usr/bin/env node
// Stdio MCP server that Claude Code spawns inside each run (via --mcp-config).
// When Claude needs permission for a tool, --permission-prompt-tool calls
// `approve` here; we forward the request to the bridge's local HTTP server,
// which asks the user on Discord and returns allow/deny.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT = process.env.BRIDGE_APPROVAL_PORT || "8790";
const SESSION_KEY = process.env.BRIDGE_SESSION_KEY || "unknown";
const TIMEOUT_MS = Number(process.env.BRIDGE_APPROVAL_TIMEOUT_MS || 300000);

const server = new McpServer({ name: "approver", version: "1.0.0" });

server.tool(
  "approve",
  "Ask the user to approve a tool call",
  {
    tool_name: z.string(),
    input: z.record(z.any()).optional(),
    tool_use_id: z.string().optional(),
  },
  async ({ tool_name, input }) => {
    let payload;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/permission`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionKey: SESSION_KEY,
          toolName: tool_name,
          input: input ?? {},
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const { allow, message, updatedInput } = await res.json();
      payload = allow
        ? { behavior: "allow", updatedInput: updatedInput ?? input ?? {} }
        : { behavior: "deny", message: message || "Denied by user on Discord." };
    } catch (err) {
      payload = {
        behavior: "deny",
        message: `Could not reach approval bridge: ${err.message}`,
      };
    }
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }
);

// ── PR review loop tools ─────────────────────────────────────────────────────
// These forward to the bridge, which drives the review/fix/merge conversation
// in a Discord thread. Coding agents call notify_pr_reviewer; the reviewer agent
// calls pr_request_changes / pr_ready_to_merge.
const postPr = async (path, body) => {
  try {
    await fetch(`http://127.0.0.1:${PORT}/pr/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    return "ok";
  } catch (err) {
    return `error: ${err.message}`;
  }
};

server.tool(
  "notify_pr_reviewer",
  "After opening or pushing to a pull request, ask the PR reviewer bot to (re)review it. Only available under the Discord bridge.",
  { pr_url: z.string() },
  async ({ pr_url }) => {
    const r = await postPr("notify", { prUrl: pr_url, originSessionKey: SESSION_KEY });
    return { content: [{ type: "text", text: `notify_pr_reviewer: ${r}` }] };
  }
);

server.tool(
  "pr_request_changes",
  "Reviewer only: report that a PR needs changes; the bridge routes the fix back to the author.",
  { pr_url: z.string(), summary: z.string() },
  async ({ pr_url, summary }) => {
    const r = await postPr("request-changes", { prUrl: pr_url, summary });
    return { content: [{ type: "text", text: `pr_request_changes: ${r}` }] };
  }
);

server.tool(
  "pr_ready_to_merge",
  "Reviewer only: report that a PR is approved; the bridge asks the human to merge.",
  { pr_url: z.string(), summary: z.string().optional() },
  async ({ pr_url, summary }) => {
    const r = await postPr("ready-to-merge", { prUrl: pr_url, summary: summary ?? "" });
    return { content: [{ type: "text", text: `pr_ready_to_merge: ${r}` }] };
  }
);

// Team-lead only: hand a self-contained task to another project channel's agent.
// The work runs and streams in that channel; the team lead monitors deliverables.
server.tool(
  "delegate",
  "Team lead only: assign a task to a project channel's agent (by channel name or id). The work runs in that channel. Right-size cost with model + effort: model 'haiku' (cheap/general), 'sonnet' (coding — the default for implementation), 'opus' (heavy reasoning/architecture/gnarly debugging); use 'fable' ONLY if Marc asks. effort is low|medium|high|xhigh|max — default medium; low for mechanical work, high/xhigh for hard design or debugging.",
  {
    channel: z.string(),
    task: z.string(),
    model: z.enum(["haiku", "sonnet", "opus", "fable"]).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  },
  async ({ channel, task, model, effort }) => {
    let r;
    try {
      await fetch(`http://127.0.0.1:${PORT}/tl/delegate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, task, model, effort }),
        signal: AbortSignal.timeout(10000),
      });
      r = "ok";
    } catch (err) {
      r = `error: ${err.message}`;
    }
    const tag = [model, effort].filter(Boolean).join("/");
    return {
      content: [
        { type: "text", text: `delegate -> ${channel}${tag ? ` [${tag}]` : ""}: ${r}` },
      ],
    };
  }
);

// Team-lead only: mirror the TASKS.md task board to the Trello board. The team
// lead builds the task list from TASKS.md (the fuzzy parse it's good at); the
// bridge does the deterministic card upserts and files each in its status list.
server.tool(
  "trello_sync",
  "Team lead only: mirror your TASKS.md tasks to the Trello board. Pass every active task with a stable `key` (a short slug that never changes, e.g. the repo/task name — this is how a card is matched across renames), `title`, `status` (one of todo | in-progress | blocked | in-review | done — mapped to the board's lists), and a one-line `body`. Set `archive_missing: true` only when you want cards whose key you DIDN'T include this call to be archived (e.g. a full-board resync). Call this each tick after updating TASKS.md, but skip it if nothing changed.",
  {
    tasks: z
      .array(
        z.object({
          key: z.string(),
          title: z.string(),
          status: z.enum(["todo", "in-progress", "blocked", "in-review", "done"]),
          body: z.string().optional(),
        })
      )
      .describe("Every active task from TASKS.md."),
    archive_missing: z.boolean().optional(),
  },
  async ({ tasks, archive_missing }) => {
    let text;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/trello/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tasks, archiveMissing: archive_missing }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await res.json();
      text = j.ok
        ? `synced ${tasks.length} task(s): +${j.created} created, ${j.moved} moved, ${j.updated} updated, ${j.archived} archived.`
        : `error: ${j.error}`;
    } catch (err) {
      text = `error: ${err.message}`;
    }
    return { content: [{ type: "text", text: `trello_sync: ${text}` }] };
  }
);

// Team-lead only: READ the Trello board on demand (cards + recent comments), so
// the team lead can check a comment Marc left without waiting for the poll feed.
server.tool(
  "trello_read",
  "Team lead only: READ the Trello board right now — returns the current cards (each with its status list, url, key, and `ref`) and recent comments Marc left. Use this to check a comment or the live board state on demand instead of waiting for the automatic heartbeat feed. A card with a null `key` is an untracked card Marc made by hand — pass its `ref` to trello_write (as `card_ref`) to comment/move/archive it. Optional `card_key` filters comments to one card (the same stable key you pass to trello_sync); `limit` caps how many recent comments to return (default 20).",
  {
    card_key: z.string().optional(),
    limit: z.number().optional(),
  },
  async ({ card_key, limit }) => {
    let text;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/trello/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardKey: card_key, limit }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await res.json();
      if (!j.ok) {
        text = `error: ${j.error}`;
      } else {
        const cards = (j.cards || [])
          .map((c) => `• [${c.status || "?"}] ${c.title}${c.key ? ` (key: ${c.key})` : ""} ${c.url || ""}`)
          .join("\n");
        const comments = (j.comments || [])
          .map((c) => `• ${c.date} — ${c.by || "?"} on "${c.card}": ${c.text}`)
          .join("\n");
        text =
          `Cards (${j.cards?.length || 0}):\n${cards || "(none)"}\n\n` +
          `Recent comments (${j.comments?.length || 0}):\n${comments || "(none)"}`;
      }
    } catch (err) {
      text = `error: ${err.message}`;
    }
    return { content: [{ type: "text", text }] };
  }
);

// Team-lead only: one targeted WRITE to the board on demand — reply to Marc,
// move/update/create/archive a single card — without waiting for the next sync.
server.tool(
  "trello_write",
  "Team lead only: make ONE targeted change to the Trello board right now. Use for a single immediate action (use trello_sync for the full-board mirror each tick). Identify the card by `card_key` (the stable task key of a card the team lead created) OR `card_ref` (a card id, shortLink, or trello.com/c/... URL — use this to reach cards Marc made by hand, which have no key; get their `ref` from trello_read). action: 'comment' (reply to Marc on a card — needs `text`), 'move' (change a card's status list — needs `status`), 'update' (change `title` and/or `body`), 'create' (needs `card_key` + `title`, optional `status`/`body`), 'archive'. status is one of todo | in-progress | blocked | in-review | done.",
  {
    action: z.enum(["comment", "move", "update", "create", "archive"]),
    card_key: z.string().optional(),
    card_ref: z.string().optional(),
    text: z.string().optional(),
    status: z.enum(["todo", "in-progress", "blocked", "in-review", "done"]).optional(),
    title: z.string().optional(),
    body: z.string().optional(),
  },
  async ({ action, card_key, card_ref, text, status, title, body }) => {
    let out;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/trello/write`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, cardKey: card_key, cardRef: card_ref, text, status, title, body }),
        signal: AbortSignal.timeout(30000),
      });
      const j = await res.json();
      out = j.ok
        ? `${j.action} on "${j.card}"${j.status ? ` -> ${j.status}` : ""}${j.url ? ` ${j.url}` : ""}`
        : `error: ${j.error}`;
    } catch (err) {
      out = `error: ${err.message}`;
    }
    return { content: [{ type: "text", text: `trello_write: ${out}` }] };
  }
);

// Share a file/document with the user by uploading it as a Discord attachment to
// this channel. The bridge resolves the path (relative paths are taken against
// the channel's project dir), enforces containment + a size cap, then uploads.
server.tool(
  "share_file",
  "Share a file/document with the user on Discord: uploads it as an attachment to this channel. Use for reports, exports, logs, screenshots, generated docs — anything better as a file than pasted text. `path` is absolute or relative to this channel's folder; for a file in another repo under the projects workspace, pass its ABSOLUTE path. `comment` is an optional caption. Returns an error (with the resolved path and allowed dirs) if the file is missing, too big, or outside the allowed dirs.",
  { path: z.string(), comment: z.string().optional() },
  async ({ path, comment }) => {
    let text;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/share`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: SESSION_KEY, path, comment }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await res.json();
      text = j.ok
        ? `shared "${j.name}" to the channel.`
        : `could not share: ${j.error}`;
    } catch (err) {
      text = `could not reach the bridge to share: ${err.message}`;
    }
    return { content: [{ type: "text", text: `share_file: ${text}` }] };
  }
);

// Control the host's Tunnelblick VPN, so an agent can bring the VPN up when a
// channel needs it to reach backend/database/services (e.g. connect, do the work).
server.tool(
  "vpn",
  "Control the Tunnelblick VPN on the host (macOS). action: 'status' (default), 'connect', 'disconnect', or 'list'. `config` is the Tunnelblick configuration name (e.g. 'Oseberg'); omit to use the default. Use this to bring the VPN up when a channel needs it to reach its backend/database/services — typically connect, do the work, then disconnect if desired. States: CONNECTED = up, EXITING = down.",
  {
    action: z.enum(["status", "connect", "disconnect", "list"]).optional(),
    config: z.string().optional(),
  },
  async ({ action, config }) => {
    let text;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/vpn`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, config }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await res.json();
      if (!j.ok) text = `error: ${j.error}`;
      else if (j.action === "list") text = `configs: ${j.configs}`;
      else text = `${j.action} ${j.config} -> ${j.state || "ok"}`;
    } catch (err) {
      text = `error: ${err.message}`;
    }
    return { content: [{ type: "text", text: `vpn: ${text}` }] };
  }
);

await server.connect(new StdioServerTransport());
