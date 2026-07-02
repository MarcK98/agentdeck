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

  progress: {
    // Post a live, in-place-updated status message showing the tool Claude is
    // currently running (nice for long CI waits / multi-step work).
    enabled: bool(process.env.PROGRESS_ENABLED, true),
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
    idleMs: (Number(process.env.TERMINAL_IDLE_SECONDS) || 900) * 1000,
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

  claude: {
    bin: process.env.CLAUDE_BIN || "claude",
    cwd: process.env.CLAUDE_CWD || process.cwd(),
    model: process.env.CLAUDE_MODEL || "",
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
