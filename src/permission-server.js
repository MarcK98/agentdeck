import { createServer } from "node:http";
import { config } from "./config.js";
import { log } from "./logger.js";
import { pauseInactivity, resumeInactivity } from "./claude.js";

// Adapters register a handler: (sessionKey, { toolName, input }) => Promise<{allow, message?}>
let handler = null;
export const setPermissionHandler = (fn) => (handler = fn);

// Local HTTP endpoint the approval MCP server (spawned inside each claude run)
// posts permission requests to.
export function startPermissionServer() {
  const { port } = config.approvals;

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/permission") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
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
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      log.info(`[approvals] listening on 127.0.0.1:${port}`);
      resolve(() => server.close());
    });
  });
}
