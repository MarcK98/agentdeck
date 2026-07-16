// Spawn daemon — standalone background process (a mastermind for Claude).
// Owns Claude sessions, threads, and the SQLite store; clients (the desktop
// app today, mobile later) connect over localhost:
//
//   GET  /health           -> { ok, pid, version }
//   POST /rpc              -> { method, args: [...] } -> { ok, result | error }
//   WS   /events           -> stream of { type, payload } daemon events
//
// Binds 127.0.0.1 ONLY. Remote/mobile access is a future phase and will come
// through an authenticated layer (Supabase Auth) in front of this same
// surface — never by exposing this port.
//
// Run: `npm run daemon` (repo root) or `node packages/core/src/daemon/server.js`.

// The daemon owns its own Claude session ledger — the Discord bridge (a
// separate process) owns sessions.json; sharing one file would clobber each
// other's writes. MUST be set before claude.js loads, hence the dynamic
// imports below (static imports would hoist above this line).
process.env.SPAWN_SESSIONS_FILE ??= "spawn-daemon-sessions.json";

const { createServer } = await import("node:http");
const { WebSocketServer } = await import("ws");
const { createDaemon } = await import("./index.js");
const { log } = await import("../logger.js");

const PORT = Number(process.env.SPAWN_DAEMON_PORT) || 8791;
const VERSION = "0.1.0";

const daemon = createDaemon();

// Methods a client may call = every public daemon function except the emitter.
const METHODS = new Set(
  Object.entries(daemon)
    .filter(([k, v]) => typeof v === "function" && k !== "events")
    .map(([k]) => k)
);

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
    if (req.method === "GET" && req.url === "/health") {
      return json(200, { ok: true, pid: process.pid, version: VERSION });
    }
    if (req.method === "POST" && req.url === "/rpc") {
      const { method, args = [] } = JSON.parse(await readBody(req));
      if (!METHODS.has(method)) return json(400, { ok: false, error: `unknown method: ${method}` });
      const result = await daemon[method](...args);
      return json(200, { ok: true, result });
    }
    json(404, { ok: false, error: "not found" });
  } catch (err) {
    json(500, { ok: false, error: err.message });
  }
});

const wss = new WebSocketServer({ server, path: "/events" });
daemon.events.on("event", (ev) => {
  const msg = JSON.stringify(ev);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log.info(`[spawn-daemon] listening on 127.0.0.1:${PORT} (pid ${process.pid})`);
});

const shutdown = () => {
  log.info("[spawn-daemon] shutting down");
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
