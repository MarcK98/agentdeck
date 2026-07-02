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

await server.connect(new StdioServerTransport());
