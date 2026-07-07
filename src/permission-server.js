import { createServer } from "node:http";
import { config } from "./config.js";
import { log } from "./logger.js";
import { pauseInactivity, resumeInactivity } from "./claude.js";
import { onNotify, onRequestChanges, onReadyToMerge } from "./pr-reviewer.js";
import { onDelegate } from "./teamlead.js";

// Adapters register a handler: (sessionKey, { toolName, input }) => Promise<{allow, message?}>
let handler = null;
export const setPermissionHandler = (fn) => (handler = fn);

const readBody = (req) =>
  new Promise((resolve) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => resolve(b));
  });

// Local HTTP endpoint the approval MCP server (spawned inside each claude run)
// posts to — both permission prompts and the PR review loop hooks.
export function startPermissionServer() {
  const { port } = config.approvals;

  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }

    // PR review loop: ack immediately and run the (possibly long) handler in the
    // background so the MCP tool call returns fast. Handlers own their errors.
    if (req.url.startsWith("/pr/")) {
      const body = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        return;
      }
      const fn =
        req.url === "/pr/notify"
          ? onNotify
          : req.url === "/pr/request-changes"
            ? onRequestChanges
            : req.url === "/pr/ready-to-merge"
              ? onReadyToMerge
              : null;
      if (fn) {
        Promise.resolve(fn(data)).catch((err) =>
          log.error(`[pr] ${req.url} failed:`, err.message)
        );
      }
      return;
    }

    // Team-lead delegation: same fire-and-forget pattern.
    if (req.url.startsWith("/tl/")) {
      const body = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        return;
      }
      if (req.url === "/tl/delegate") {
        Promise.resolve(onDelegate(data)).catch((err) =>
          log.error("[teamlead] delegate failed:", err.message)
        );
      }
      return;
    }

    if (req.url !== "/permission") {
      res.writeHead(404).end();
      return;
    }

    const body = await readBody(req);
    let result = { allow: false, message: "No approval handler registered." };
    try {
      const { sessionKey, toolName, input } = JSON.parse(body);
      log.info(`[approvals] ${sessionKey} requests ${toolName}`);
      if (handler) {
        // Waiting on a human shouldn't count as Claude being idle.
        pauseInactivity(sessionKey);
        try {
          result = await handler(sessionKey, { toolName, input });
        } finally {
          resumeInactivity(sessionKey);
        }
      }
    } catch (err) {
      log.error("[approvals] failed:", err.message);
      result = { allow: false, message: `Approval flow error: ${err.message}` };
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      log.info(`[approvals] listening on 127.0.0.1:${port}`);
      resolve(() => server.close());
    });
  });
}
