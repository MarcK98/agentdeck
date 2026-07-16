# Spawn — Phase 4 report (checkpoint for Marc)

Phase 4 (Live map) of `docs/desktop-app-plan.md` §8 is done, on branch
`phase-4-live-map` (built on `phase-3-ticket-isolation`, commit `ac3b85a`).
Same rule: hard stop — no Phase 5 until you say go (and note Phase 5 in the
plan is "pluggable providers", which you already **cancelled** — so the next
real work is Phase 6 mobile, or whatever you point at).

Built and committed with **fable**.

## Delivered (plan §8 Phase 4 exit: "React Flow view over the Phases 2-3 model")

**`getMap` (daemon)**
- One RPC returns the whole picture: the team-lead project, the projects that
  currently have active threads (idle projects stay off the map — 25 dormant
  nodes would be noise), and every active thread carrying its Phase-3 state:
  kind, ticket branch + worktree, dirty count, live process (pid/model),
  cumulative cost + turns, and the branch's PR (state + checks via `gh`).
  Per-thread git/PR lookups fan out in parallel and are best-effort nulls,
  same contract as `getThreadContext`.

**MapView (desktop, `@xyflow/react` v12)**
- Three-column layered graph: 🧭 team lead → projects → threads. No layout
  library — threads stack per project, each project centers on its block.
- Live status on the nodes: running dot + animated edges while a thread's
  process runs, `pid`/model badge, ticket-branch badge, `±N` dirty badge,
  PR badge (open/merged/closed + checks passing/failing/pending, click-through
  to GitHub in your real browser), cost badge.
- **Click a node → jump**: thread node opens that exact thread (cross-project
  jumps land on the thread, not just the project), project node opens the
  project, team-lead node opens the workspace.
- Live-updating the same way the board is: re-pulls on thread lifecycle
  events (created/updated/turn:start/turn:done), plus a 20s background poll —
  PR checks and git state change outside daemon events — plus a manual ↻.
- Rail gets a "🗺 Live Map" entry under Team Lead.

## Verified
- `tsc --noEmit` clean; `vite build` clean (bundle grows ~190 kB gzip → React
  Flow, expected).
- Isolated daemon E2E (`/tmp/spawn-p4-e2e.mjs`, ports **8895/8896**, temp
  `SPAWN_DATA_DIR`, stub `claude`, Homebrew node) — **18/18**:
  - empty map = team-lead node only; `TEAMLEAD_CHANNEL` resolved.
  - two concurrent tickets (git + plain project) → both on the map **running
    with live pids mid-turn**; isolated one carries branch + worktree, plain
    one doesn't; both projects appear, the idle third project doesn't.
  - settled map: process idle, cost-per-thread exact (0.05), dirty=1 from the
    stub's work, pr=null graceful.
  - `cleanupThread` → archived ticket drops off the map; a project with
    nothing active left drops off too; the team-lead project never does.
- Live bridge untouched: alt ports clear of 8790/8791/8792 and of the live
  daemon's 8810/8811; bridge approval server on 8790 confirmed still
  listening afterward.

## Not verified / risks
- **Headed render of the graph is build-verified only** — no click-through of
  the actual React Flow canvas (same as every prior phase's UI). First open of
  the Live Map tab is the real test; the data feeding it is E2E-proven.
- PR badges: same Phase-3 caveat — `gh` path exercised only for the
  graceful-null case (test repos have no remote).
- `getMap` cost: one `git status` (+ one `gh` call when a branch exists) per
  active thread per pull. Fine at hand-driven delegation scale; if you ever
  run dozens of parallel tickets, the 20s poll should get a cache.
- Mermaid export (plan §3 "offer a Mermaid export") not built — say the word
  if you want it, it's a ~50-line serializer over the same `getMap` data.

## Gate (awaiting your direction)
Plan §8 says Phase 5 = pluggable providers (**cancelled by you** — Spawn is
Claude-only by design) and Phase 6 = mobile companion (needs Supabase Auth in
front of the daemon, i.e. the hosted-infra step you said you'd provision).
Nothing left in the plan is purely local. Options: Discord hard-cut prep,
polish pass (headed QA + the flagged small gaps), or straight to mobile once
you set up Supabase. Your call.
