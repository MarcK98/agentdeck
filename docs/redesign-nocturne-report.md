# AgentDeck — Nocturne redesign report (checkpoint for Marc)

Your proposed UI (the Nocturne design pack) is implemented on branch
`redesign-nocturne` (built on `phase-4-live-map`, commit `dfe955e`). I read the
pack as choosing direction **1a "Mission Control"** — turns 2 and 3 of the doc
build the settings screen and all flows on 1a's shell — and implemented that
shell plus every flow the daemon can back today.

## What you get

**Shell (design 1a)** — top bar with the ⌘K command palette (threads, projects,
views, delegate), live tokens-today counter, approvals bell with count; left
nav Orchestrate / Threads / Live map / Approvals / Usage / Settings plus the
projects list with live running dots. Nocturne throughout: vendored tokens
(`src/nocturne.css`), bundled Inter + Phosphor icons (no network fetches),
fading rules, outlined buttons, the blurple accent.

**Orchestrate** — the board cockpit. Trello columns (read-only while the bridge
owns sync) or TASKS.md; AgentDeck's own live ticket threads render as live cards
pinned at the top of "in progress" with pulse dots; "New ticket" ghost card and
⌘N open the delegate sheet (design 3a: task, project, model/effort tag pickers,
isolation preview with the branch slug). Right dock: quick delegate box,
active-runs list, today sparkline.

**Threads (design 3b)** — thread list per project (team-lead console pinned on
its home project), transcript as an activity trail (time · tool · input hint),
steering composer, and the context rail: Run (pid/model, last-turn ctx, cost,
Stop, Reset session), Isolation (branch, worktree, dirty/ahead, last commit,
cleanup with dirty-force confirm), Pull request (state + checks).

**Approvals (design 3c)** — a real inbox view: pending queue with the full
command JSON, Allow once / Deny / Open thread, and a decided-recently trail.
The old blocking modal is gone — a non-blocking corner toast surfaces new
prompts anywhere in the app.

**Usage (design 3d)** — Today / 7 days / 30 days: headline totals (tokens,
turns, threads, USD), hourly/daily bar chart, by-model split, by-project table,
and live sessions with context bars + per-thread session reset. All from the
usage ledger — exact attribution, and it includes the Discord bridge's runs
(shared ledger), so it's your real global picture.

**Settings (design 2a)** — full screen, per-project: allowed models (fable
opt-in), default model + **default effort** (new, flows into the CLI),
approvals Prompt/Auto, **isolation toggle** (worktree-per-ticket opt-out, new).
MCP servers / commands & skills panels state honestly what's wired today
instead of faking controls.

**Live map** — restyled to Nocturne (indigo team-lead node, badge rows, radial
ground); same data and click-to-jump behavior as Phase 4.

## Daemon additions
- `listApprovals` / `listDecisions` — pending queue + bounded in-memory
  decision trail.
- `getUsage(days)` — ledger rollup: totals, by-model, by-project (thread →
  project join), time buckets, live sessions.
- Project settings: `defaultEffort`, `isolation`; `resetThreadSession` exposed
  to the app.
- **Your running daemon was restarted onto this code** (new pid in
  `agentdeck-daemon.pid`) so the app works immediately.

## Verified
- `tsc --noEmit` clean; `vite build` clean.
- **Headed UI QA** (new this phase): every view rendered in a real Chrome
  against a fixture mock and eyeballed — 8 screenshots shared to the channel
  (orchestrate, threads, approvals, usage, settings, map, palette, sheet). One
  layout bug (board column overflow) and one React key warning found and fixed
  this way.
- Isolated daemon E2E (`/tmp/spawn-p5-e2e.mjs`, ports 8897/8898, temp data
  dir, stub `claude`) — **17/17**: approvals queue → deny → decision trail →
  queue drains; project `defaultEffort` reaches the CLI (`--effort high`
  asserted in the spawned argv); `getUsage` totals/cost/by-project/sessions
  exact; `isolation: false` skips the worktree, `true` creates it.
- Prior E2Es still meaningful: no behavior of Phases 1–4 was changed daemon-side
  beyond the additions above.
- Live bridge untouched (alt ports; 8790 confirmed listening after).

## Known deferrals (design bits with no backend yet)
- **"Allow + rule" standing allowlists** — inbox explains; per-prompt answers
  only today. Needs a rules engine in the approval hub; natural next step.
- **Ticket detail as a board-card overlay (3b's full-screen ticket)** — the
  Threads view carries all of 3b's content; a dedicated overlay route can come
  later.
- **First-run / auth screen (3e)** — skipped: your CLI is already signed in and
  the app auto-starts/pairs with the daemon.
- **Board title-match** — Trello cards and AgentDeck ticket threads are separate
  sources (no shared key while the bridge owns Trello writes), so a live ticket
  and its Trello card can both appear in "in progress". Unifies at the
  Discord hard-cut.
- Board column picker in the new-ticket sheet (needs Trello writes — bridge
  owns those).

## Run it
`npm run desktop` — the app restarts against the already-running daemon. If
anything renders off, screenshot it and I'll tighten.
