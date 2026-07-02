import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { log } from "./logger.js";

const SESSIONS_FILE = new URL("../sessions.json", import.meta.url);

// sessionKey (e.g. "discord:123456") -> claude session_id
let sessions = {};
try {
  sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
} catch {
  /* first run */
}

const saveSessions = () => {
  try {
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
  } catch (err) {
    log.warn("Could not persist sessions.json:", err.message);
  }
};

// One message at a time per session key, so replies stay in order
// and --resume never races against itself.
const queues = new Map();

// Active runs, so the approval flow can pause the inactivity timer
// while a permission prompt is waiting on a human.
const activeRuns = new Map(); // sessionKey -> { pause, resume }

export const pauseInactivity = (sessionKey) =>
  activeRuns.get(sessionKey)?.pause();
export const resumeInactivity = (sessionKey) =>
  activeRuns.get(sessionKey)?.resume();

// Kill the in-progress run for a channel (the `/stop` bridge command).
// Returns false if nothing is running.
export const cancelRun = (sessionKey) => {
  const run = activeRuns.get(sessionKey);
  if (!run) return false;
  run.cancel();
  return true;
};

// Forget a channel's stored conversation so the next message starts fresh
// (the `/reset` bridge command). Returns false if there was nothing to clear.
export const resetSession = (sessionKey) => {
  if (!sessions[sessionKey]) return false;
  delete sessions[sessionKey];
  saveSessions();
  return true;
};

/**
 * Ask Claude. `onText(text)` is called with each assistant message's text
 * as it streams in (i.e. between tool calls), so adapters can relay
 * progress live. The resolved value's `streamed` count says how many
 * chunks were already delivered that way — the final `text` is the last
 * assistant message, so adapters that streamed shouldn't re-send it.
 */
export function askClaude(sessionKey, prompt, cwd, onText, opts = {}) {
  const prev = queues.get(sessionKey) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => run(sessionKey, prompt, cwd, onText, opts));
  queues.set(sessionKey, next);
  return next;
}

const APPROVAL_MCP_PATH = fileURLToPath(
  new URL("./mcp/approval-server.js", import.meta.url)
);

