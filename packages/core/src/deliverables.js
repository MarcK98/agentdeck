import { execFile } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { dataPath } from "./config.js";
import { log } from "./logger.js";

// Deliverables — agent-produced OUTPUT files (PDFs, spreadsheets, decks,
// reports, exports; not code). One managed root, its own git repo, committed
// automatically after every daemon run that changed something:
//
//   <root>/<project>/SPWN-<ticketId>/...   (ticket runs)
//   <root>/<project>/misc/...              (chat / console runs)
//
// Root: SPAWN_DELIVERABLES_DIR, default <data dir>/deliverables. Everything
// here is best-effort — deliverables must never fail or slow a run.

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;

export const deliverablesRoot = () =>
  process.env.SPAWN_DELIVERABLES_DIR || dataPath("deliverables");

const git = async (...args) => {
  const { stdout } = await execFileP("git", ["-C", deliverablesRoot(), ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
};

// Create the root + its repo on first use. Repo-local identity so commits
// work regardless of the machine's git config.
export async function ensureRepo() {
  const root = deliverablesRoot();
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(root, ".git"))) {
    await git("init", "-q", "-b", "master");
    await git("config", "user.name", "Spawn");
    await git("config", "user.email", "spawn@local");
  }
  return root;
}

// The output dir for one run. Created eagerly so the agent can write into it
// without mkdir ceremony.
export function dirFor({ projectName, ticketId = null }) {
  const dir = join(
    deliverablesRoot(),
    projectName,
    ticketId != null ? `SPWN-${ticketId}` : "misc"
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Snapshot-commit everything pending in the deliverables repo. Returns the
// changed paths (empty = nothing to commit). Never throws.
export async function commitAll(message) {
  try {
    await ensureRepo();
    const status = await git("status", "--porcelain");
    if (!status) return [];
    const files = status
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    await git("add", "-A");
    await git("commit", "-q", "-m", message);
    return files;
  } catch (err) {
    log.warn(`[deliverables] commit failed: ${err.message}`);
    return [];
  }
}

// Files under one run's deliverables dir, recursive, newest first.
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git" || entry.startsWith(".")) continue;
      const p = join(d, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else out.push({ path: p, name: relative(dir, p), size: st.size, mtime: st.mtimeMs });
    }
  };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}
