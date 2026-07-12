import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";

// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<project-slug>/<session-uuid>.jsonl. Every assistant turn
// carries message.usage (input/output/cache tokens) + message.model + a
// timestamp. Summed across ALL projects, this is the true total of everything
// the account ran — the correct denominator for "am I within my plan limit",
// covering terminal Claude Code sessions and other repos, not just the bridge.
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// Strip the common local prefix so project names read cleanly in the UI.
// "-Users-mkhoury-Documents-projects-claude-spawn" -> "claude-spawn"
function prettyProject(slug) {
  const cleaned = slug.replace(/^-+/, "");
  const m = cleaned.match(/projects-(.+)$/);
  if (m) return m[1];
  const parts = cleaned.split("-");
  return parts[parts.length - 1] || slug;
}

// Per-file parse cache keyed by path, invalidated on mtime change, so repeated
// dashboard requests only re-read files that actually grew.
const cache = new Map(); // path -> { mtimeMs, records }

function parseFile(path, projectSlug) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const project = prettyProject(projectSlug);
  const records = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    const msg = ev.message;
    const u = msg?.usage;
    if (!u) continue; // only assistant turns carry usage
    // Skip synthetic/no-op usage lines (all-zero).
    const any =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    if (!any) continue;
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : NaN;
    records.push({
      ts: Number.isNaN(ts) ? null : ts,
      model: msg.model || "unknown",
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_input_tokens: u.cache_read_input_tokens || 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      project,
      projectSlug,
      sessionId: ev.sessionId || null,
    });
  }
  return records;
}

// Return all backfill records with ts >= sinceTs (ms epoch, 0 = everything).
// mtime filter skips whole files that couldn't contain in-window data.
export function readBackfill({ sinceTs = 0 } = {}) {
  let slugs;
  try {
    slugs = readdirSync(PROJECTS_DIR);
  } catch (err) {
    log.warn("[usage] no Claude Code logs to backfill:", err.message);
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    const dir = join(PROJECTS_DIR, slug);
    let files;
    try {
      if (!statSync(dir).isDirectory()) continue;
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      let mtimeMs;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      // A file last modified before the window can't hold in-window records.
      if (sinceTs && mtimeMs < sinceTs) {
        cache.delete(path);
        continue;
      }
      let entry = cache.get(path);
      if (!entry || entry.mtimeMs !== mtimeMs) {
        entry = { mtimeMs, records: parseFile(path, slug) };
        cache.set(path, entry);
      }
      for (const r of entry.records) {
        if (r.ts == null || r.ts >= sinceTs) out.push(r);
      }
    }
  }
  return out;
}
