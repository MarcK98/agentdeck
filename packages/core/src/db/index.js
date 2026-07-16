import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dataPath } from "../config.js";

// SQLite store for Spawn threads/messages (better-sqlite3: synchronous, WAL,
// fastest embedded option and trivially scalable to this workload).
//
// ABI NOTE: better-sqlite3 is a native module compiled per runtime. The
// desktop app (Electron main) and plain Node have different ABIs — whichever
// consumer runs `electron-rebuild` owns the compiled artifact. The Discord
// bridge must NEVER import this module (it doesn't: bridge code predates it),
// so the bridge keeps running regardless of which ABI is on disk. Keep it
// that way until the hard-cut.
//
// Loaded lazily so importing @spawn/core for bridge purposes never touches
// the native module.

const require = createRequire(import.meta.url);
const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

// Append-only migrations. schema.sql is v1; add ["...sql..."] entries for v2+.
const MIGRATIONS = [
  readFileSync(SCHEMA_PATH, "utf8"),
  // v2: persisted per-project settings (JSON blob). Client-visible settings
  // ONLY — secrets never live in this table (see daemon/project-settings.js).
  `CREATE TABLE IF NOT EXISTS project_settings (
     project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
     data       TEXT NOT NULL DEFAULT '{}'
   );`,
];

let db = null;

export function openDb(file = dataPath("spawn.db")) {
  if (db) return db;
  const Database = require("better-sqlite3");
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const version = db.pragma("user_version", { simple: true });
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
  }
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

// ── Projects ─────────────────────────────────────────────────────────────────
export const upsertProject = (name, dir) => {
  const d = openDb();
  d.prepare(
    `INSERT INTO projects (name, dir) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET dir = excluded.dir`
  ).run(name, dir);
  return d.prepare(`SELECT * FROM projects WHERE name = ?`).get(name);
};
export const listProjects = () =>
  openDb().prepare(`SELECT * FROM projects ORDER BY name`).all();

// ── Threads ──────────────────────────────────────────────────────────────────
export const createThread = ({ projectId, kind = "chat", title, ticketKey = null }) => {
  const d = openDb();
  const { lastInsertRowid } = d
    .prepare(
      `INSERT INTO threads (project_id, kind, title, ticket_key) VALUES (?, ?, ?, ?)`
    )
    .run(projectId, kind, title, ticketKey);
  return d.prepare(`SELECT * FROM threads WHERE id = ?`).get(lastInsertRowid);
};
export const getThread = (id) =>
  openDb().prepare(`SELECT * FROM threads WHERE id = ?`).get(id);
export const listThreads = (projectId) =>
  openDb()
    .prepare(`SELECT * FROM threads WHERE project_id = ? ORDER BY updated_at DESC`)
    .all(projectId);
export const updateThread = (id, fields) => {
  const allowed = ["title", "status", "session_id", "branch", "worktree_path"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getThread(id);
  const d = openDb();
  d.prepare(
    `UPDATE threads SET ${sets.map((k) => `${k} = ?`).join(", ")},
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(...sets.map((k) => fields[k]), id);
  return getThread(id);
};

// ── Messages ─────────────────────────────────────────────────────────────────
// Returns the full inserted row (not the rowid) so the daemon can ship it in a
// stream event without a second query.
export const addMessage = ({ threadId, role, text = "", toolName = null, toolInput = null, seq = 0 }) => {
  const d = openDb();
  const { lastInsertRowid } = d
    .prepare(
      `INSERT INTO messages (thread_id, role, text, tool_name, tool_input, seq)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(threadId, role, text, toolName, toolInput && JSON.stringify(toolInput), seq);
  d.prepare(
    `UPDATE threads SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
  ).run(threadId);
  return getMessage(lastInsertRowid);
};
export const getMessage = (id) =>
  openDb().prepare(`SELECT * FROM messages WHERE id = ?`).get(id);
export const listMessages = (threadId, { limit = 200, before = null } = {}) => {
  const d = openDb();
  const rows = before
    ? d.prepare(`SELECT * FROM messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?`).all(threadId, before, limit)
    : d.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?`).all(threadId, limit);
  return rows.reverse();
};

// ── Project settings ─────────────────────────────────────────────────────────
// One JSON blob per project (v2 migration). Secrets NEVER go here — they stay
// in the daemon's in-memory map (project-settings.js) by construction.
export const getProjectSettingsRow = (projectId) => {
  const row = openDb()
    .prepare(`SELECT data FROM project_settings WHERE project_id = ?`)
    .get(projectId);
  try {
    return row ? JSON.parse(row.data) : {};
  } catch {
    return {}; // corrupted blob — fall back to defaults rather than crash
  }
};
export const upsertProjectSettings = (projectId, obj) => {
  openDb()
    .prepare(
      `INSERT INTO project_settings (project_id, data) VALUES (?, ?)
       ON CONFLICT(project_id) DO UPDATE SET data = excluded.data`
    )
    .run(projectId, JSON.stringify(obj ?? {}));
  return getProjectSettingsRow(projectId);
};
