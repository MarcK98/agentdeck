# Spawn — Phase 3 report (checkpoint for Marc)

Phase 3 (Per-ticket isolation surfaced) of `docs/desktop-app-plan.md` §8 is
done, on branch `phase-3-ticket-isolation` (built on `phase-2-teamlead-board`,
commit `d94794c`). Same rule: hard stop — no Phase 4 (the React-Flow live map)
until you say go.

Built and committed with **fable**.

## Delivered (plan §8 Phase 3 exit: "parallel isolated tickets visible and controllable")

**Worktree-per-ticket (`core/worktrees.js` — new)**
- Every `delegateTask` into a **git** project now gets its own worktree +
  branch before the run starts; the run's cwd is the worktree, so parallel
  tickets in one project never trample each other's tree.
- Branch: `ticket/<threadId>-<title-slug>` (threadId keeps it unique), forked
  from the repo's **default branch** (`origin/HEAD`; local `HEAD` for
  remote-less repos) — not from whatever you have checked out.
- Worktree root: `SPAWN_WORKTREES_DIR`, defaulting to
  `<SPAWN_DATA_DIR>/worktrees/<project>/ticket-<id>` (gitignored; isolated
  test runs get isolated worktrees for free). **You flagged this needed a
  decision — this is my default, trivially movable via the env var.**
- Non-git projects and worktree failures fall back to running in the project
  dir, with a system row in the transcript saying so. Delegation never fails
  over isolation.
- The delegate prompt tells the agent it's in a worktree on a ticket branch
  and to push/PR rather than commit to the base branch.

**Per-thread context surfaced (`getThreadContext` + desktop panel)**
- One RPC returns everything the panel shows: branch, worktree path, live git
  state (dirty count / ahead / behind / last commit), the branch's **PR** via
  `gh` (number, url, state, checks rolled up to passing/failing/pending), the
  **live process** (pid, model, started-at) and **cumulative cost** (USD +
  turns from the usage ledger, last-turn context tokens). Every sub-part is a
  best-effort null — no repo, no remote, no gh, no PR never throws.
- Desktop: a right-hand **Context panel** on every project-view thread, and
  beside ticket threads opened in the team-lead workspace. Includes a **Stop**
  button on the live process and self-refreshes on that thread's
  turn:start/turn:done/thread:updated.
- `claude.js` now exposes pid/startedAt/model of in-flight runs
  (`getActiveRun`), and usage-ledger rows carry `threadId` — that's what makes
  cost-per-thread exact rather than inferred.
- `listActiveThreads` rows now carry a live `running` flag (process truth, so
  it survives an app restart, unlike the event-derived busy set) — the
  workspace list shows a running dot + the ticket's branch badge.

**Cleanup policy (`cleanupThread` — my default, flag if you want different)**
- Removes the worktree **checkout only** — the branch and its commits always
  survive; cleanup reclaims disk, never work.
- Refuses while the thread's process is running; refuses a **dirty** worktree
  unless forced (the UI asks "N uncommitted change(s) — discard?" with an
  explicit Force button). Then archives the thread.
- Nothing is auto-deleted, ever — cleanup is a button, not a policy loop.

## Verified
- `tsc --noEmit` clean; `vite build` clean.
- Isolated daemon E2E (`/tmp/spawn-p3-e2e.mjs`, ports **8893/8894**, temp
  `SPAWN_DATA_DIR`, a stub `claude` via `CLAUDE_BIN` that "works" by writing a
  file in its cwd, Homebrew node) — **31/31**:
  - delegate into a git project → branch + worktree created, checked out on
    the ticket branch, `thread:updated` carries it; the stub's file lands **in
    the worktree, not the project dir** (isolation proof).
  - `getThreadContext` shows the **live pid while the turn runs**, then after:
    dirty=1, pr=null (graceful), cost 0.1234 USD / 1 turn / 1.2k ctx tokens,
    and the `usage.jsonl` row carries the threadId.
  - non-git project → no branch/worktree, runs in the project dir, still fine.
  - **two concurrent tickets in ONE project** → distinct branches/worktrees,
    both pids running simultaneously.
  - cleanup: dirty refuses → force removes → thread archived, worktree gone,
    **branch still exists**; a clean worktree cleans up without force.
- The live bridge was never touched: alt ports clear of 8790/8791/8792 (and of
  the live daemon's 8810/8811); the bridge's approval server on 8790 confirmed
  still listening afterward.

## Not verified / risks
- **`gh` PR status is code-reviewed only** — the E2E repos have no remote, so
  `prStatus` was exercised for the graceful-null path, not a live PR. First
  real delegated ticket that opens a PR will light it up; eyeball it.
- UI is build-verified only (no headed click-through), same as Phase 2.
- No concurrency cap on parallel tickets yet (plan §10 mentions a pool) — many
  simultaneous delegations = many claude processes + worktrees. Fine for
  hand-driven delegation; a cap belongs with the heartbeat unification later.
- Old ticket threads created in Phase 2 (pre-isolation) have no worktree; the
  panel just shows "none — runs in the project dir". Nothing migrates.

## Gate: what Phase 4 would be (awaiting your go)
Plan §8 Phase 4 — **live map**: React Flow view over the Phase 2–3 model
(team-lead → projects → threads → processes → worktrees → PRs), live status
badges, click-a-node → jump to thread. All the data it needs now exists
(`listActiveThreads` + `getThreadContext`). Say go (and which model).
