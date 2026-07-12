import { appendFileSync, readFileSync } from "node:fs";
import { log } from "./logger.js";

// Append-only usage ledger for bridge-driven runs. One JSON object per line.
// This is the ONLY source with exact channel / team-lead attribution — the
// Claude Code JSONL logs know the model + tokens but not which Discord channel
// or team-lead triggered the run. Gitignored; safe to delete to reset history.
const USAGE_FILE = new URL("../usage.jsonl", import.meta.url);

// Record one completed run. Called from claude.js on the CLI "result" event.
// `meta` carries adapter-supplied attribution: { channelName, source }.
export function recordUsage({
  sessionKey,
  model,
  usage,
  costUsd,
  durationMs,
  numTurns,
  sessionId,
  meta = {},
}) {
  try {
    const u = usage || {};
    const channelId = String(sessionKey || "").split(":")[1] || null;
    const rec = {
      at: new Date().toISOString(),
      ts: Date.now(),
      sessionKey: sessionKey || null,
      channelId,
      channelName: meta.channelName || null,
      // "chat" | "teamlead-tick" | "teamlead-delegate" | …
      source: meta.source || "chat",
      model: model || null,
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      cost_usd: typeof costUsd === "number" ? costUsd : null,
      duration_ms: durationMs ?? null,
      num_turns: numTurns ?? null,
      session_id: sessionId || null,
    };
    appendFileSync(USAGE_FILE, JSON.stringify(rec) + "\n");
  } catch (err) {
    // Never let usage logging break a run.
    log.warn("[usage] could not record run:", err.message);
  }
}

// Read the full ledger back as an array of records (dashboard side).
export function readUsageEvents() {
  let text;
  try {
    text = readFileSync(USAGE_FILE, "utf8");
  } catch {
    return []; // no runs recorded yet
  }
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* skip a partially-written trailing line */
    }
  }
  return out;
}
