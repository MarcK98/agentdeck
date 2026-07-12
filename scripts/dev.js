// Dev launcher: bring up an ngrok tunnel to the Trello webhook port, inject its
// public URL as TRELLO_WEBHOOK_CALLBACK_URL, then start the bridge (node --watch).
// ngrok's free URL is random per run, so we discover it at runtime from ngrok's
// local API (http://127.0.0.1:4040) instead of hard-coding it in .env.
//
// Best-effort: if ngrok isn't authed / can't start, we log a warning and run the
// bridge anyway in poll-only mode (the board still syncs every TRELLO_POLL_SECONDS).
import "dotenv/config";
import { spawn } from "node:child_process";

const PORT = Number(process.env.TRELLO_WEBHOOK_PORT) || 8792;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ngrok = null;
let bridge = null;
let shuttingDown = false;

// Poll ngrok's local API until it reports an https tunnel (or we give up).
async function waitForTunnel(timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(NGROK_API, { signal: AbortSignal.timeout(2000) });
      const { tunnels } = await res.json();
      const https = tunnels?.find((t) => t.public_url?.startsWith("https://"));
      if (https) return https.public_url;
    } catch {
      /* ngrok not up yet */
    }
    await sleep(500);
  }
  return null;
}

async function startNgrok() {
  if (process.env.TRELLO_ENABLED !== "true") {
    console.log("[dev] TRELLO_ENABLED != true — skipping ngrok, bridge only.");
    return "";
  }
  ngrok = spawn("ngrok", ["http", String(PORT), "--log", "stdout"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  ngrok.on("error", (err) => console.warn(`[dev] ngrok spawn failed: ${err.message}`));
  // Surface auth/tunnel errors (e.g. missing authtoken) instead of hiding them.
  const watch = (buf) => {
    const s = buf.toString();
    if (/err|authtoken|ERR_NGROK|failed/i.test(s)) process.stderr.write(`[ngrok] ${s}`);
  };
  ngrok.stdout.on("data", watch);
  ngrok.stderr.on("data", watch);

  const url = await waitForTunnel();
  if (!url) {
    console.warn(
      "[dev] no ngrok tunnel — running poll-only. If this is the first run, set an\n" +
        "      authtoken:  ngrok config add-authtoken <TOKEN>   (from dashboard.ngrok.com)"
    );
    if (ngrok) ngrok.kill();
    ngrok = null;
    return "";
  }
  console.log(`[dev] ngrok tunnel: ${url} -> :${PORT}  (webhook inspector: http://127.0.0.1:4040)`);
  return url;
}

function startBridge(callbackUrl) {
  const env = { ...process.env };
  if (callbackUrl) env.TRELLO_WEBHOOK_CALLBACK_URL = callbackUrl;
  bridge = spawn("node", ["--watch", "src/index.js"], { stdio: "inherit", env });
  bridge.on("exit", (code) => {
    if (!shuttingDown) {
      shutdown(`bridge exited (${code})`);
    }
  });
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[dev] shutting down — ${reason}`);
  if (bridge) bridge.kill("SIGTERM");
  if (ngrok) ngrok.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const callbackUrl = await startNgrok();
startBridge(callbackUrl);
