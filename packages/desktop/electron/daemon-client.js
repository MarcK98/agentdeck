import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import WebSocket from "ws";

// Client for the Spawn daemon (a separate background process). The desktop
// app NEVER touches sessions or SQLite directly — everything goes through
// the daemon's localhost API. If no daemon is running we start one, detached,
// so it outlives the app window.

const require = createRequire(import.meta.url);
const PORT = Number(process.env.SPAWN_DAEMON_PORT) || 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const SERVER_JS = require.resolve("@spawn/core/package.json").replace(
  /package\.json$/,
  "src/daemon/server.js"
);

// The daemon is plain Node (Electron's binary won't do): prefer an explicit
// override, then Homebrew node, then whatever PATH has.
const nodeBin = () => {
  if (process.env.SPAWN_NODE_BIN) return process.env.SPAWN_NODE_BIN;
  if (existsSync("/opt/homebrew/bin/node")) return "/opt/homebrew/bin/node";
  return "node";
};

const health = async () => {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) });
    return (await res.json()).ok === true;
  } catch {
    return false;
  }
};

export async function ensureDaemon() {
  if (await health()) return { started: false };
  const child = spawn(nodeBin(), [SERVER_JS], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await health()) return { started: true, pid: child.pid };
  }
  throw new Error("Spawn daemon did not come up on " + BASE);
}

export async function rpc(method, ...args) {
  const res = await fetch(`${BASE}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error || `rpc ${method} failed`);
  return body.result;
}

// Subscribe to daemon events; reconnects if the daemon restarts.
export function subscribeEvents(onEvent) {
  let ws;
  let closed = false;
  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/events`);
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
