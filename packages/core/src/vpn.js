import { execFile } from "node:child_process";
import { config } from "./config.js";
import { log } from "./logger.js";

// Control the Tunnelblick VPN on the host via AppleScript. Used by the `vpn` MCP
// tool so an agent (mainly the team lead) can bring the VPN up when a channel's
// work needs it — e.g. connect "CorpVPN" so it can reach its backend/database/
// services, do the work, then disconnect if desired.
//
// Tunnelblick config state strings: "CONNECTED" (up), "EXITING" (down/idle),
// plus transitional ones (CONNECTING, AUTH, RECONNECTING, …).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Escape a value for embedding inside an AppleScript double-quoted string.
const q = (s) => String(s).replace(/["\\]/g, "\\$&");

// Run one AppleScript snippet. Never rejects — resolves { ok, out } | { ok:false, error }.
const osa = (script) =>
  new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: (stderr || err.message || "").trim() });
      else resolve({ ok: true, out: (stdout || "").trim() });
    });
  });

// Turn Tunnelblick/osascript errors into something the agent can act on.
const mapErr = (r) => {
  const e = r.error || "unknown error";
  if (/-1743|not authorized to send Apple events|not allowed/i.test(e)) {
    return {
      ok: false,
      error:
        "macOS blocked the automation. Grant the bridge (its terminal/node binary) permission to control Tunnelblick under System Settings > Privacy & Security > Automation, then retry.",
    };
  }
  if (/-600|-609|isn.?t running|application is not running/i.test(e)) {
    return { ok: false, error: "Tunnelblick isn't running — launch it (`open -a Tunnelblick`) and retry." };
  }
  return { ok: false, error: e };
};

const stateOf = (name) =>
  osa(`tell application "Tunnelblick" to get state of (first configuration whose name is "${q(name)}")`);

// Poll until the config reaches `target` or attempts run out (~1s each).
const pollState = async (name, target, attempts) => {
  let state = "";
  for (let i = 0; i < attempts; i++) {
    const r = await stateOf(name);
    if (r.ok) state = r.out;
    if (state === target) break;
    await sleep(1000);
  }
  return state;
};

// action: "status" (default) | "connect" | "disconnect" | "list"
export async function controlVpn({ action, config: cfgName } = {}) {
  if (!config.vpn.enabled) {
    return { ok: false, error: "VPN control is off — set VPN_CONTROL_ENABLED=true to allow it." };
  }
  const act = String(action || "status").toLowerCase();

  if (act === "list") {
    const r = await osa('tell application "Tunnelblick" to get name of configurations');
    return r.ok ? { ok: true, action: "list", configs: r.out } : mapErr(r);
  }

  const name = cfgName || config.vpn.defaultConfig;
  if (!name) {
    return { ok: false, error: "No Tunnelblick config given — pass `config` or set TUNNELBLICK_CONFIG." };
  }
  if (config.vpn.allowed.length && !config.vpn.allowed.includes(name)) {
    return {
      ok: false,
      error: `Config "${name}" isn't allowed (VPN_ALLOWED_CONFIGS: ${config.vpn.allowed.join(", ") || "none"}).`,
    };
  }

  if (act === "status") {
    const r = await stateOf(name);
    return r.ok ? { ok: true, action: "status", config: name, state: r.out } : mapErr(r);
  }
  if (act === "connect") {
    const r = await osa(`tell application "Tunnelblick" to connect "${q(name)}"`);
    if (!r.ok) return mapErr(r);
    const state = await pollState(name, "CONNECTED", 20);
    log.info(`[vpn] connect ${name} -> ${state}`);
    return { ok: true, action: "connect", config: name, state };
  }
  if (act === "disconnect") {
    const r = await osa(`tell application "Tunnelblick" to disconnect "${q(name)}"`);
    if (!r.ok) return mapErr(r);
    const state = await pollState(name, "EXITING", 15);
    log.info(`[vpn] disconnect ${name} -> ${state}`);
    return { ok: true, action: "disconnect", config: name, state };
  }
  return { ok: false, error: `Unknown action "${act}" — use status | connect | disconnect | list.` };
}
