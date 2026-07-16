// Spawn daemon — standalone background process (a mastermind for Claude).
// Owns Claude sessions, threads, and the SQLite store; clients (the desktop
// app today, mobile later) connect over localhost:
//
//   GET  /health           -> { ok, pid, version }            (host-checked)
//   POST /rpc              -> { method, args: [...] }         (host + token)
//   WS   /events           -> stream of { type, payload }     (host + token)
//
// Security model (this drives arbitrary agent execution, so localhost bind is
// NOT enough — any webpage on this machine can reach 127.0.0.1):
//   - Binds 127.0.0.1 only.
//   - Host-header allowlist on every request AND the WS upgrade — defeats DNS
//     rebinding (a rebound page arrives with the attacker's Host).
//   - Per-start shared secret: random token written 0600 into SPAWN_DATA_DIR
//     (spawn-daemon.token); /rpc and /events require it in x-spawn-token.
//     Browsers can't read local files, so a same-machine page can't obtain it
//     — closes CSRF (including no-preflight text/plain POSTs).
//   - /health stays tokenless by design: it only reveals liveness, and the
//     client needs it before it can read a fresh token.
// Remote/mobile access is a future phase and will come through an
// authenticated layer (Supabase Auth) in front of this same surface — never
// by exposing this port.
//
// Run: `npm run daemon` (repo root) or `node packages/core/src/daemon/server.js`.

// The daemon owns its own Claude session ledger — the Discord bridge (a
// separate process) owns sessions.json; sharing one file would clobber each
// other's writes. MUST be set before claude.js loads, hence the dynamic
// imports below (static imports would hoist above this line).
process.env.SPAWN_SESSIONS_FILE ??= "spawn-daemon-sessions.json";

const { createServer } = await import("node:http");
const { randomBytes, timingSafeEqual } = await import("node:crypto");
const { writeFileSync, readFileSync, unlinkSync } = await import("node:fs");
const { WebSocketServer } = await import("ws");
const { createDaemon } = await import("./index.js");
const { dataPath } = await import("../config.js");
const { log } = await import("../logger.js");

// 8810/8811 — clear of the bridge's ports (approvals 8790, dashboard 8791,
// Trello webhook 8792), which the Phase-1 defaults collided with.
const PORT = Number(process.env.SPAWN_DAEMON_PORT) || 8810;
const VERSION = "0.1.0";

// Per-start shared secret. 0600 so only this user can read it; the desktop
// client reads the file and sends it back as a header. Written only AFTER a
// successful listen (see below) — a second daemon losing the port race must
// never clobber the live daemon's token.
const TOKEN = randomBytes(32).toString("hex");
const TOKEN_FILE = dataPath("spawn-daemon.token");
const PID_FILE = dataPath("spawn-daemon.pid");

// Only ever reachable as localhost — any other Host means DNS rebinding or a
// misrouted request. Applied to both HTTP requests and the WS upgrade.
const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const hostOk = (req) => HOST_RE.test(req.headers.host ?? "");

const tokenOk = (req) => {
  const got = req.headers["x-spawn-token"];
  if (typeof got !== "string" || got.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
};

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
    if (!hostOk(req)) return json(403, { ok: false, error: "forbidden host" });
    if (req.method === "GET" && req.url === "/health") {
      return json(200, { ok: true, pid: process.pid, version: VERSION });
    }
    if (req.method === "POST" && req.url === "/rpc") {
      if (!tokenOk(req)) return json(401, { ok: false, error: "missing or bad token" });
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

// Single-instance: whoever wins the port bind is THE daemon. A loser exits
// cleanly and must not touch the winner's token/pid files (`bound` guards
// the shutdown cleanup; the token is only written after a successful bind).
// Registered BEFORE the WebSocketServer attaches — ws re-emits server errors
// on itself (and throws, unhandled), which would shadow this handler.
let bound = false;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log.info(`[spawn-daemon] port ${PORT} busy — another daemon already running; exiting`);
    process.exit(0);
  }
  throw err;
});

const wss = new WebSocketServer({
  server,
  path: "/events",
  verifyClient: ({ req }) => hostOk(req) && tokenOk(req),
});
daemon.events.on("event", (ev) => {
  const msg = JSON.stringify(ev);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(msg);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  bound = true;
  writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 });
  writeFileSync(PID_FILE, String(process.pid), { mode: 0o644 });
  log.info(`[spawn-daemon] listening on 127.0.0.1:${PORT} (pid ${process.pid})`);
});

const shutdown = () => {
  log.info("[spawn-daemon] shutting down");
  if (bound) {
    try {
      unlinkSync(TOKEN_FILE);
    } catch {
      /* already gone */
    }
    try {
      // Only remove the pid file if it's still ours (a newer daemon may own it).
      if (readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) {
        unlinkSync(PID_FILE);
      }
    } catch {
      /* already gone */
    }
  }
  daemon._approvalHub?.close();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
