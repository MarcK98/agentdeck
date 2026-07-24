import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  resetSession,
  cancelRun,
  setModel,
  getModel,
  getLastStats,
} from "./claude.js";
import { config } from "./config.js";

// Bridge commands are handled here and NOT forwarded to Claude. Everything
// else that starts with "/" (custom commands, skills) is passed through, since
// Claude Code expands those itself in headless mode.
//
// A few interactive Claude Code commands are reimplemented here from data the
// bridge already has (features B), because the real ones need a terminal:
//   /status /cost   from the last run's result event
//   /model          per-channel model override
//   /mcp /agents    listed from project + user config files
//   /clear          alias of /reset

// ── small formatters ─────────────────────────────────────────────────────
const usd = (n) =>
  typeof n === "number" ? "$" + n.toFixed(n < 0.01 ? 4 : 2) : "n/a";

const dur = (ms) => {
  if (typeof ms !== "number") return "n/a";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

const ago = (at) => {
  if (!at) return "";
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// ── filesystem scans ─────────────────────────────────────────────────────
function namesIn(dir, { ext = null, dirs = false } = {}) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => (dirs ? e.isDirectory() : e.isFile()))
      .map((e) => e.name)
      .filter((n) => (ext ? n.endsWith(ext) : true))
      .map((n) => (ext ? n.slice(0, -ext.length) : n));
  } catch {
    return []; // dir missing / unreadable
  }
}

