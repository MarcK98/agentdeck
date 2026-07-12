import { createServer } from "node:http";
import { config } from "./config.js";
import { log } from "./logger.js";
import { pauseInactivity, resumeInactivity } from "./claude.js";
import { onNotify, onRequestChanges, onReadyToMerge } from "./pr-reviewer.js";
import { onDelegate } from "./teamlead.js";
import { controlVpn } from "./vpn.js";
import { syncTasks, readBoard, writeCard } from "./trello.js";

// Adapters register a handler: (sessionKey, { toolName, input }) => Promise<{allow, message?}>
let handler = null;
export const setPermissionHandler = (fn) => (handler = fn);

// Adapters register a file-share handler: ({ sessionKey, path, comment }) =>
// Promise<{ ok, name? , error? }>. Uploads a file to the channel on Discord.
let shareHandler = null;
export const setShareHandler = (fn) => (shareHandler = fn);

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

    // VPN control: toggle Tunnelblick on the host. Waits for the result so the
    // calling agent learns the resulting state (or a clear error to act on).
    if (req.url === "/vpn") {
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        /* fall through with empty data */
      }
      let result;
      try {
        result = await controlVpn(data);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // Trello sync: upsert the team lead's TASKS.md tasks as board cards. Waits
    // for the result so the calling agent learns what changed (or a clear error).
    if (req.url === "/trello/sync") {
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        /* fall through with empty data */
      }
      let result;
      try {
        result = await syncTasks(data);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // Trello read: on-demand board snapshot (cards + recent comments) so the team
    // lead can check a comment without waiting for the poll feed.
    if (req.url === "/trello/read") {
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        /* fall through with empty data */
      }
      let result;
      try {
        result = await readBoard(data);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // Trello write: one on-demand change (comment/move/update/create/archive).
    if (req.url === "/trello/write") {
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        /* fall through with empty data */
      }
      let result;
      try {
        result = await writeCard(data);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    // File sharing: upload a file to the channel on Discord. Unlike the
    // fire-and-forget hooks above, we wait for the upload and return the result
    // so the calling agent learns whether it succeeded (missing/too big/etc.).
    if (req.url === "/share") {
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || "{}");
      } catch {
        /* fall through with empty data */
      }
      let result = { ok: false, error: "No share handler registered." };
      if (shareHandler) {
        pauseInactivity(data.sessionKey); // uploading isn't Claude being idle
        try {
          result = await shareHandler(data);
        } catch (err) {
          result = { ok: false, error: err.message };
        } finally {
          resumeInactivity(data.sessionKey);
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
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
