import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import WebSocket from "ws";
import { dataPath, daemonBuildSig } from "@agentdeck/core/config";

// Client for the AgentDeck daemon (a separate background process). The desktop
// app NEVER touches sessions or SQLite directly — everything goes through
// the daemon's localhost API. If no daemon is running we start one, detached,
// so it outlives the app window.
//
// Auth: the daemon writes a per-start secret to agentdeck-daemon.token (0600) in
// SPAWN_DATA_DIR; we read it fresh for every call (it rotates whenever the
// daemon restarts) and send it as x-spawn-token. Browsers can't read local
// files, which is the point — see server.js for the threat model.

const require = createRequire(import.meta.url);
const PORT = Number(process.env.SPAWN_DAEMON_PORT) || 8810; // must match daemon/server.js
const BASE = `http://127.0.0.1:${PORT}`;

const SERVER_JS = require.resolve("@agentdeck/core/package.json").replace(
  /package\.json$/,
  "src/daemon/server.js"
);

const readToken = () => {
  try {
    return readFileSync(dataPath("agentdeck-daemon.token"), "utf8").trim();
  } catch {
    return "";
  }
};

// The daemon is plain Node (Electron's binary won't do): prefer an explicit
// override, then Homebrew node, then whatever PATH has.
const nodeBin = () => {
  if (process.env.SPAWN_NODE_BIN) return process.env.SPAWN_NODE_BIN;
  if (existsSync("/opt/homebrew/bin/node")) return "/opt/homebrew/bin/node";
  return "node";
};

// The source fingerprint of the daemon code THIS app ships (see config.js).
const BUILD = daemonBuildSig();

// Probe /health once. Returns whether a daemon is up, and — since it's a
// detached process that outlives the app — whether it's running our build. A
// daemon started before a code change keeps serving stale RPC methods, so a
// build mismatch means "must restart", not "healthy".
const probe = async () => {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
    const body = await res.json();
    if (body.ok !== true) return { up: false };
    return { up: true, pid: body.pid, stale: !!body.build && !!BUILD && body.build !== BUILD };
  } catch {
    return { up: false };
  }
};

// Ask a running daemon to exit and wait for it to stop answering. Best-effort:
// if the pid is unknown or the signal fails we just fall through to spawn (the
// new daemon exits cleanly on EADDRINUSE if the old one is somehow still bound).
const stopDaemon = async (pid) => {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already gone / not ours
  }
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!(await probe()).up) return;
  }
};

export async function ensureDaemon() {
  const cur = await probe();
  if (cur.up && !cur.stale) return { started: false };
  // A live daemon running older code would 400 on newer RPC methods — replace it.
  if (cur.up && cur.stale) await stopDaemon(cur.pid);
  // A detached daemon has no console — append its stdout+stderr to a log file
  // so crashes/warnings are diagnosable. (`npm run daemon` still logs to the
  // console; this path only runs when the desktop app spawns the daemon.)
  const logFd = openSync(dataPath("agentdeck-daemon.log"), "a");
  const child = spawn(nodeBin(), [SERVER_JS], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd); // the child holds its own copy
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const p = await probe();
    // Require our build so a stale daemon that ignored SIGTERM (and is still
    // holding the port) is never mistaken for the fresh one we just spawned.
    if (p.up && !p.stale) return { started: true, pid: child.pid, replaced: cur.stale };
  }
  throw new Error("AgentDeck daemon did not come up on " + BASE);
}

export async function rpc(method, ...args) {
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-spawn-token": readToken(),
    },
    body: JSON.stringify({ method, args }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || `rpc ${method} failed`);
  return body.result;
}

// Subscribe to daemon events; reconnects (with a fresh token) if the daemon
// restarts.
export function subscribeEvents(onEvent) {
  let ws;
  let closed = false;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`, {
      headers: { "x-spawn-token": readToken() },
    });
    ws.on("message", (data) => {
      try {
        onEvent(JSON.parse(data.toString()));
      } catch {
        /* ignore malformed */
      }
    });
    ws.on("close", () => setTimeout(connect, 1000));
    ws.on("error", () => ws.close());
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
