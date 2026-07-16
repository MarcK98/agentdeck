# Ventriloquist Desktop — Design Doc / Phased Plan

Status: **DRAFT for Marc's review.** This is a plan, not an implementation. It proposes a
native desktop app to replace Discord as the local interface to the Claude Code team-lead and
project agents. Open decisions that need Marc are collected in **§9** — those are not guessed.

---

## 1. Context & why

Today the interface is **Discord** driven by this repo (`claude-channel-bridge`, a Node/ESM
server). Channels map to project dirs (`src/projects.js`), each channel runs one persisted
`claude -p --output-format stream-json` session (`src/claude.js`), a heartbeat team-lead
orchestrates and delegates (`src/teamlead.js`), approvals surface as Discord buttons
(`src/mcp/approval-server.js`), and a Trello board mirrors `TASKS.md`.

Discord is a workaround, not a fit: no first-class board, no per-ticket isolation, output
interleaves in one channel, no live view of processes/worktrees/PRs, and it depends on a
third-party client. The goal is a **purpose-built local desktop app** that keeps the good
parts (chat-per-project, delegation, approvals) and adds what Discord can't: a team-lead
workspace, one-thread-per-ticket, and a live system map.

Crucially, **the backend already exists** in this repo. The app should **reuse the core**
(session spawning, streaming, sessions store, projects mapping, team-lead loop, MCP approval
server, the planned per-ticket git worktrees) rather than rewrite it. The work is mostly a new
**front-end + team-lead workspace + orchestration surface**, plus refactoring the existing
`src/` into a reusable core package.

## 2. Goals / non-goals

**Goals (this effort)**
- Discord-like chat UX, tuned for this workflow, Mac first.
- Team-lead gets a dedicated screen: board/tasks/projects + managing live conversations.
- "Channels" = projects = local directories (reuse `resolveProject`).
- One thread per ticket; team-lead can spawn multiple threads; replying continues that thread.
- A live visual map: team-lead → projects → threads → running processes → worktrees → PRs.
- Deliver **phased**: MVP chat+board first; chart view later.

**Non-goals (explicitly deferred)**
- Pluggable AI subscriptions (Anthropic/OpenAI/Gemini/…) — **future phase**, architecture
  leaves seams but no implementation now.
- Companion mobile app — **later phase**; informs the client/server split but not built now.
- Replacing the Trello sync or the Discord bridge on day one (run in parallel during migration).

## 3. Tech stack recommendation

**Recommended: Electron + React + TypeScript + Vite, with the existing Node core as the
main-process backend.**

Rationale — the deciding factor is **backend reuse**. The whole backend is Node/JS and leans on
Node-only pieces: `child_process.spawn` of the Claude CLI (`claude.js:168`), `node-pty` interactive
terminals (`terminal.js`), the MCP SDK approval server, git orchestration, and `discord.js`.
Electron's **main process is Node**, so that code runs as-is — the renderer is a normal web app
for the Discord-like UI and the graph view. Minimal rewrite; fastest path to MVP.

| Option | Verdict | Why |
|---|---|---|
| **Electron** | ✅ recommend | Main process = Node → reuse `src/` core directly. Mature, React renderer, easy `node-pty`/`spawn`, Mermaid/React-Flow in renderer. Cost: larger binary (~120MB), more RAM. |
| **Tauri** (Rust core + web UI) | ⚠️ strong alt if binary size/security matters | Tiny binary, good security model. BUT the Node backend must run as a **sidecar** with IPC glue, and orchestration written in Rust — real friction against the existing code. Reconsider once the core is a standalone daemon (§4). |
| **Native SwiftUI** | ❌ | Beautiful, but would **rewrite the entire Node backend** in Swift. Rejects reuse; slowest. Only worth it if we abandon the Node core. |

**Renderer specifics**
- **React + TypeScript + Vite**, component lib for speed (shadcn/ui or Radix) — Discord-like
  three-pane shell.
- **Live graph: React Flow** (interactive/animated node graph with live status badges), not raw
  Mermaid. Mermaid renders static diagrams; the requested view is live (processes/PRs updating).
  Offer a **Mermaid export** for a shareable snapshot. (Open Q 9.6 if Marc specifically wants
  Mermaid syntax.)
- **State:** Zustand (light) in renderer; source of truth lives in main process, pushed via IPC.
- **Persistence:** move from flat JSON (`sessions.json`, `usage.jsonl`) to **SQLite**
  (`better-sqlite3`) in the main process for threads/messages/history; keep JSON for small config.

## 4. Architecture — the central fork

Two shapes. This is the biggest decision (Open Q **9.1**):

- **A. App-as-host** — Electron main process *is* the backend: it owns sessions, the team-lead
  heartbeat, worktrees, MCP approval server. Simplest; everything in one process tree. Downside:
  agents only run while the app is open, and mobile/remote (later) needs the app running.
