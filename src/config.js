import "dotenv/config";

const bool = (v, def = false) => {
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
};

const list = (v) =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Split a shell-like arg string into tokens, respecting single/double quotes.
// e.g.  --allowedTools "Read,Grep" --permission-mode plan
//   ->  ["--allowedTools", "Read,Grep", "--permission-mode", "plan"]
const tokenizeArgs = (v) => {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(v)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
};

export const config = {
  channels: list(process.env.CHANNELS).length
    ? list(process.env.CHANNELS)
    : ["discord"],

  discord: {
    token: process.env.DISCORD_BOT_TOKEN || "",
    allowedChannels: list(process.env.DISCORD_ALLOWED_CHANNELS),
    requireMention: bool(process.env.DISCORD_REQUIRE_MENTION, true),
  },

  projects: {
    // Base folder: a channel named "my-app" maps to <root>/my-app
    root: process.env.PROJECTS_ROOT || "",
    // Fallback project for DMs / unmapped channels. Empty = ignore them.
    defaultDir: process.env.DEFAULT_PROJECT || "",
  },

  attachments: {
    // Download message attachments to a temp folder and expose it to Claude
    // (via --add-dir) so it can read images, PDFs, code, etc. from disk.
    enabled: bool(process.env.ATTACHMENTS_ENABLED, true),
    // Skip any single attachment larger than this (megabytes).
    maxMb: Number(process.env.ATTACHMENT_MAX_MB) || 25,
  },

  vpn: {
    // Let agents (mainly the team lead) toggle the Tunnelblick VPN on the host
    // via the `vpn` MCP tool, to bring it up when a channel needs the VPN to
    // reach its backend/database/services.
    enabled: bool(process.env.VPN_CONTROL_ENABLED, false),
    // Default Tunnelblick configuration name when a call omits one.
    defaultConfig: process.env.TUNNELBLICK_CONFIG || "",
    // Allowlist of configuration names an agent may touch (empty = any).
    allowed: list(process.env.VPN_ALLOWED_CONFIGS),
  },

  trello: {
    // Mirror the team lead's TASKS.md to a Trello board and surface Marc's board
    // changes back to the team lead. Off unless enabled + credentials present.
    enabled: bool(process.env.TRELLO_ENABLED, false),
    key: process.env.TRELLO_API_KEY || "",
    token: process.env.TRELLO_TOKEN || "",
    // API secret (same Power-Up as the key) — used to verify the HMAC on
    // incoming webhook POSTs. Required when a webhook callback URL is set.
    apiSecret: process.env.TRELLO_API_SECRET || "",
    // Board short id (from the board URL, e.g. Oy8FxTK4) or the long id.
    boardId: process.env.TRELLO_BOARD_ID || "",
    // Task status -> board list name. Missing lists are auto-created on start.
    lists: {
      todo: process.env.TRELLO_LIST_TODO || "To Do",
      "in-progress": process.env.TRELLO_LIST_IN_PROGRESS || "In Progress",
      blocked: process.env.TRELLO_LIST_BLOCKED || "Blocked",
      "in-review": process.env.TRELLO_LIST_IN_REVIEW || "In Review",
      done: process.env.TRELLO_LIST_DONE || "Done",
    },
    // How often to poll the board for Marc's changes (moves/adds/comments).
    pollMs: (Number(process.env.TRELLO_POLL_SECONDS) || 120) * 1000,
    // Public HTTPS URL Trello POSTs card events to. Empty = poll only.
    webhookCallbackUrl: process.env.TRELLO_WEBHOOK_CALLBACK_URL || "",
    // Local port the webhook receiver listens on (behind your tunnel/proxy).
    webhookPort: Number(process.env.TRELLO_WEBHOOK_PORT) || 8792,
    // Wake the team lead immediately on a board change (costs a run). Off = fold
    // the change into the next scheduled heartbeat tick (cheaper).
    nudgeOnChange: bool(process.env.TRELLO_NUDGE_ON_CHANGE, false),
  },

  browser: {
    // Give agents Chrome access via Google's chrome-devtools-mcp (launched with
    // npx), so they can drive a browser without you switching to /terminal.
    enabled: bool(process.env.BROWSER_MCP_ENABLED, false),
    // Connect to an already-running Chrome over CDP (keeps your logged-in
    // sessions / auth-gated backends). Start Chrome with
    //   --remote-debugging-port=9222
    // then set this to e.g. http://127.0.0.1:9222. Empty = let the MCP launch
    // and manage its own Chrome.
    url: process.env.BROWSER_MCP_URL || "",
    // When launching its own Chrome: release channel (stable|canary|beta|dev).
    channel: process.env.BROWSER_MCP_CHANNEL || "",
    // Run that launched Chrome headless (ignored when `url` is set).
    headless: bool(process.env.BROWSER_MCP_HEADLESS, false),
    // Use a throwaway profile instead of the persistent one (no saved logins).
    isolated: bool(process.env.BROWSER_MCP_ISOLATED, false),
  },

  share: {
    // Extra absolute dirs (comma-separated) an agent may upload files from with
    // the share_file tool, on top of the channel's own project dir, PROJECTS_ROOT,
    // DEFAULT_PROJECT, and the system temp dir. Widen this to share from e.g.
    // ~/Desktop. (Agents run auto-approved, so this is hygiene, not a hard wall —
    // an agent can already read+paste any file it can access.)
    allowedDirs: list(process.env.SHARE_ALLOWED_DIRS),
  },

  progress: {
    // Post a live, in-place-updated status message showing the tool Claude is
    // currently running (nice for long CI waits / multi-step work).
    enabled: bool(process.env.PROGRESS_ENABLED, true),
  },

  controls: {
    // A sticky control bar (Reset context / Stop / Pause-Resume buttons) kept at
    // the bottom of a channel so it's always visible. Re-posted after activity.
    enabled: bool(process.env.CONTROLS_ENABLED, false),
    // Channel names/ids to show it in. Empty = just the team-lead channel.
    channels: list(process.env.CONTROL_CHANNELS),
  },

  terminal: {
    // Interactive commands (/workflows, …) open a live PTY terminal rendered to
    // Discord instead of failing. Needs @lydell/node-pty + @xterm/headless.
    enabled: bool(process.env.TERMINAL_ENABLED, true),
    // Slash commands that flip a channel into terminal mode (/terminal always
    // does). Compared case-insensitively against the first word.
    triggers: (list(process.env.TERMINAL_TRIGGERS).length
      ? list(process.env.TERMINAL_TRIGGERS)
      : ["/workflows"]
    ).map((s) => s.toLowerCase()),
    // Auto-close a terminal after this much silence (no output, no input).
    idleMs: (Number(process.env.TERMINAL_IDLE_SECONDS) || 3600) * 1000,
    // Emulated screen size. Kept small so a full screen fits one Discord message.
    cols: 80,
    rows: 24,
    // Grace period after opening before the triggering command is typed in.
    bootMs: 2500,
  },

  approvals: {
    // Route Claude's permission prompts (run command, edit file, …) to Discord.
    enabled: bool(process.env.APPROVALS_ENABLED, true),
    port: Number(process.env.APPROVAL_PORT) || 8790,
    // How long a Discord approval prompt waits before auto-denying.
    timeoutMs: (Number(process.env.APPROVAL_TIMEOUT_SECONDS) || 300) * 1000,
  },

  dashboard: {
    // Local usage-analytics dashboard (`npm run dashboard`). Reads the usage
    // ledger (usage.jsonl) + Claude Code's own JSONL logs; serves charts on
    // http://localhost:<port>. Read-only; nothing is exposed off-box.
    port: Number(process.env.DASHBOARD_PORT) || 8791,
    // How many days of Claude Code history to scan for the account-wide view.
    backfillDays: Number(process.env.DASHBOARD_BACKFILL_DAYS) || 30,
    // "Stay within plan" gauges. The Max x20 plan has no public token cap
    // (dynamic rolling 5h + weekly limits), so set your own soft ceilings from
    // observed usage. Gauges warn as a rolling window approaches these. USD is
    // equivalent-cost (see src/pricing.js); 0 = hide that gauge's limit line.
    limitUsd5h: Number(process.env.DASHBOARD_LIMIT_USD_5H) || 0,
    limitUsd7d: Number(process.env.DASHBOARD_LIMIT_USD_7D) || 0,
    limitTokens5h: Number(process.env.DASHBOARD_LIMIT_TOKENS_5H) || 0,
    limitTokens7d: Number(process.env.DASHBOARD_LIMIT_TOKENS_7D) || 0,
  },

  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    cwd: process.env.CLAUDE_CWD || process.cwd(),
    model: process.env.CLAUDE_MODEL || "",
    // Default reasoning effort: low | medium | high | xhigh | max. Empty = CLI
    // default. Per-run opts.effort (heartbeat, delegation) overrides this.
    effort: process.env.CLAUDE_EFFORT || "",
    // Auto-reset a channel's session once a run's context passes this many tokens
    // (bounds cost / stays clear of the model window). 0 = off (grow until the
    // model's own window). The team lead overrides this with its own higher cap.
    maxContextTokens: Number(process.env.CLAUDE_MAX_CONTEXT_TOKENS) || 0,
    // Beta headers passed to every request (space/comma-separated). Use this to
    // enable Sonnet's 1M context window: CLAUDE_BETAS=context-1m-2025-08-07
    // (also set CLAUDE_MODEL=sonnet and a larger *_MAX_CONTEXT_TOKENS).
    betas: list(process.env.CLAUDE_BETAS),
    // "", "acceptEdits" (auto-approve file edits), or "bypassPermissions"
    // (auto-approve EVERYTHING — no Discord prompts).
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || "",
    persistSessions: bool(process.env.CLAUDE_PERSIST_SESSIONS, true),
    extraArgs: tokenizeArgs(process.env.CLAUDE_EXTRA_ARGS || ""),
    // Idle timeout: how long Claude may go silent *between* actions before the
    // run is killed. Reset on every stream event, paused during approval prompts.
    timeoutMs:
      (Number(process.env.CLAUDE_TIMEOUT_SECONDS) || 180) * 1000,
    // Tool timeout: how long a single running tool (build, test suite,
    // `gh run watch`, a CI poll, …) may work with no output before being
    // killed. Much larger than the idle timeout, since a busy tool is silent.
    toolTimeoutMs:
      (Number(process.env.CLAUDE_TOOL_TIMEOUT_SECONDS) || 1800) * 1000,
  },
};
