#!/usr/bin/env node
// Stdio MCP server attached to TEAM-LEAD runs (SPAWN_BOARD_ROLE=lead) and to
// ticket runs (SPAWN_BOARD_ROLE=agent, SPAWN_BOARD_TICKET_ID=<id>). It gives:
//  - the lead pull-based access to the board archive + the ability to delegate
//    and to comment back on a ticket after acting on a human comment;
//  - a working agent the ability to comment progress on / attach files to its
//    own ticket (id defaults to SPAWN_BOARD_TICKET_ID).
//
// Talks to the local AgentDeck daemon's /rpc using the per-start token file
// (same-user read), so there is exactly one reader of the SQLite store.
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dataPath } from "../config.js";

const PORT = Number(process.env.SPAWN_DAEMON_PORT) || 8810;
const ROLE = process.env.SPAWN_BOARD_ROLE === "lead" ? "lead" : "agent";
const DEFAULT_TICKET = Number(process.env.SPAWN_BOARD_TICKET_ID) || null;
const AUTHOR_NAME = ROLE === "lead" ? "team lead" : "agent";

const rpc = async (method, ...args) => {
  const token = readFileSync(dataPath("agentdeck-daemon.token"), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${PORT}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-spawn-token": token },
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || `rpc ${method} failed`);
  return body.result;
};

// Ticket id: explicit arg wins; otherwise the run's own ticket (agent runs).
const resolveId = (id) => {
  const n = id ?? DEFAULT_TICKET;
  if (!n) throw new Error("no ticket id (pass `id`)");
  return n;
};

const server = new McpServer({ name: "board", version: "1.0.0" });

const fmtTicket = (k) =>
  `• SPWN-${k.id} [${k.status}] ${k.project_name}: ${k.title}` +
  `${k.branch ? ` (${k.branch})` : ""} · updated ${k.updated_at}`;

const fmtComment = (c) => `[${c.author_name || c.author_kind} · ${c.created_at}] ${c.body}`;
const fmtAttachment = (a) => `• ${a.name} (${a.size} bytes, by ${a.uploaded_by || "?"}) — ${a.path}`;

const ok = (text) => ({ content: [{ type: "text", text }] });
const guard = async (fn) => {
  try {
    return ok(await fn());
  } catch (err) {
    return ok(`error: ${err.message}`);
  }
};

server.tool(
  "search_tickets",
  "Search the AgentDeck board — ALL tickets, including the Done archive (which is omitted from your standing context). Use when asked about past/finished work. `query` matches title and body; optional `status` (todo|in-progress|blocked|in-review|done) and `project` (project name) filters; `limit` default 20.",
  {
    query: z.string().optional(),
    status: z.enum(["todo", "in-progress", "blocked", "in-review", "done"]).optional(),
    project: z.string().optional(),
    limit: z.number().optional(),
  },
  ({ query, status, project, limit }) =>
    guard(async () => {
      const rows = await rpc("searchTickets", { query, status, project, limit });
      return rows.length ? rows.map(fmtTicket).join("\n") : "No tickets matched.";
    })
);

server.tool(
  "get_ticket",
  "Fetch one AgentDeck ticket by its number (the N in SPWN-N): full body, its comment thread, attachments, and the closing messages of its run. Works for archived (done) tickets.",
  { id: z.number().optional() },
  ({ id }) =>
    guard(async () => {
      const tid = resolveId(id);
      const [k, comments, attachments] = await Promise.all([
        rpc("getTicketDetail", tid),
        rpc("listTicketComments", tid),
        rpc("listTicketAttachments", tid),
      ]);
      return (
        `${fmtTicket(k)}\n\n${k.body || "(no body)"}` +
        (comments.length ? `\n\nComments:\n${comments.map(fmtComment).join("\n")}` : "") +
        (attachments.length ? `\n\nAttachments:\n${attachments.map(fmtAttachment).join("\n")}` : "") +
        (k.outcome?.length
          ? `\n\nOutcome (closing messages):\n${k.outcome.map((t) => `> ${t.split("\n").join("\n> ")}`).join("\n---\n")}`
          : "\n\n(never delegated — no run transcript)")
      );
    })
);

server.tool(
  "comment_on_ticket",
  "Post a comment on a AgentDeck ticket — this is how you reply to the owner (the human) or leave progress notes. `id` defaults to the ticket this run is working on. Keep it short.",
  { id: z.number().optional(), comment: z.string() },
  ({ id, comment }) =>
    guard(async () => {
      const tid = resolveId(id);
      await rpc("addTicketComment", tid, { authorKind: ROLE, authorName: AUTHOR_NAME, body: comment });
      return `commented on SPWN-${tid}`;
    })
);

server.tool(
  "list_ticket_comments",
  "List the comment thread of a AgentDeck ticket (human + lead + agent). `id` defaults to this run's ticket.",
  { id: z.number().optional() },
  ({ id }) =>
    guard(async () => {
      const rows = await rpc("listTicketComments", resolveId(id));
      return rows.length ? rows.map(fmtComment).join("\n") : "No comments yet.";
    })
);

server.tool(
  "upload_ticket_attachment",
  "Attach a file (report, screenshot, export, log) to a AgentDeck ticket so the owner sees it. `path` is an absolute path to a file on this machine; it is copied into the ticket. `id` defaults to this run's ticket.",
  { id: z.number().optional(), path: z.string() },
  ({ id, path }) =>
    guard(async () => {
      const tid = resolveId(id);
      const a = await rpc("addTicketAttachment", tid, path, AUTHOR_NAME);
      return `attached ${a.name} to SPWN-${tid}`;
    })
);

server.tool(
  "list_ticket_attachments",
  "List files attached to a AgentDeck ticket. `id` defaults to this run's ticket.",
  { id: z.number().optional() },
  ({ id }) =>
    guard(async () => {
      const rows = await rpc("listTicketAttachments", resolveId(id));
      return rows.length ? rows.map(fmtAttachment).join("\n") : "No attachments.";
    })
);

server.tool(
  "delegate_ticket",
  "Delegate a backlog ticket to a fresh agent that will do the work (creates its run + branch). Use after deciding a ticket needs implementation. Optional `model` and `effort` override defaults. Fails if the ticket is already delegated.",
  {
    id: z.number(),
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
  },
  ({ id, model, effort }) =>
    guard(async () => {
      const r = await rpc("delegateTicket", id, { model, effort });
      return `delegated SPWN-${id} (thread ${r.threadId ?? "?"})`;
    })
);

await server.connect(new StdioServerTransport());