- **B. App-as-client** — the backend runs as a **headless daemon** (today's `npm start`, minus
  Discord), exposing a local API (HTTP + WebSocket/IPC). The desktop app — and later mobile,
  and even the Discord bridge — are all **clients**. Agents keep running headless when the app
  is closed; clean path to mobile/remote.

**Recommendation: build toward B, start pragmatically.** Refactor `src/` into a
**`core` package** (transport-agnostic: sessions, projects, teamlead, worktrees, approvals,
usage) with an **event bus** and a thin **local server** (WS for streaming + REST for
commands). MVP can run that server *inside* Electron main (feels like A) but through the same
API the app would use remotely — so splitting it into a standalone daemon later is a config
change, not a rewrite. This also lets the existing Discord bridge and the new app coexist during
migration (both clients of the same core).

**Reuse map (existing → core):**
- `src/claude.js` → `core/session` (spawn, stream-json parse, session store, timeouts, cancel).
- `src/projects.js` → `core/projects` (channel/project→dir; becomes project registry).
- `src/teamlead.js` → `core/teamlead` (heartbeat, delegate, Trello sync hooks).
- `src/mcp/approval-server.js` → `core/approvals` (permission prompts → UI modals instead of
  Discord buttons).
- planned `src/worktrees.js` (see `docs`/the isolation plan) → `core/worktrees` (per-ticket
  worktree + branch + concurrency pool). **The desktop thread model maps 1:1 onto per-ticket
  worktrees** — this app is the natural UI for that isolation work.
- `src/usage-log.js`, `src/pricing.js`, `src/dashboard.js` → `core/usage` (feeds a real UI).
- `src/terminal.js` (`node-pty`) → `core/terminal` (an interactive terminal pane per thread).

## 5. Data model

Persisted in SQLite (main process); streamed deltas to the renderer.

- **Project** (= "channel"): `id, name, dir (abs path), gitRemote?, defaultBranch, createdAt`.
  Backed by `resolveProject`/a registry; dir is a local directory, usually a git repo root.
- **Thread**: `id, projectId, kind (chat | ticket | teamlead), title, ticketKey?
  (Trello card key), branch? (ticket/<key>), worktreePath?, status (active|done|blocked|
  archived), createdAt`. One thread per ticket; team-lead threads and free chat threads too.
- **Message**: `id, threadId, role (user|assistant|tool|system), text, toolName?, toolInput?,
  streamedSeq, createdAt`. Rendered from stream-json events (assistant text, tool_use,
  tool_result) — same event shapes `claude.js` already parses (`:247-309`).
- **Session**: `threadId → claudeSessionId` (replaces `sessions.json`); ephemeral for ticket
  threads (no `--resume`, discarded on completion — matches the isolation plan).
- **Process**: `id, threadId, pid, kind (run|terminal), state (running|idle|exited|killed),
  model, effort, startedAt, contextTokens, costUsd`. One per active `claude` spawn; drives the
  live map + the existing usage/cost tracking.
- **Worktree**: `id, projectId, threadId, path, branch, base, createdAt` (from `git worktree`).
- **PullRequest**: `id, projectId, threadId, number, url, state (open|merged|closed), checks
  (passing|failing|pending)` — polled via `gh`.
- **Task / BoardItem**: mirrors `TASKS.md` + Trello (`key, title, status
  (todo|in-progress|blocked|in-review|done), body, projectId?, threadId?`). The team-lead board.
- **ApprovalRequest**: `id, threadId, tool, input, state (pending|approved|denied), createdAt`
  — surfaced as a modal (replaces Discord approve/deny buttons).

## 6. How it talks to local Claude Code

Reuse today's mechanism verbatim, just re-targeted from Discord to the app:
- **Run a turn:** main process spawns `claude -p --output-format stream-json --verbose` in the
  thread's cwd (project dir, or the ticket worktree), with `--model/--effort/--resume/--betas`
  and the MCP approval server wired (exactly `claude.js:118-177`). Stream-json lines are parsed
  (`:232-309`) into Message deltas and pushed to the renderer over WebSocket/IPC.
- **Sessions:** persisted per thread (SQLite), resumed with `--resume`; ticket threads run
  ephemeral. Auto-reset on context cap carries over (`:360-381`).
- **Approvals:** the MCP `approve` tool currently blocks on a Discord button; instead it resolves
  against an **ApprovalRequest** the app shows as a modal (approve/deny/always). Same
  `pauseInactivity/resumeInactivity` timer handling (`:34-37`).
- **Interactive terminal:** `node-pty` pane per thread (reuse `terminal.js`), xterm.js in the
  renderer.
