import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config, dataPath } from "./config.js";
import { log } from "./logger.js";
import { recordUsage } from "./usage-log.js";

// Which sessions file this process owns. The bridge and the Spawn daemon are
// SEPARATE processes sharing dataDir; whole-file writes would clobber each
// other, so each process gets its own file (daemon sets SPAWN_SESSIONS_FILE).
const SESSIONS_FILE = dataPath(process.env.SPAWN_SESSIONS_FILE || "sessions.json");

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

// Per-channel model override (the `/model` bridge command). In-memory only —
// resets on restart. Empty/undefined clears it back to the configured default.
const modelOverrides = new Map();
export const setModel = (sessionKey, model) => {
  if (model) modelOverrides.set(sessionKey, model);
  else modelOverrides.delete(sessionKey);
};
export const getModel = (sessionKey) =>
  modelOverrides.get(sessionKey) || config.claude.model || "";

// Stats from the most recent completed run per channel (`/status`, `/cost`).
const lastStats = new Map();
export const getLastStats = (sessionKey) => lastStats.get(sessionKey) || null;

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

// Build the `npx chrome-devtools-mcp` argv from browser config. When `url` is
// set we attach to an already-running Chrome (keeps logged-in sessions); the
// channel/headless launch flags only apply when the MCP starts its own Chrome.
function browserMcpArgs() {
  const a = ["-y", "chrome-devtools-mcp@latest"];
  const { url, channel, headless, isolated } = config.browser;
  if (url) {
    a.push("--browserUrl", url);
  } else {
    if (channel) a.push("--channel", channel);
    if (headless) a.push("--headless");
  }
  if (isolated) a.push("--isolated");
  return a;
}

function run(sessionKey, prompt, cwdOverride, onText, opts = {}) {
  const { bin, extraArgs, timeoutMs, toolTimeoutMs } = config.claude;
  // Per-run override: opts.persistSessions=false makes this an ephemeral run
  // (no --resume in, no session id stored) — used for isolated ticket threads.
  const persistSessions = opts.persistSessions ?? config.claude.persistSessions;
  // Model/effort precedence: an explicit per-run opt (heartbeat, delegation)
  // wins over the channel's /model override, which wins over the config default.
  const model = opts.model || modelOverrides.get(sessionKey) || config.claude.model;
  const effort = opts.effort || config.claude.effort;
  const cwd = cwdOverride || config.claude.cwd;
  // Approval routing overrides (the Spawn daemon points prompts at its own
  // hub; the bridge passes none of these, so its behavior is unchanged).
  const approvals = opts.approvals ?? config.approvals.enabled;
  const permissionMode = opts.permissionMode ?? config.claude.permissionMode;
  const approvalPort = opts.approvalPort ?? config.approvals.port;

  // stream-json emits one JSON event per line as Claude works
  // (--verbose is required with -p + stream-json).
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  // Beta headers. A per-run opts.betas (the team lead's Sonnet-1M window) wins
  // over the global default — so the 1M beta rides only on the run that uses it,
  // not on other channels' models that would reject it.
  const betas = opts.betas?.length ? opts.betas : config.claude.betas;
  if (betas.length) args.push("--betas", ...betas);
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  if (persistSessions && sessions[sessionKey]) {
    args.push("--resume", sessions[sessionKey]);
  }

  // Extra allowed directories (e.g. a temp folder holding message attachments),
  // so Claude can read them without a per-file approval prompt.
  for (const dir of opts.addDirs ?? []) {
    args.push("--add-dir", dir);
  }

  // Assemble the MCP servers exposed to this run: the approval server (routes
  // permission prompts to Discord) and, optionally, a browser server so agents
  // get Chrome access without switching to /terminal.
  const mcpServers = {};
  if (approvals) {
    mcpServers.approver = {
      command: process.execPath, // this node binary
      args: [APPROVAL_MCP_PATH],
    };
  }
  if (config.browser.enabled) {
    mcpServers["chrome-devtools"] = {
      command: "npx",
      args: browserMcpArgs(),
    };
  }
  if (Object.keys(mcpServers).length) {
    args.push("--mcp-config", JSON.stringify({ mcpServers }));
  }
  // The permission-prompt tool only exists when the approver server is loaded.
  if (approvals) {
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
        BRIDGE_APPROVAL_PORT: String(approvalPort),
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
        // "user" tool_result event. Track the gap so the timer can be lenient,
        // and surface each tool as live progress (feature C).
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          pendingTools++;
          if (opts.onProgress) {
            try {
              opts.onProgress({ tool: b.name, input: b.input ?? {} });
            } catch (err) {
              log.warn("[claude] onProgress handler failed:", err.message);
            }
          }
        }
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
        const runModel = Object.keys(ev.modelUsage ?? {})[0] || model;
        lastStats.set(sessionKey, {
          costUsd: ev.total_cost_usd,
          usage: ev.usage ?? null,
          model: runModel,
          durationMs: ev.duration_ms,
          numTurns: ev.num_turns,
          sessionId: ev.session_id,
          at: Date.now(),
        });
        // Append to the usage ledger (exact channel/team-lead attribution for
        // the dashboard). opts.meta comes from the adapter that started the run.
        recordUsage({
          sessionKey,
          model: runModel,
          usage: ev.usage ?? null,
          costUsd: ev.total_cost_usd,
          durationMs: ev.duration_ms,
          numTurns: ev.num_turns,
          sessionId: ev.session_id,
          meta: opts.meta || {},
        });
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
        // Always surface the context size so callers can track/warn on it.
        // Optionally auto-reset when it passes the cap (the caller's opts, else
        // the global CLAUDE_MAX_CONTEXT_TOKENS). A cap of 0 = never reset.
        const u = lastStats.get(sessionKey)?.usage || {};
        const contextTokens =
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0);
        let contextReset = false;
        const cap = opts.maxContextTokens ?? config.claude.maxContextTokens;
        if (cap && persistSessions && sessions[sessionKey] && contextTokens > cap) {
          delete sessions[sessionKey];
          saveSessions();
          contextReset = true;
          log.info(`[claude] auto-reset ${sessionKey} — context ${contextTokens} > ${cap} tokens`);
        }
        if (result.isError) {
          return finish({ ok: false, contextReset, contextTokens, text: result.text || "Claude returned an error." });
        }
        return finish({ ok: true, contextReset, contextTokens, text: result.text || "(empty response)" });
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