// First `description:` from a markdown file's frontmatter, if any.
function descOf(path) {
  try {
    const head = readFileSync(path, "utf8").slice(0, 600);
    const m = head.match(/^description:\s*(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

// ── command bodies ───────────────────────────────────────────────────────
function buildHelp(projectDir) {
  const lines = [
    "**Bridge commands**",
    "`/reset` — start a fresh conversation (clears this channel's session)",
    "`/clear` — alias of /reset",
    "`/stop` — cancel the run in progress",
    "`/status` — model + last run summary",
    "`/cost` — cost & tokens of the last run",
    "`/model [name]` — show or set this channel's model (e.g. `/model sonnet`)",
    "`/mcp` — list this project's MCP servers",
    "`/agents` — list available subagents",
    "`/help` — show this message",
  ];

  const home = homedir();
  const custom = new Set([
    ...namesIn(join(home, ".claude", "commands"), { ext: ".md" }),
    ...(projectDir
      ? namesIn(join(projectDir, ".claude", "commands"), { ext: ".md" })
      : []),
  ]);
  const skills = projectDir
    ? namesIn(join(projectDir, ".claude", "skills"), { dirs: true })
    : [];

  if (custom.size || skills.length) {
    lines.push("", "**Claude Code commands available here**");
    for (const name of [...custom].sort()) lines.push(`\`/${name}\``);
    for (const name of [...skills].sort()) lines.push(`\`/${name}\` (skill)`);
  }

  lines.push(
    "",
    "Other Claude Code slash commands work too, but interactive ones " +
      "(`/workflows`, `/config`, …) need a terminal and won't run here."
  );
  return lines.join("\n");
}

function statusText(sessionKey, projectDir) {
  const model = getModel(sessionKey) || "(CLI default)";
  const s = getLastStats(sessionKey);
  const lines = [
    "**Status**",
    `Project: \`${projectDir || "(default)"}\``,
    `Model: \`${model}\``,
  ];
  if (!s) {
    lines.push("No runs yet in this channel.");
  } else {
    lines.push(
      `Last run: ${dur(s.durationMs)}, ${s.numTurns ?? "?"} turn(s), ` +
        `${usd(s.costUsd)} — ${ago(s.at)}`
    );
  }
  return lines.join("\n");
}

function costText(sessionKey) {
  const s = getLastStats(sessionKey);
  if (!s) return "No runs yet in this channel.";
  const u = s.usage || {};
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return [
    "**Last run**",
    `Cost: ${usd(s.costUsd)}`,
    `Tokens: ${u.input_tokens ?? 0} in / ${u.output_tokens ?? 0} out`,
    `Cache: ${cacheRead} read / ${cacheWrite} write`,
    `Duration: ${dur(s.durationMs)} · ${ago(s.at)}`,
  ].join("\n");
}

function modelText(sessionKey, arg) {
  if (!arg) {
    const cur = getModel(sessionKey);
    return cur
      ? `Model for this channel: \`${cur}\`. Set with \`/model <name>\`, clear with \`/model default\`.`
      : "Using the CLI default model. Set one with `/model <name>` (e.g. `/model sonnet`).";
  }
  if (/^(default|reset|clear)$/i.test(arg)) {
    setModel(sessionKey, "");
    return "Reverted to the CLI default model for this channel.";
  }
  setModel(sessionKey, arg);
  return `Model set to \`${arg}\` for this channel. Takes effect on your next message.`;
}

function mcpText(projectDir) {
  const lines = ["**MCP servers**"];
  let found = false;
  if (projectDir) {
    try {
      const raw = readFileSync(join(projectDir, ".mcp.json"), "utf8");
      const servers = JSON.parse(raw).mcpServers || {};
      const names = Object.keys(servers);
      if (names.length) {
        found = true;
        for (const n of names) lines.push(`\`${n}\``);
      }
    } catch {
      /* no .mcp.json */
    }
  }
  if (!found) lines.push("No project MCP servers (`.mcp.json` not found).");
  if (config.approvals.enabled) {
    lines.push("", "_`approver` is injected by the bridge for Discord approvals._");
  }
  return lines.join("\n");
}

function agentsText(projectDir) {
  const home = homedir();
  const dirs = [
    projectDir ? join(projectDir, ".claude", "agents") : null,
    join(home, ".claude", "agents"),
  ].filter(Boolean);

  const seen = new Set();
  const lines = ["**Subagents**"];
  for (const dir of dirs) {
    for (const name of namesIn(dir, { ext: ".md" }).sort()) {
      if (seen.has(name)) continue;
      seen.add(name);
      const d = descOf(join(dir, `${name}.md`));
      lines.push(`\`${name}\`${d ? ` — ${d.slice(0, 100)}` : ""}`);
    }
  }
  if (seen.size === 0) lines.push("No custom subagents found.");
  return lines.join("\n");
}

/**
 * If `text` is a bridge command, handle it and return a reply string.
 * Returns null when it isn't one — the caller should forward to Claude.
 */
export function runBridgeCommand({ text, sessionKey, projectDir }) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();
  const arg = parts.slice(1).join(" ").trim();

  switch (cmd) {
    case "/reset":
    case "/clear":
      return resetSession(sessionKey)
        ? "🔄 Started a fresh conversation. The next message won't remember earlier context."
        : "🔄 Already a fresh conversation — nothing to reset.";
    case "/stop":
      return cancelRun(sessionKey)
        ? "🛑 Stopped the run in progress."
        : "Nothing is running right now.";
    case "/status":
      return statusText(sessionKey, projectDir);
    case "/cost":
      return costText(sessionKey);
    case "/model":
      return modelText(sessionKey, arg);
    case "/mcp":
      return mcpText(projectDir);
    case "/agents":
      return agentsText(projectDir);
    case "/help":
      return buildHelp(projectDir);
    default:
      return null; // not a bridge command
  }
}

// True when Claude reported a slash command can't run headlessly, so the
// adapter can add a helpful hint about what DOES work here.
export function isInteractiveCommandMiss(userText, resultText) {
  return (
    userText.trim().startsWith("/") &&
    /isn'?t available in this environment/i.test(resultText || "")
  );
}

// Compact one-line label for a tool invocation (feature C progress).
export function progressLabel({ tool, input = {} }) {
  const file = input.file_path || input.path || input.notebook_path;
  const short = (s, n = 60) =>
    typeof s === "string" ? (s.length > n ? s.slice(0, n) + "…" : s) : "";
  switch (tool) {
    case "Bash":
      return `🔧 ${input.description || short(input.command) || "shell command"}`;
    case "Read":
      return `📖 Reading ${short(file)}`;
    case "Edit":
    case "MultiEdit":
      return `✏️ Editing ${short(file)}`;
    case "Write":
      return `💾 Writing ${short(file)}`;
    case "Grep":
      return `🔎 Searching ${short(input.pattern)}`;
    case "Glob":
      return `🔎 Finding ${short(input.pattern)}`;
    case "Task":
      return `🤖 Subagent: ${short(input.description) || "task"}`;
    case "WebFetch":
      return `🌐 Fetching ${short(input.url)}`;
    case "WebSearch":
      return `🌐 Searching “${short(input.query)}”`;
    case "TodoWrite":
      return "📝 Updating plan";
    default: {
      const m = tool?.match?.(/^mcp__(.+?)__(.+)$/);
      return m ? `🔌 ${m[2].replaceAll("_", " ")} (${m[1]})` : `🔧 ${tool}`;
    }
  }
}
