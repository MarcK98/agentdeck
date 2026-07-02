import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resetSession, cancelRun } from "./claude.js";

// Bridge commands are handled here and NOT forwarded to Claude. Everything
// else that starts with "/" (custom commands, skills) is passed through, since
// Claude Code expands those itself in headless mode.

// Names of *.md files in a .claude/commands dir (custom slash commands).
function commandsIn(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  } catch {
    return []; // dir missing / unreadable
  }
}

// Subdirectories of a .claude/skills dir (each is a skill, invoked as /name).
function skillsIn(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function buildHelp(projectDir) {
  const lines = [
    "**Bridge commands**",
    "`/reset` — start a fresh conversation for this channel",
    "`/stop` — cancel the run in progress",
    "`/help` — show this message",
  ];

  const home = homedir();
  const custom = new Set([
    ...commandsIn(join(home, ".claude", "commands")),
    ...(projectDir ? commandsIn(join(projectDir, ".claude", "commands")) : []),
  ]);
  const skills = projectDir ? skillsIn(join(projectDir, ".claude", "skills")) : [];

  if (custom.size || skills.length) {
    lines.push("", "**Claude Code commands available here**");
    for (const name of [...custom].sort()) lines.push(`\`/${name}\``);
    for (const name of [...skills].sort()) lines.push(`\`/${name}\` (skill)`);
  }

  lines.push(
    "",
    "Other Claude Code slash commands work too, but interactive ones " +
      "(`/workflows`, `/status`, `/clear`, …) need a terminal and won't run here."
  );
  return lines.join("\n");
}

/**
 * If `text` is a bridge command, handle it and return a reply string.
 * Returns null when it isn't one — the caller should forward to Claude.
 */
export function runBridgeCommand({ text, sessionKey, projectDir }) {
  const cmd = text.trim().split(/\s+/)[0]?.toLowerCase();
  switch (cmd) {
    case "/reset":
      return resetSession(sessionKey)
        ? "🔄 Started a fresh conversation. The next message won't remember earlier context."
        : "🔄 Already a fresh conversation — nothing to reset.";
    case "/stop":
      return cancelRun(sessionKey)
        ? "🛑 Stopped the run in progress."
        : "Nothing is running right now.";
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
