// Provider "Connect" orchestration — the daemon-side of one-click auth.
//
// Only Google Cloud does a true browser-OAuth login the MCP can then ride:
// `gcloud auth login` into a per-connection ISOLATED config dir, so a project
// can wire multiple Google accounts (each its own dir), and the account is
// pinned per server. Everything else authenticates with a token the user
// captures from a provider page (handled client-side), and Apple uses a
// downloaded .p8 key (imported here). All creds live under <dataDir>/creds,
// 0700, and are LOCAL-ONLY (these methods are relay-denied).

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { log } from "../logger.js";

const credRoot = join(dataDir, "creds");
const gcloudDirFor = (projectId, serverName) => join(credRoot, "gcloud", `${projectId}-${serverName}`);
const appleDirFor = (projectId, serverName) => join(credRoot, "apple", `${projectId}-${serverName}`);

export function gcloudAvailable() {
  try {
    return spawnSync("gcloud", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// Run `gcloud auth login` into an isolated config dir. gcloud opens the user's
// browser itself (macOS LaunchServices works from a background process in the
// same session); if we spot the consent URL we surface it via onUrl as a
// fallback. Resolves {account, credDir}; rejects on missing gcloud / non-zero.
export function gcloudLogin(projectId, serverName, { onUrl } = {}) {
  return new Promise((resolve, reject) => {
    if (!gcloudAvailable()) {
      return reject(
        new Error(
          "gcloud CLI not found on the daemon host. Install the Google Cloud SDK, or connect with a token/key instead."
        )
      );
    }
    const credDir = gcloudDirFor(projectId, serverName);
    mkdirSync(credDir, { recursive: true, mode: 0o700 });
    const env = { ...process.env, CLOUDSDK_CONFIG: credDir };
    const child = spawn("gcloud", ["auth", "login", "--brief"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const scan = (buf) => {
      const s = buf.toString();
      out += s;
      const m = s.match(/https:\/\/accounts\.google\.com\/[^\s"']+/);
      if (m && onUrl) onUrl(m[0]);
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const last = out.trim().split("\n").filter(Boolean).slice(-1)[0];
        return reject(new Error(last || `gcloud auth login exited ${code}`));
      }
      const acct = spawnSync(
        "gcloud",
        ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
        { env, encoding: "utf8" }
      );
      const account = (acct.stdout || "").trim().split("\n").filter(Boolean)[0] || null;
      log.info(`[connect] gcloud login ok (${serverName}) account=${account}`);
      resolve({ account, credDir });
    });
  });
}

export function gcloudDisconnect(projectId, serverName) {
  try {
    rmSync(gcloudDirFor(projectId, serverName), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return true;
}

// Copy a downloaded App Store Connect .p8 into an isolated dir; return the
// stored path (the value we inject as APP_STORE_CONNECT_P8_PATH at run time).
export function importAppleKeyFile(projectId, serverName, sourcePath) {
  if (!sourcePath || !existsSync(sourcePath)) throw new Error(`No such file: ${sourcePath}`);
  const dir = appleDirFor(projectId, serverName);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, "AuthKey.p8");
  copyFileSync(sourcePath, dest);
  return dest;
}

export function appleDisconnect(projectId, serverName) {
  try {
    rmSync(appleDirFor(projectId, serverName), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return true;
}