function run(sessionKey, prompt, cwdOverride, onText, opts = {}) {
  const { bin, model, persistSessions, extraArgs, timeoutMs, toolTimeoutMs } =
    config.claude;
  const cwd = cwdOverride || config.claude.cwd;

  // stream-json emits one JSON event per line as Claude works
  // (--verbose is required with -p + stream-json).
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (model) args.push("--model", model);
  if (config.claude.permissionMode) {
    args.push("--permission-mode", config.claude.permissionMode);
  }
  if (persistSessions && sessions[sessionKey]) {
    args.push("--resume", sessions[sessionKey]);
  }

  // Extra allowed directories (e.g. a temp folder holding message attachments),
  // so Claude can read them without a per-file approval prompt.
  for (const dir of opts.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  // Route permission prompts to Discord via the approval MCP server.
  if (config.approvals.enabled) {
    const mcpConfig = {
      mcpServers: {
        approver: {
          command: process.execPath, // this node binary
          args: [APPROVAL_MCP_PATH],
        },
      },
    };
    args.push("--mcp-config", JSON.stringify(mcpConfig));
    args.push("--permission-prompt-tool", "mcp__approver__approve");
  }

  args.push(...extraArgs);

  log.info(`[claude] run (${sessionKey}) in ${cwd}:`, prompt.slice(0, 80));

  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        BRIDGE_SESSION_KEY: sessionKey,
        BRIDGE_APPROVAL_PORT: String(config.approvals.port),
        BRIDGE_APPROVAL_TIMEOUT_MS: String(config.approvals.timeoutMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let lineBuf = "";
    let timedOut = false;
    let cancelled = false; // killed by the /stop bridge command
    let timedOutInTool = false; // which limit fired, for the message
    let timedOutLimitMs = timeoutMs;
    let streamed = 0;
    let pendingTools = 0; // tool_use events seen but not yet resolved
    let result = null; // final { text, isError } from the "result" event

    // ── Inactivity timeout ───────────────────────────────────────────────
    // The clock only counts silence: every event Claude emits resets it,
    // and it's paused entirely while an approval prompt waits on a human.
    //
    // A running tool (build, test suite, `gh run watch`, a CI poll, …) emits
    // NO events while it works, so silence there is expected — not a hang.
    // While a tool is in flight we therefore allow the much larger
    // toolTimeoutMs instead of the short idle timeoutMs.
    let timer = null;
    let paused = 0;

    const armTimer = () => {
      clearTimeout(timer);
      if (paused > 0) return;
      const inTool = pendingTools > 0;
      const limit = inTool ? toolTimeoutMs : timeoutMs;
      timer = setTimeout(() => {
        timedOut = true;
        timedOutInTool = inTool;
        timedOutLimitMs = limit;
        child.kill("SIGKILL");
      }, limit);
    };

    activeRuns.set(sessionKey, {
      pause: () => {
        paused++;
        clearTimeout(timer);
      },
      resume: () => {
        paused = Math.max(0, paused - 1);
        armTimer();
      },
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
      },
    });

    armTimer();

    // ── Stream parsing ───────────────────────────────────────────────────
    const handleEvent = (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // ignore non-JSON noise
      }

      // Persist the session id as soon as we know it, so even a run that
      // later times out can be resumed.
      if (ev.session_id && persistSessions && sessions[sessionKey] !== ev.session_id) {
        sessions[sessionKey] = ev.session_id;
        saveSessions();
      }

      if (ev.type === "assistant") {
        const blocks = ev.message?.content ?? [];
        // A tool the assistant is about to run — its result arrives later as a
        // "user" tool_result event. Track the gap so the timer can be lenient.
        pendingTools += blocks.filter((b) => b.type === "tool_use").length;
        const text = blocks
          .filter((b) => b.type === "text" && b.text?.trim())
          .map((b) => b.text)
          .join("\n");
        if (text && onText) {
          streamed++;
          try {
            onText(text);
          } catch (err) {
            log.warn("[claude] onText handler failed:", err.message);
          }
        }
      } else if (ev.type === "user") {
        const blocks = ev.message?.content;
        if (Array.isArray(blocks)) {
          const done = blocks.filter((b) => b.type === "tool_result").length;
          pendingTools = Math.max(0, pendingTools - done);
        }
      } else if (ev.type === "result") {
        pendingTools = 0; // turn is over; self-heal any counting drift
        result = {
          text: ev.result ?? "",
          isError: Boolean(ev.is_error),
        };
      }
    };

    child.stdout.on("data", (d) => {
      lineBuf += d;
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).trim();
        lineBuf = lineBuf.slice(idx + 1);
        if (line) handleEvent(line);
      }
      // Re-arm AFTER parsing, so the limit reflects the current tool state
      // (a tool_use just seen means we should now allow the longer window).
      armTimer();
    });

    child.stderr.on("data", (d) => {
      armTimer();
      stderr += d;
    });

    const finish = (payload) => {
      clearTimeout(timer);
      activeRuns.delete(sessionKey);
      resolve({ streamed, ...payload });
    };

    child.on("error", (err) => {
      finish({
        ok: false,
        text: `Could not start Claude Code (${err.message}). Is "${bin}" on your PATH?`,
      });
    });

    child.on("close", (code) => {
      if (lineBuf.trim()) handleEvent(lineBuf.trim());

      if (cancelled) {
        return finish({ ok: false, cancelled: true, text: "Run cancelled." });
      }

      if (timedOut) {
        const secs = Math.round(timedOutLimitMs / 1000);
        return finish({
          ok: false,
          text: timedOutInTool
            ? `Claude timed out: a tool ran for over ${secs}s without finishing (raise CLAUDE_TOOL_TIMEOUT_SECONDS).`
            : `Claude timed out after ${secs}s of inactivity (raise CLAUDE_TIMEOUT_SECONDS).`,
        });
      }

      if (result) {
        if (result.isError) {
          return finish({ ok: false, text: result.text || "Claude returned an error." });
        }
        return finish({ ok: true, text: result.text || "(empty response)" });
      }

      // No result event: the CLI failed outright (e.g. stale --resume id).
      // Drop the session so the next try starts fresh.
      if (sessions[sessionKey]) {
        delete sessions[sessionKey];
        saveSessions();
      }
      return finish({
        ok: false,
        text: `Claude exited with code ${code}: ${stderr.trim().slice(0, 500)}`,
      });
    });
  });
}
