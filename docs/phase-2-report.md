# AgentDeck — Phase 2 report (checkpoint for Marc)

Phase 2 (Team-lead workspace + board) of `docs/desktop-app-plan.md` §8 is done,
on branch `phase-2-teamlead-board` (built on `phase-1-mvp-chat`, commit
`2a0de00`). Same rule: hard stop — no Phase 3 until you say go.

Built with **fable**, reviewed + verified + committed on Opus.

## Delivered (plan §8 Phase 2 exit: "team-lead fully drivable from the app")

**Read-only board**
- Daemon `getBoard()` reuses `trello.readBoard()` and buckets cards into the five
  configured columns (todo → done, `config.trello.lists` order); non-standard/null
  statuses stay visible under `todo`. Falls back to the team-lead project's
  `TASKS.md` verbatim, else `source:"none"`. Never throws.
- Desktop `BoardView`: columns of cards (title links to the Trello card, opened
  in your real browser, not a child window), TASKS.md shown as text, a Refresh
  button. Read-only — no drag, no edit.

**Team-lead workspace**
- `getTeamLeadProject()` resolves `TEAMLEAD_CHANNEL` like any bridge channel.
- A "🧭 Team Lead" entry at the top of the rail opens a workspace: the board, a
  **team-lead console** (a normal `teamlead`-kind chat thread), and the delegate
  / active-threads panel. The chat (message list + composer + live streaming) was
  factored into one `<ChatThread>` shared by the project chat and the console.

**Delegate-from-UI + one-thread-per-ticket**
- `launchTurn()` was factored out of `sendMessage` (byte-for-byte same behavior);
  `delegateTask({projectId, task, model, effort})` spins up an ephemeral
  `ticket` thread, persists the task as its opening message, and runs the exact
  prompt the bridge's delegate tool uses. **Concurrent delegations run in
  parallel** — each ticket thread has its own session key.
- `listActiveThreads()` powers a cross-project "what's running" list; the delegate
  form picks project + model + effort and opens the new ticket thread inline.

**Ports (the Phase-1 flag, fixed)**
- Daemon defaults moved off the collisions: `SPAWN_DAEMON_PORT` 8791 → **8810**
  (was == your dashboard), `SPAWN_DAEMON_APPROVAL_PORT` 8792 → **8811** (was ==
  Trello webhook). Env overrides unchanged; the bridge's own ports untouched.

## How the running bridge stayed untouched
- The daemon **never** calls `startTrello()`, runs **no** heartbeat, and makes
  **zero** Trello writes — only `readBoard()` GETs. The bridge keeps owning board
  sync during migration.
- The app's team-lead is a **separate conversation** from the Discord team-lead
  (different process, different session-key namespace) — both read the same board
  and the same `TASKS.md`. That's the only clean option while both run in
  parallel (decision #2); unifying them waits until the Discord hard-cut.
- Every test ran on a temp data dir + ports clear of 8790/8791/8792; the bridge's
  approval server on 8790 was confirmed still listening afterward.

## Verified
- `tsc --noEmit` clean; `vite build` clean.
- Isolated daemon E2E (new **default** port 8810, temp `SPAWN_DATA_DIR`, a stub
  `claude` via `CLAUDE_BIN`, Homebrew node) — **16/16**: boots on 8810 + hub on
  8811 with no port override; board TASKS.md fallback returns the file verbatim;
  `getTeamLeadProject` resolves the team-lead project; `delegateTask` creates a
  `ticket` thread, emits `thread:created`, persists the task as the opening row,
  and streams `turn:text` → `turn:done`; **two concurrent delegations overlap**
  (both turns start before the first finishes); `listActiveThreads` carries the
  project name; graceful shutdown cleans pid+token.
- `SPAWN_SMOKE` lists your 25 projects on 8810.

## Not verified / risks
- **Live Trello board render** — the test env has no Trello creds (and I won't
  point a test at your real board while the bridge syncs it). The column
  bucketing is code-reviewed only; eyeball the first real render.
- **`readBoard` isn't 100% read-only on a *fresh* board:** it calls
  `ensureReady()`, which **creates** a configured list if one is missing. Your
  board already has all five (the bridge made them long ago), so on your machine
  `getBoard()` is pure GETs. On a brand-new board the app's first read could
  create the lists. I did not touch `trello.js` (bridge-shared). Flag if you want
  a strictly-read guard in Phase 3.
- UI is build-verified only (no headed click-through). Leaving the workspace
  resets which ticket is open in the console area — acceptable, noted.

## Gate: what Phase 3 would be (awaiting your go)
Plan §8 Phase 3 — **per-ticket isolation surfaced**: wire the worktree-per-ticket
plan so each ticket thread shows its branch / worktree / PR, with process + cost
per thread. That's the first phase that creates git worktrees, so it needs a
decision on the worktree root + cleanup policy. Say go (and fable or sonnet).
