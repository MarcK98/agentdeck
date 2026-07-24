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
//     the owner happens to have checked out.
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

// Like `git`, but keeps stdout when git exits non-zero. `git diff --no-index`
// (used for untracked files) exits 1 whenever a difference exists — that's not
// an error, the diff we want is on stdout. Bigger buffer: a single file's diff
// can be large. Re-throws only when there's genuinely no output.
const gitRaw = async (dir, ...args) => {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    if (e && typeof e.stdout === "string" && e.stdout) return e.stdout;
    throw e;
  }
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

// The fork point this branch diverged from its base — everything after it is
// "this thread's work". merge-base against origin's default branch (or repo
// HEAD for local-only repos) so the base advancing doesn't pollute the diff.
// Null when there's no sensible base (empty repo, detached with no history).
async function diffBase(dir) {
  const base = await defaultBase(dir); // origin/master, or "HEAD" locally
  try {
    return (await git(dir, "merge-base", base, "HEAD")) || null;
  } catch {
    return null;
  }
}

const parseNumstat = (out) => {
  const map = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [add, del, ...rest] = line.split("\t");
    const path = rest.join("\t");
    if (!path) continue;
    const binary = add === "-" || del === "-";
    map.set(path, {
      additions: binary ? null : Number(add) || 0,
      deletions: binary ? null : Number(del) || 0,
      binary,
    });
  }
  return map;
};

// The "files changed" list for a thread's worktree — every path this branch
// touched vs its base (committed + staged + unstaged), plus untracked files as
// additions. Shaped for a GitHub-style review panel. Never throws: a bad dir
// or non-repo yields null and the caller shows an empty state.
export async function worktreeDiff(dir) {
  try {
    const base = await defaultBase(dir);
    const mergeBase = await diffBase(dir);

    // Tracked changes: numstat gives +/- counts, name-status the A/M/D verb.
    // --no-renames keeps paths stable (a rename shows as delete + add), which
    // is simpler to render and to diff per-file than R-status pairs.
    const files = new Map(); // path -> { path, status, additions, deletions, binary }
    if (mergeBase) {
      const nums = parseNumstat(await gitRaw(dir, "diff", "--numstat", "--no-renames", mergeBase));
      const names = await gitRaw(dir, "diff", "--name-status", "--no-renames", mergeBase);
      for (const line of names.split("\n")) {
        if (!line) continue;
        const [code, ...rest] = line.split("\t");
        const path = rest.join("\t");
        if (!path) continue;
        const status = code[0] === "A" ? "A" : code[0] === "D" ? "D" : "M";
        const n = nums.get(path) || { additions: 0, deletions: 0, binary: false };
        files.set(path, { path, status, ...n });
      }
    }

    // Untracked files (git diff ignores them) — surface as new/added.
    const others = (await git(dir, "ls-files", "--others", "--exclude-standard"))
      .split("\n")
      .filter(Boolean);
    for (const path of others.slice(0, 200)) {
      if (files.has(path)) continue;
      let additions = 0;
      let binary = false;
      try {
        const one = parseNumstat(
          await gitRaw(dir, "diff", "--numstat", "--no-index", "--", "/dev/null", path)
        );
        const stat = one.get(path);
        if (stat) {
          additions = stat.additions ?? 0;
          binary = stat.binary;
        }
      } catch {
        /* best-effort counts — the file still lists, just without +N */
      }
      files.set(path, { path, status: "A", additions, deletions: 0, binary });
    }

    const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
    const additions = list.reduce((s, f) => s + (f.additions || 0), 0);
    const deletions = list.reduce((s, f) => s + (f.deletions || 0), 0);
    return { base, files: list, additions, deletions };
  } catch {
    return null;
  }
}

// The unified diff for one file in a thread's worktree (the per-file body the
// review panel lazy-loads on click). Untracked files diff against /dev/null so
// a brand-new file renders as all-additions. Returns "" on any miss.
export async function worktreeFileDiff(dir, path) {
  try {
    const untracked = (await git(dir, "status", "--porcelain", "--", path)).startsWith("??");
    if (untracked) {
      return await gitRaw(dir, "diff", "--no-index", "--no-renames", "--", "/dev/null", path);
    }
    const mergeBase = await diffBase(dir);
    if (!mergeBase) return "";
    return await gitRaw(dir, "diff", "--no-renames", mergeBase, "--", path);
  } catch {
    return "";
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
