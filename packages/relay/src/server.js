// Spawn relay — the cloud hop between phones and the local Spawn daemon.
//
//   daemon ──(outbound WS, RELAY_DAEMON_KEY)──▶ ┌───────┐ ◀──(WS + user token)── phone
//                                               │ relay │
//   RPC replies + event stream ◀───────────────▶ └───────┘ ◀──▶ RPC calls
//
// The daemon dials OUT (its port never opens to the world); phones dial in
// with a user token. Message shapes:
//   phone → relay:  { id, method, args }            (RPC)
//   relay → daemon: { id, method, args }            (forwarded, id namespaced)
//   daemon → relay: { id, ok, result|error }        (RPC reply)
//   daemon → relay: { event: { type, payload } }    (event fan-out)
//   relay → phone:  { id, ok, result|error } | { event } | { relay: "..." }
//
// Auth (phones) — pluggable, in order:
//   - SUPABASE_JWT_SECRET set → verify HS256 Supabase access token (prod).
//   - else RELAY_DEV_TOKEN set → constant-time compare (dev / pre-Supabase).
//   - neither set → refuse to start client auth (fail closed).
// Daemon auth: RELAY_DAEMON_KEY exact match, always required.
//
// Stateless by design: no storage, one daemon connection ("the Mac"), any
// number of phone connections. Deploy to any Node host; run locally in dev.
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { jwtVerify } from "jose";

// RELAY_PORT for local dev; PORT is what Railway/Fly inject.
const PORT = Number(process.env.RELAY_PORT || process.env.PORT) || 8820;
const DAEMON_KEY = process.env.RELAY_DAEMON_KEY || "";
const DEV_TOKEN = process.env.RELAY_DEV_TOKEN || "";
const SUPABASE_SECRET = process.env.SUPABASE_JWT_SECRET || "";

if (!DAEMON_KEY) {
  console.error("[relay] RELAY_DAEMON_KEY is required");
  process.exit(1);
}

const safeEq = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// Verify a phone's token → user id string, or null.
async function verifyClient(token) {
  if (!token) return null;
  if (SUPABASE_SECRET) {
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(SUPABASE_SECRET), {
        algorithms: ["HS256"],
      });
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }
  if (DEV_TOKEN) return safeEq(token, DEV_TOKEN) ? "dev-user" : null;
  return null; // fail closed: no verifier configured
}

let daemonWs = null; // the one Mac
const phones = new Set(); // connected clients
let nextNs = 1; // namespace for RPC ids so phones can't collide
const pending = new Map(); // namespacedId -> { phone, originalId }

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, daemon: daemonWs?.readyState === WebSocket.OPEN, phones: phones.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url ?? "/", "http://relay");
  const role = url.pathname === "/daemon" ? "daemon" : "phone";

  if (role === "daemon") {
    if (!safeEq(url.searchParams.get("key") ?? "", DAEMON_KEY)) {
      ws.close(4001, "bad daemon key");
      return;
    }
    // Newest daemon connection wins (a restarted daemon replaces the stale WS).
    daemonWs?.close(4000, "replaced");
    daemonWs = ws;
    console.log("[relay] daemon connected");
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.event) {
        // Event fan-out to every phone.
        const packet = JSON.stringify({ event: msg.event });
        for (const p of phones) if (p.readyState === WebSocket.OPEN) p.send(packet);
        return;
      }
      // RPC reply → route to the asking phone, restore its id.
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (entry.phone.readyState === WebSocket.OPEN) {
        entry.phone.send(JSON.stringify({ ...msg, id: entry.originalId }));
      }
    });
    ws.on("close", () => {
      if (daemonWs === ws) {
        daemonWs = null;
        console.log("[relay] daemon disconnected");
        const packet = JSON.stringify({ relay: "daemon-offline" });
        for (const p of phones) if (p.readyState === WebSocket.OPEN) p.send(packet);
      }
    });
    return;
  }

  // Phone: authenticate before anything else.
  const user = await verifyClient(url.searchParams.get("token") ?? "");
  if (!user) {
    ws.close(4001, "unauthorized");
    return;
  }
  phones.add(ws);
  console.log(`[relay] phone connected (${user}); ${phones.size} online`);
  ws.send(JSON.stringify({ relay: daemonWs ? "ready" : "daemon-offline" }));

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof msg.method !== "string") return;
    if (!daemonWs || daemonWs.readyState !== WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: "daemon offline" }));
      return;
    }
    const nsId = `r${nextNs++}`;
    pending.set(nsId, { phone: ws, originalId: msg.id });
    daemonWs.send(JSON.stringify({ id: nsId, method: msg.method, args: msg.args ?? [] }));
    // Don't let a dead daemon strand the phone forever.
    setTimeout(() => {
      if (pending.delete(nsId) && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: "daemon timeout" }));
      }
    }, 30_000);
  });
  ws.on("close", () => phones.delete(ws));
});

server.listen(PORT, () => {
  console.log(
    `[relay] listening on :${PORT} — auth: ${SUPABASE_SECRET ? "supabase" : DEV_TOKEN ? "dev-token" : "NONE (clients refused)"}`
  );
});
