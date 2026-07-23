# AgentDeck — Phase 0 report (checkpoint for Marc)

Phase 0 of `docs/desktop-app-plan.md` is done, on branch `phase-0-scaffold`.
Per your instruction this is a hard stop — no Phase 1 work starts until you say go.

## Delivered

**Monorepo restructure (decision #3)**
- `src/` → `packages/core` (`@agentdeck/core`), `public/` and `scripts/` moved with it.
- Root `src/` now holds two compatibility shims (`index.js`, `mcp/approval-server.js`)
  so the RUNNING bridge and the muscle-memory `node src/index.js` restart keep working
  untouched until the Discord hard-cut. Verified: shim MCP handshake works under the
  bridge's actual runtime (asdf node v20.9.0).
- Runtime state (sessions.json, usage.jsonl, projects.json, .trello-state.json, agentdeck.db)
  now resolves through one `dataDir` (default repo root, override `SPAWN_DATA_DIR`).

**SQLite store (decision #4)**
- `better-sqlite3` (fastest embedded option), WAL, FK-enforced, `user_version` migrations.
- Schema v1: `projects` / `threads` (kind chat|ticket|teamlead, ticket_key, branch,
  worktree_path, status) / `messages` (role user|assistant|tool|system, stream seq).
- ABI note solved by the process split: only the daemon (plain Node) loads the
  native module — the desktop app never touches SQLite, so there is no
  Electron-vs-node ABI collision at all, and no electron-rebuild step.

**Direct Claude wiring (decision update: NO provider abstraction)**
- Per Marc: AgentDeck is **a mastermind for Claude**, not a multi-provider platform.
  The earlier AgentProvider seam was built, then deleted on his update — the daemon
  now calls the existing `askClaude` pipeline (queueing, --resume, stream parsing,
  timeouts, cancel, usage recording) directly. Zero abstraction layers.
- `claude.js` gained two small capabilities: per-run `persistSessions:false`
  (ephemeral runs for isolated ticket threads) and a per-process sessions file
  (`SPAWN_SESSIONS_FILE`) so the daemon and the bridge never clobber each other's
  session ledgers.

**Real daemon process (decision update: separate process, not in-process)**
- `packages/core/src/daemon/server.js` — the AgentDeck daemon runs as its OWN
  background process and owns Claude sessions, threads, and the SQLite store.
  Localhost-only API: `GET /health`, `POST /rpc` (method allow-list), `WS /events`.
  Remote/mobile later = an authenticated layer (Supabase Auth) in front of this
  same surface, never exposing the port.
- `daemon/index.js` — the method surface: listProjects / threads / messages /
  sendMessage (streams via events) / cancelTurn / settings. JSON-only args+results.
- Per-project settings seam (`project-settings.js`): approvalMode prompt|auto,
  allowedModels (fable = explicit opt-in), MCPs, skills — and secrets kept in a
  separate daemon-side store that is structurally excluded from every method
  result/event.
- Run it: `npm run daemon` — or don't: the desktop app auto-starts it (detached,
  survives the app closing).

**Desktop client (AgentDeck branding, decision #10)**
- `packages/desktop` — Electron is a pure CLIENT of the daemon
  (`electron/daemon-client.js`: health-check → auto-spawn → HTTP RPC + WS events).
  Renderer is React+TS+Vite, Discord-shaped three panes: projects rail / threads /
  chat with live streaming. `npm run desktop` at root for dev.

## Verified
- Bridge modules all load under runtime node v20.9.0; approval-server shim answers a
  real MCP initialize. Live bridge untouched throughout.
- DB CRUD + pagination round-trip in a temp `SPAWN_DATA_DIR`.
- Daemon standalone: `/health` OK, RPC round-trip lists real projects, unknown
  method rejected (`__proto__` guard), WS delivers `thread:created` live.
- Desktop smoke both paths: no daemon → **auto-spawns one** (25 projects via RPC);
  relaunch → finds it **already up** (detached daemon survived the app exiting).
- `tsc --noEmit` clean; `vite build` clean; headed launch stays up.

## Operational notes
- Restart the bridge whenever convenient — both old (`node src/index.js`) and new
  layouts work; nothing urgent.
- First `npm install` needed a retry (transient network); nothing structural.

## Token usage (Phase 0 total, fable)
Exact figures land in `usage.jsonl` / the dashboard when the runs complete —
check `/cost` in this channel for the authoritative number. Honest estimate across
the two Phase 0 runs (scaffold + the daemon/provider correction pass): long
multi-step sessions, ~90 tool calls total, heavy repo recon + build/verify loops;
ballpark **~$25–45 of fable** for the phase. Note the correction pass included
building-then-deleting the provider seam per the mid-phase decision change — the
deleted work was small (~2 files), most spend was verification against the live
bridge and the daemon E2E, which are the parts that had to be right.

## Gate: what Phase 1 would be (awaiting your go)
MVP chat hardening: message streaming without full re-pulls, approval-prompt modals
(prompt mode), thread titles/rename, project settings page backed by the seam,
daemon lifecycle polish (launchd / single-instance lock / log file). Say the word (and whether fable
continues or we drop to sonnet for the routine parts).
