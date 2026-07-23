# AgentDeck — Phase 1 report (checkpoint for Marc)

Phase 1 (MVP chat hardening) of `docs/desktop-app-plan.md` §8 is done, on branch
`phase-1-mvp-chat` (built on `phase-0-scaffold`, commit `9384196`). Same rule as
Phase 0: this is a hard stop — no Phase 2 starts until you say go.

Built with **fable** (your call — "continue with fable"); reviewed, verified,
and committed on Opus.

## Delivered (plan §8 Phase 1 exit: "real work in one project without Discord")

**Incremental streaming**
- The daemon's `turn:text` / `turn:tool` events now carry the persisted message
  row; the desktop appends it (deduped by id) instead of re-pulling the whole
  history on every event (Phase 0 re-pulled — fine for a demo, wrong for a live
  stream). `db.addMessage` returns the full row; `getMessage(id)` added.

**Approval modals (prompt mode)** — the load-bearing piece
- New `packages/core/src/daemon/approvals.js`: a localhost **approval hub**. A
  run in prompt mode spawns the same approver MCP as the bridge, but the daemon
  points it at this hub instead of Discord. The hub parks the request, emits
  `approval:request`, and answers when the desktop calls `resolveApproval`
  (Allow/Deny) — or auto-denies on timeout. It pauses the run's inactivity clock
  while a human decides (reusing `pauseInactivity/resumeInactivity`), and emits
  `approval:resolved` on settle.
- `claude.js` gained three backward-compatible per-run opts (`approvals`,
  `permissionMode`, `approvalPort`). **The bridge passes none of them, so the
  live Discord bridge behaves exactly as before.**
- Per-project `approvalMode` routes it: `prompt` → hub; `auto` →
  `bypassPermissions`, no approver.
- Desktop shows a global Allow/Deny modal (tool name + pretty-printed input).

**Thread titles / rename**
- `renameThread` RPC + `thread:updated` event; the first message auto-titles a
  placeholder thread (first line, clipped); double-click a thread to rename it.

**Project settings (persisted)**
- SQLite migration **v2** (`project_settings`, a JSON blob per project);
  `project-settings.js` is now SQLite-backed instead of the Phase 0 in-memory
  Map. **Secrets stay in the daemon's in-memory map — never in the table**, by
  construction (unchanged).
- `updateProjectSettings` exposed to the client; a ⚙ panel edits `approvalMode`,
  `defaultModel`, and `allowedModels` (fable stays opt-in).

**Daemon lifecycle**
- Single-instance via the port bind: a losing start logs and exits 0 and never
  clobbers the winner's token/pid (two real pre-existing bugs fixed on the way —
  the token was written *before* the bind, and the EADDRINUSE handler had to be
  registered before `ws` attaches or it throws first).
- pid file written on listen, removed on shutdown (only if still ours).
- The detached daemon's stdout/stderr now append to `agentdeck-daemon.log` (it had
  none before — crashes were invisible).
- launchd `com.agentdeck.daemon.plist` template + `packages/core/daemon/README.md`
  (manual install; **not** auto-installed).

## Verified
- `tsc --noEmit` clean; `vite build` clean.
- Isolated daemon E2E (alt ports 8891/8892, temp `SPAWN_DATA_DIR`, Homebrew
  node) — **21/21 assertions**: health + token(0600) + pid(0644) files; full
  approval round-trip (deny → `Denied in AgentDeck.`; allow → `updatedInput`) driven
  the real way (MCP-style `/permission` POST → `approval:request` WS event →
  `resolveApproval` via `/rpc` → answer); `approval:resolved` fires;
  single-instance loser exits 0 with the live token untouched; SIGTERM removes
  pid+token; settings persist; auto-title; **v1→v2 migration on a seeded db**.
- `SPAWN_SMOKE` spawns the daemon and lists your 25 projects.
- The live Discord bridge was never touched — every daemon test ran on alt ports
  in `/tmp`.

## Decisions I made (flag if you disagree)
1. **Prompt mode pins `--permission-mode` to empty.** Your `.env` sets
   `CLAUDE_PERMISSION_MODE=bypassPermissions` (the bridge's), which the daemon
   inherits — without the pin, "prompt" projects would silently never prompt.
   The pin makes prompt actually prompt; auto still uses `bypassPermissions`.
2. **Busy state is now per-thread** (small add on top of fable's work): streaming
   in one thread no longer shows a phantom "working…" or locks the composer in
   another — that multi-thread story is the point of AgentDeck.

## Follow-ups / risks for Phase 2
- **Port collisions on defaults (worth fixing early):** `SPAWN_DAEMON_PORT`
  default `8791` == `DASHBOARD_PORT` default; `SPAWN_DAEMON_APPROVAL_PORT`
  default `8792` == `TRELLO_WEBHOOK_PORT` default. On your machine the dashboard
  already holds 8791, so `ensureDaemon` against it would fail. Pick clear daemon
  ports (e.g. 8810/8811) in Phase 2.
- Not verified: a prompt-mode run against the **real** `claude` CLI (the E2E used
  a faithful stub of the approver's POST contract for determinism), and the
  desktop UI driven interactively (build + smoke only, no headed click-through).
- The approval modal is minimal (no "always allow for this tool", no per-thread
  routing when several prompts stack). Fine for MVP; revisit with the board.

## Gate: what Phase 2 would be (awaiting your go)
Plan §8 Phase 2 — team-lead workspace + board: the team-lead screen, a board
mirroring TASKS.md/Trello, delegate-from-UI, one-thread-per-ticket, multiple
concurrent threads. Say go (and whether fable keeps building or we drop to
sonnet for the routine parts).
