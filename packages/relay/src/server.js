// AgentDeck relay — the cloud hop between phones and the local AgentDeck daemon.
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
// Auth (phones) — pluggable, verified in order (any configured secret accepted):
//   - AUTH_JWT_SECRET set → POST /auth/login (email+password) issues an HS256
//     JWT signed with it; the WS then verifies that token. Self-owned login.
//   - SUPABASE_JWT_SECRET set → verify HS256 Supabase access token.
//   - RELAY_DEV_TOKEN set → constant-time compare (dev / pre-login).
//   - none set → refuse client auth (fail closed).
// Daemon auth: RELAY_DAEMON_KEY exact match, always required.
//
// AUTH_USERS provisions the login accounts (no signup): JSON object mapping
// email → scrypt hash "scrypt$<saltHex>$<hashHex>" (generate with
// scripts/hash-password.mjs). Passwords are never stored in the clear.
//
// Stateless by design (bar an in-memory login-attempt limiter): no storage, one
// daemon connection ("the Mac"), any number of phone connections.
import { createServer } from "node:http";
import { timingSafeEqual, scryptSync } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { SignJWT, jwtVerify } from "jose";

// RELAY_PORT for local dev; PORT is what Railway/Fly inject.
const PORT = Number(process.env.RELAY_PORT || process.env.PORT) || 8820;
const DAEMON_KEY = process.env.RELAY_DAEMON_KEY || "";
const DEV_TOKEN = process.env.RELAY_DEV_TOKEN || "";
const SUPABASE_SECRET = process.env.SUPABASE_JWT_SECRET || "";
const AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || "";
const TOKEN_TTL = process.env.AUTH_TOKEN_TTL || "30d";

if (!DAEMON_KEY) {
  console.error("[relay] RELAY_DAEMON_KEY is required");
  process.exit(1);
}

// Provisioned accounts: { email: "scrypt$<saltHex>$<hashHex>" }. Parsed once.
let USERS = {};
try {
  USERS = process.env.AUTH_USERS ? JSON.parse(process.env.AUTH_USERS) : {};
} catch {
  console.error("[relay] AUTH_USERS is not valid JSON — no login accounts loaded");
}

const enc = (s) => new TextEncoder().encode(s);
const safeEq = (a, b) => {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// Constant-time password check against a stored "scrypt$<saltHex>$<hashHex>".
function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, "hex");
  let got;
  try {
    got = scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
  } catch {
    return false;
  }
  return expected.length === got.length && timingSafeEqual(expected, got);
}

// Issue a signed session token for a logged-in email.
async function issueToken(email) {
  return new SignJWT({ sub: email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(enc(AUTH_JWT_SECRET));
}

// Verify a phone's token → user id string, or null. Tries each configured JWT
// secret (self-owned first, then Supabase), then the dev token.
async function verifyClient(token) {
  if (!token) return null;
  for (const secret of [AUTH_JWT_SECRET, SUPABASE_SECRET]) {
    if (!secret) continue;
    try {
      const { payload } = await jwtVerify(token, enc(secret), { algorithms: ["HS256"] });
      return payload.sub ?? null;
    } catch {
      /* try the next secret */
    }
  }
  if (DEV_TOKEN) return safeEq(token, DEV_TOKEN) ? "dev-user" : null;
  return null; // fail closed: no verifier configured
}

// Light brute-force guard: lock an email after repeated failures. In-memory.
const attempts = new Map(); // email -> { count, until }
function loginLocked(email) {
  const a = attempts.get(email);
  return a && a.until > Date.now();
}
function noteLogin(email, ok) {
  if (ok) return attempts.delete(email);
  const a = attempts.get(email) ?? { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 5) a.until = Date.now() + 60_000; // 60s lockout after 5 fails
  attempts.set(email, a);
}

let daemonWs = null; // the one Mac
const phones = new Set(); // connected clients
let nextNs = 1; // namespace for RPC ids so phones can't collide
const pending = new Map(); // namespacedId -> { phone, originalId }

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const sendJson = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
};

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }
  if (req.url === "/health") {
    sendJson(res, 200, { ok: true, daemon: daemonWs?.readyState === WebSocket.OPEN, phones: phones.size });
    return;
  }
  // Email + password → session JWT (no signup; accounts come from AUTH_USERS).
  if (req.method === "POST" && req.url === "/auth/login") {
    if (!AUTH_JWT_SECRET) return sendJson(res, 501, { error: "login not configured" });
    let body = "";
    let tooBig = false;
    req.on("data", (c) => {
      body += c;
      if (body.length > 4096) {
        tooBig = true;
        req.destroy();
      }
    });
    req.on("end", async () => {
      if (tooBig) return;
      let email = "";
      let password = "";
      try {
        const parsed = JSON.parse(body || "{}");
        email = String(parsed.email ?? "").trim().toLowerCase();
        password = String(parsed.password ?? "");
      } catch {
        return sendJson(res, 400, { error: "bad request" });
      }
      if (!email || !password) return sendJson(res, 400, { error: "email and password required" });
      if (loginLocked(email)) return sendJson(res, 429, { error: "too many attempts — try again shortly" });
      const ok = USERS[email] != null && verifyPassword(password, USERS[email]);
      noteLogin(email, ok);
      if (!ok) {
        await new Promise((r) => setTimeout(r, 400)); // blunt brute-force / timing
        return sendJson(res, 401, { error: "invalid email or password" });
      }
      sendJson(res, 200, { token: await issueToken(email), email });
    });
    return;
  }
  res.writeHead(404, CORS);
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
    `[relay] listening on :${PORT} — auth: ${
      AUTH_JWT_SECRET ? `password (${Object.keys(USERS).length} users)` : SUPABASE_SECRET ? "supabase" : DEV_TOKEN ? "dev-token" : "NONE (clients refused)"
    }`
  );
});
