import { spawn } from "@lydell/node-pty";
import xterm from "@xterm/headless";
import { config } from "./config.js";
import { log } from "./logger.js";

const { Terminal } = xterm;

// One live interactive Claude Code session (in a PTY) per channel. Its screen
// is emulated by @xterm/headless so we can snapshot it as clean text and post
// that to Discord; Discord input is written back as keystrokes.
const sessions = new Map(); // sessionKey -> session

// Escape sequences for the control buttons.
const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  esc: "\x1b",
  tab: "\t",
  ctrlc: "\x03",
  backspace: "\x7f",
  space: " ",
};

export const hasTerminal = (key) => sessions.has(key);

// Snapshot the emulated screen as trimmed text (trailing blank lines removed).
function renderScreen(term) {
  const buf = term.buffer.active;
  const start = Math.max(0, buf.length - term.rows);
  const out = [];
  for (let y = start; y < buf.length; y++) {
    const line = buf.getLine(y);
    out.push(line ? line.translateToString(true) : "");
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  while (out.length && out[0].trim() === "") out.shift();
  return out.join("\n");
}

/**
 * Open an interactive Claude session in a PTY for `key`.
 * onRender(text) fires (debounced) whenever the screen changes; onExit(reason)
 * fires once when the session ends. No-op if one is already open.
 */
export function openTerminal(key, { cwd, onRender, onExit } = {}) {
  if (sessions.has(key)) return sessions.get(key);

  const { cols, rows, idleMs } = config.terminal;
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  const pty = spawn(config.claude.bin, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: cwd || config.claude.cwd,
    env: { ...process.env },
  });

  const s = {
    pty,
    term,
    onExit,
    renderTimer: null,
    lastRenderAt: 0,
    idleTimer: null,
    closed: false,
  };
  sessions.set(key, s);

  const doRender = () => {
    clearTimeout(s.renderTimer);
    s.renderTimer = null;
    s.lastRenderAt = Date.now();
    try {
      onRender?.(renderScreen(term));
    } catch (err) {
      log.warn("[terminal] render handler failed:", err.message);
    }
  };
  // Render shortly after output settles, but at least ~once/second during a
  // continuous stream so long-running output still updates.
  const scheduleRender = () => {
    if (Date.now() - s.lastRenderAt > 900) return doRender();
    if (!s.renderTimer) s.renderTimer = setTimeout(doRender, 350);
  };

  const bumpIdle = () => {
    clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => closeTerminal(key, "idle timeout"), idleMs);
  };
  s.bumpIdle = bumpIdle;

  pty.onData((d) => {
    term.write(d);
    scheduleRender();
    bumpIdle();
  });
  pty.onExit(({ exitCode }) => {
    if (s.closed) return; // closeTerminal already handled teardown
    s.closed = true;
    clearTimeout(s.renderTimer);
    clearTimeout(s.idleTimer);
    sessions.delete(key);
    try {
      onExit?.(`session ended (exit ${exitCode})`);
    } catch {
      /* ignore */
    }
  });

  bumpIdle();
  return s;
}

// Write raw text (a typed message becomes a line; keys are raw sequences).
export function writeText(key, text) {
  const s = sessions.get(key);
  if (!s) return false;
  s.pty.write(text);
  s.bumpIdle?.();
  return true;
}

export const writeLine = (key, text) => writeText(key, text + "\r");

export function writeKey(key, name) {
  const seq = KEYS[name];
  if (seq == null) return false;
  return writeText(key, seq);
}

export function closeTerminal(key, reason) {
  const s = sessions.get(key);
  if (!s) return false;
  sessions.delete(key);
  if (s.closed) return true;
  s.closed = true;
  clearTimeout(s.renderTimer);
  clearTimeout(s.idleTimer);
  try {
    s.pty.kill();
  } catch {
    /* already gone */
  }
  try {
    s.onExit?.(reason);
  } catch {
    /* ignore */
  }
  return true;
}

export function closeAllTerminals() {
  for (const key of [...sessions.keys()]) closeTerminal(key, "shutting down");
}
