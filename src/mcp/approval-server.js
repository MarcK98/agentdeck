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
  "Team lead only: assign a task to a project channel's agent (by channel name or id). The work runs in that channel.",
  { channel: z.string(), task: z.string() },
  async ({ channel, task }) => {
    let r;
    try {
      await fetch(`http://127.0.0.1:${PORT}/tl/delegate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, task }),
        signal: AbortSignal.timeout(10000),
      });
      r = "ok";
    } catch (err) {
      r = `error: ${err.message}`;
    }
    return { content: [{ type: "text", text: `delegate -> ${channel}: ${r}` }] };
  }
);

await server.connect(new StdioServerTransport());
