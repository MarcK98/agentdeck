import { createServer } from "node:http";
import { log } from "../logger.js";

// Approval hub — routes Claude's permission prompts to the desktop app.
//
// When the daemon runs Claude with approvals in "prompt" mode, the run's
// approver MCP (mcp/approval-server.js, spawned INSIDE the Claude child)
// POSTs {sessionKey, toolName, input} to 127.0.0.1:$BRIDGE_APPROVAL_PORT
// /permission and blocks until it gets {allow, message?, updatedInput?}.
// The daemon points that env at THIS listener; we park the request as a
// pending entry, emit `approval:request` to clients, and answer when a
// client calls the daemon's resolveApproval() (or the timeout fires).
//
// Security: host-header allowlist like server.js, but no token — the only
// intended caller is the child MCP we spawned, and a spoofed local request
// can at worst pop a modal the user denies. Nothing here reveals secrets.

const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function createApprovalHub({
  emit,
  pauseInactivity,
  resumeInactivity,
  timeoutMs = 300000,
  // 8811 — clear of the bridge's Trello webhook (8792), which the Phase-1
  // default collided with.
  port = Number(process.env.SPAWN_DAEMON_APPROVAL_PORT) || 8811,
} = {}) {
  let nextId = 1;
  const pending = new Map(); // id -> { id, threadId, sessionKey, tool, input, respond, timer }

  // "spawn:thread:<id>" -> <id>; null for keys from other adapters.
  const threadIdOf = (sessionKey) => {
    const m = /^spawn:thread:(\d+)$/.exec(sessionKey ?? "");
    return m ? Number(m[1]) : null;
  };

  const settle = (entry, body, allow) => {
    if (!pending.delete(entry.id)) return false; // already settled
    clearTimeout(entry.timer);
    resumeInactivity?.(entry.sessionKey);
    entry.respond(body);
    emit?.("approval:resolved", { id: entry.id, threadId: entry.threadId, allow });
    return true;
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1e6) reject(new Error("body too large"));
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });

  const server = createServer(async (req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      if (!HOST_RE.test(req.headers.host ?? "")) {
        return json(403, { allow: false, message: "forbidden host" });
      }
      if (req.method !== "POST" || req.url !== "/permission") {
        return json(404, { allow: false, message: "not found" });
      }
      const { sessionKey, toolName, input = {} } = JSON.parse(await readBody(req));
      const entry = {
        id: nextId++,
        threadId: threadIdOf(sessionKey),
        sessionKey,
        tool: toolName,
        input,
        respond: (body) => {
          if (!res.headersSent) json(200, body);
        },
      };
      pending.set(entry.id, entry);
      // The run's inactivity clock must not tick while a human decides.
      pauseInactivity?.(sessionKey);
      entry.timer = setTimeout(() => {
        settle(entry, { allow: false, message: "Approval timed out." }, false);
      }, timeoutMs);
      emit?.("approval:request", {
        id: entry.id,
        threadId: entry.threadId,
        tool: entry.tool,
        input: entry.input,
      });
    } catch (err) {
      json(500, { allow: false, message: err.message });
    }
  });

  server.on("error", (err) => {
    // Don't take the daemon down over a busy port — run without approvals
    // (prompts will auto-deny with "Could not reach approval bridge").
    if (err.code === "EADDRINUSE") {
      log.warn(`[agentdeck-daemon] approval port ${port} busy — approval prompts disabled`);
    } else {
      log.warn(`[agentdeck-daemon] approval hub error: ${err.message}`);
    }
  });

  server.listen(port, "127.0.0.1", () => {
    log.info(`[agentdeck-daemon] approval hub on 127.0.0.1:${port}`);
  });

  return {
    port,

    // Fulfill a pending prompt (from the desktop's Allow/Deny buttons).
    // Unknown/duplicate ids are ignored — returns whether anything settled.
    resolve(id, allow, updatedInput) {
      const entry = pending.get(id);
      if (!entry) return false;
      const body = allow
        ? { allow: true, updatedInput: updatedInput ?? entry.input }
        : { allow: false, message: "Denied in AgentDeck." };
      return settle(entry, body, Boolean(allow));
    },

    // Pending prompts, client-shaped (no resolve internals).
    pending() {
      return [...pending.values()].map(({ id, threadId, tool, input }) => ({
        id,
        threadId,
        tool,
        input,
      }));
    },

    close() {
      for (const entry of [...pending.values()]) {
        settle(entry, { allow: false, message: "AgentDeck daemon shutting down." }, false);
      }
      server.close();
    },
  };
}