- **Team-lead:** the heartbeat loop runs in the core; its delegations create **ticket threads**
  (each its own worktree + process), which is precisely the one-thread-per-ticket requirement.
- **Git/PR/worktree state:** main process runs `git`/`gh` (worktree list, branch, PR status)
  and emits updates → feeds the board and the live map.
- **Cancellation / stop:** reuse `cancelRun` per session (`:41-46`) → a Stop button per thread.

## 7. UI surfaces
1. **Shell (Discord-like):** left rail = Projects (channels); within a project = Threads list;
   center = active thread (messages, tool calls, approvals, terminal); right = context
   (branch/PR/process/worktree for that thread).
2. **Team-lead workspace:** dedicated screen — board (columns todo→done, mirrors Trello/TASKS.md),
   project overview, and a console to talk to the team-lead and open/monitor delegated threads.
3. **Live map (later):** React Flow graph — team-lead → projects → threads → processes →
   worktrees → PRs, with live status (running/blocked/PR-open/checks). Click a node → jump to
   that thread. Mermaid export for sharing.

## 8. Phased rollout
- **Phase 0 — Core extraction & scaffold.** Refactor `src/` into `core/` (transport-agnostic) +
  a local WS/REST server; Electron+React+Vite shell talking to it. No feature regressions; the
  Discord bridge keeps working off the same core. *Exit:* app opens, lists projects, echoes a
  session.
- **Phase 1 — MVP chat (replace basic Discord).** Project rail + thread chat with live
  stream-json rendering, send messages to a project session, approvals-as-modals, per-thread
  stop, terminal pane. *Exit:* Marc can do real work in one project without Discord.
- **Phase 2 — Team-lead workspace + board.** Team-lead screen, board mirroring TASKS.md/Trello,
  delegate from the UI, one-thread-per-ticket, multiple concurrent threads. *Exit:* team-lead
  fully drivable from the app.
- **Phase 3 — Per-ticket isolation surfaced.** Wire the worktree-per-ticket plan: each ticket
  thread shows its branch/worktree/PR; process + cost per thread. *Exit:* parallel isolated
  tickets visible and controllable.
- **Phase 4 — Live map.** React Flow view over the model from Phases 2–3.
- **Phase 5 (future) — Pluggable providers.** Provider abstraction behind `core/session`
  (Anthropic today; OpenAI/Gemini seams). Not built now; §4 keeps the seam.
- **Phase 6 (later) — Mobile companion.** Only needs the daemon split (§4-B) done; mobile is
  another client of the same API.

## 9. Open questions / decisions for Marc (do NOT guess)
1. **App-as-host vs daemon+client (§4).** Recommend building toward the daemon split but running
   in-process for MVP. Confirm — it shapes everything, and the mobile phase depends on it.
2. **Migration:** run the Discord bridge in parallel during rollout (recommended), or hard-cut to
   the app at some phase?
3. **Repo layout:** monorepo in *this* repo (turn `src/` into `packages/core`, add
   `packages/desktop`) — recommended for reuse — vs a separate app repo. Confirm this repo is the
   intended home.
4. **Persistence:** adopt SQLite for message/thread history (recommended) vs stay JSON?
5. **Approval posture:** default to prompting (modals) vs auto-approve (`bypassPermissions`) for
   trusted projects? What's the default, and per-project override?
6. **Live map tech:** React Flow (recommended, live) vs literal Mermaid (static, but matches the
   "Mermaid-style" wording). Which do you actually want?
7. **Remote/mobile security:** local-only for now, or expose a tunnel? If remote, auth model?
   (Deferred, but it constrains §4.)
8. **Provider abstraction now-or-later:** you said later — confirm we only leave seams, not build
   multi-provider in this effort.
9. **Fable for kickstart:** you offered `fable` for ideation/scaffolding — want the Phase-0
   scaffold generated with fable, or stay on the current model?
10. **Branding/name:** app name — "Ventriloquist" (the repo/remote) or something new?

## 10. Risks
- **Core extraction churn** — refactoring a live always-on bridge; mitigate by keeping the
  Discord adapter on the same core until the app reaches parity.
- **Electron footprint** — RAM/binary size on an always-on Mac; acceptable for a dev tool.
- **Concurrency** — many parallel ticket processes + worktrees stress the host and token budget;
  reuse the per-channel/global caps from the isolation plan.
- **Approval UX** — blocking modals must never wedge a run; reuse the pause/resume timer model.

## 11. Proposed repo layout (if §9.3 = this repo)
```
packages/
  core/       # extracted from src/: session, projects, teamlead, worktrees, approvals, usage, terminal
  server/     # local WS + REST over core (the daemon)
  desktop/    # Electron main (hosts core or connects to server) + React renderer
  discord/    # existing bridge, now a thin core client (kept during migration)
docs/
  desktop-app-plan.md   # this doc
```
