import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { dataPath } from "./config.js";

// Per-ticket git isolation (the worktree-per-ticket plan, desktop-app-plan §4/§6).
// Every delegated ticket in a git project gets its own worktree + branch, so
// parallel tickets never trample each other's working tree. The thread's cwd
// becomes the worktree; the branch survives cleanup (worktree removal never
// deletes the work — only the checkout).
//
// Layout: <worktrees root>/<project name>/ticket-<threadId>
//   - root defaults to <SPAWN_DATA_DIR>/worktrees (so isolated test runs get
//     isolated worktrees for free); override with SPAWN_WORKTREES_DIR.
//   - branch: ticket/<threadId>[-<title slug>] — threadId keeps it unique.
//   - base: the repo's default branch (origin/HEAD) when it has one, else the
//     repo's current HEAD. Tickets branch from the mainline, not from whatever
//     Marc happens to have checked out.
//
// Everything here is best-effort from the daemon's point of view: callers
// treat a throw as "run un-isolated in the project dir" rather than failing
// the delegation.

const execFileP = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;

const git = async (dir, ...args) => {
  const { stdout } = await execFileP("git", ["-C", dir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
};

export const worktreesRoot = () =>
  process.env.SPAWN_WORKTREES_DIR || dataPath("worktrees");

export async function isGitRepo(dir) {
  try {
    return (await git(dir, "rev-parse", "--is-inside-work-tree")) === "true";
  } catch {
    return false;
  }
}

const slugify = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

// The branch new tickets fork from: origin's default branch when the repo has
// a remote, else current HEAD (covers local-only repos and detached HEADs).
async function defaultBase(repoDir) {
  try {
    const ref = await git(repoDir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD");
    return ref.replace("refs/remotes/", ""); // e.g. origin/master
  } catch {
    return "HEAD";
  }
}

export async function createWorktree({ repoDir, projectName, threadId, title }) {
  const slug = slugify(title);
  const branch = `ticket/${threadId}${slug ? `-${slug}` : ""}`;
  const path = join(worktreesRoot(), projectName, `ticket-${threadId}`);
  mkdirSync(join(worktreesRoot(), projectName), { recursive: true });
  const base = await defaultBase(repoDir);
  await git(repoDir, "worktree", "add", "-b", branch, path, base);
  return { path, branch, base };
}

// Remove a ticket's worktree checkout. The branch (and any commits on it) is
// deliberately kept — cleanup reclaims disk, it never deletes work. A dirty
// worktree needs force=true (git refuses otherwise, and so do we by default).
export async function removeWorktree({ repoDir, path, force = false }) {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  await git(repoDir, ...args);
}

// Live git state of a thread's worktree: null when the dir is gone/not git.
export async function worktreeStatus(dir) {
  try {
    const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    const dirty = (await git(dir, "status", "--porcelain"))
      .split("\n")
      .filter(Boolean).length;
    let ahead = 0;
    let behind = 0;
    try {
      const counts = await git(dir, "rev-list", "--left-right", "--count", "@{upstream}...HEAD");
      const [b, a] = counts.split(/\s+/).map(Number);
      behind = b || 0;
      ahead = a || 0;
    } catch {
      /* no upstream yet — a ticket branch that hasn't been pushed */
    }
    let lastCommit = null;
    try {
      lastCommit = await git(dir, "log", "-1", "--format=%h %s");
    } catch {
      /* repo with no commits */
    }
    return { branch, dirty, ahead, behind, lastCommit };
  } catch {
    return null;
  }
}

// Roll a gh statusCheckRollup array into one word for the UI.
const summarizeChecks = (rollup) => {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  const states = rollup.map((c) => c.conclusion || c.state || "");
  if (states.some((s) => /FAILURE|ERROR|CANCELLED|TIMED_OUT/i.test(s))) return "failing";
  if (states.every((s) => /SUCCESS|NEUTRAL|SKIPPED/i.test(s))) return "passing";
  return "pending";
};

// The ticket branch's PR, via gh. Null on any miss (no PR yet, no remote,
// gh not installed) — the panel just shows "no PR".
export async function prStatus(dir, branch) {
  try {
    const { stdout } = await execFileP(
      "gh",
      ["pr", "view", branch, "--json", "number,url,state,statusCheckRollup"],
      { cwd: dir, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }
    );
    const pr = JSON.parse(stdout);
    return {
      number: pr.number,
      url: pr.url,
      state: pr.state, // OPEN | MERGED | CLOSED
      checks: summarizeChecks(pr.statusCheckRollup),
    };
  } catch {
    return null;
  }
}
