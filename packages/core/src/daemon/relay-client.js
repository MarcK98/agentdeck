import WebSocket from "ws";
import { log } from "../logger.js";

// Outbound connection from the daemon to a Spawn relay (see
// packages/relay). The daemon's local port stays 127.0.0.1-only; remote
// clients reach it exclusively through this pipe. Off unless
// SPAWN_RELAY_URL + SPAWN_RELAY_DAEMON_KEY are set.
//
// Wire protocol (relay → here): { id, method, args } — answered with
// { id, ok, result|error }. Events flow the other way as { event }.

export function startRelayClient(daemon) {
  const url = process.env.SPAWN_RELAY_URL;
  const key = process.env.SPAWN_RELAY_DAEMON_KEY;
  if (!url || !key) return null;

  // Secret-write paths are local-only: a pasted MCP token must never be
  // settable (or reachable) through the relay from a remote/mobile client.
  const REMOTE_DENY = new Set([
    "setProjectMcpSecret",
    "clearProjectMcpSecret",
    "connectGcloud",
    "importAppleKey",
    "disconnectProvider",
    // Reads a file path on the daemon host — meaningless / unsafe from a
    // remote client. Commenting from mobile stays allowed.
    "addTicketAttachment",
  ]);
  const METHODS = new Set(
    Object.entries(daemon)
      .filter(([k, v]) => typeof v === "function" && k !== "events" && !k.startsWith("_"))
      .filter(([k]) => !REMOTE_DENY.has(k))
      .map(([k]) => k)
  );

  let ws = null;
  let closed = false;
  let backoff = 1000;

  const connect = () => {
    if (closed) return;
    ws = new WebSocket(`${url.replace(/\/$/, "")}/daemon?key=${encodeURIComponent(key)}`);

    ws.on("open", () => {
      backoff = 1000;
      log.info(`[relay-client] connected to ${url}`);
    });

    ws.on("message", async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof msg.method !== "string" || msg.id == null) return;
      let reply;
      if (!METHODS.has(msg.method)) {
        reply = { id: msg.id, ok: false, error: `unknown method: ${msg.method}` };
      } else {
        try {
          const result = await daemon[msg.method](...(msg.args ?? []));
          reply = { id: msg.id, ok: true, result };
        } catch (err) {
          reply = { id: msg.id, ok: false, error: err.message };
        }
      }
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
    });

    ws.on("close", () => {
      if (closed) return;
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    ws.on("error", (err) => {
      log.warn(`[relay-client] ${err.message}`);
      ws?.close();
    });
  };

  const onEvent = (ev) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: ev }));
  };
  daemon.events.on("event", onEvent);

  connect();
  return {
    close() {
      closed = true;
      daemon.events.off("event", onEvent);
      ws?.close();
    },
  };
}
