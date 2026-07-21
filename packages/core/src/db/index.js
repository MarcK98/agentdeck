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
  // v3: native tickets — the Orchestrate board's source of truth (replaces
  // Trello/TASKS.md board sources in the daemon). A ticket may exist without
  // a thread (backlog); delegation links one.
  `CREATE TABLE IF NOT EXISTS tickets (
     id         INTEGER PRIMARY KEY,
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     thread_id  INTEGER REFERENCES threads(id) ON DELETE SET NULL,
     title      TEXT NOT NULL,
     body       TEXT NOT NULL DEFAULT '',
     status     TEXT NOT NULL DEFAULT 'todo'
                CHECK (status IN ('todo','in-progress','blocked','in-review','done')),
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX IF NOT EXISTS idx_tickets_project ON tickets(project_id, status);
   CREATE INDEX IF NOT EXISTS idx_tickets_thread  ON tickets(thread_id) WHERE thread_id IS NOT NULL;`,
  // v4: per-project MCP secrets — the tokens users paste on the settings page.
  // ciphertext ONLY (AES-256-GCM, see secrets.js); the key lives in a keyfile,
  // never in this table. secret_key format: "mcp:<serverName>:<ENV_KEY>".
  // getProjectSettings never returns these values — only which keys are set.
  `CREATE TABLE IF NOT EXISTS project_secrets (
     project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     secret_key TEXT NOT NULL,
     ciphertext TEXT NOT NULL,
     PRIMARY KEY (project_id, secret_key)
   );`,
  // v5: ticket comments + attachments. Comments drive the team-lead loop
  // (a human comment wakes the lead, which delegates and comments back);
  // author_kind distinguishes who wrote it. Attachments are files copied
  // into <dataDir>/ticket-files/<ticketId>/, uploadable by human/lead/agents.
  `CREATE TABLE IF NOT EXISTS ticket_comments (
     id          INTEGER PRIMARY KEY,
     ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     author_kind TEXT NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human','lead','agent')),
     author_name TEXT NOT NULL DEFAULT '',
     body        TEXT NOT NULL,
     created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX IF NOT EXISTS idx_ticket_comments ON ticket_comments(ticket_id, id);
   CREATE TABLE IF NOT EXISTS ticket_attachments (
     id          INTEGER PRIMARY KEY,
     ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     path        TEXT NOT NULL,
     size        INTEGER NOT NULL DEFAULT 0,
     uploaded_by TEXT NOT NULL DEFAULT '',
     created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE INDEX IF NOT EXISTS idx_ticket_attachments ON ticket_attachments(ticket_id, id);`,
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
  // Both name and dir are UNIQUE — handle a hit on either (a renamed dir, or
  // a second name for an already-known dir) instead of throwing, so one odd
  // mapping can never wedge project discovery.
  d.prepare(
    `INSERT INTO projects (name, dir) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET dir = excluded.dir
     ON CONFLICT(dir) DO NOTHING`
  ).run(name, dir);
  return d.prepare(`SELECT * FROM projects WHERE dir = ?`).get(dir);
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
// Active threads across ALL projects (the team-lead workspace's live list),
// each carrying its project name so the client needs no second lookup.
export const listActiveThreads = () =>
  openDb()
    .prepare(
      `SELECT t.*, p.name AS project_name FROM threads t
       JOIN projects p ON p.id = t.project_id
       WHERE t.status = 'active' ORDER BY t.updated_at DESC LIMIT 100`
    )
    .all();
// Every thread across ALL projects (the global Threads view), each carrying
// its project name so the client needs no second lookup. Newest first, all
// statuses — same rows the per-project listThreads returns, just unscoped.
export const listAllThreads = () =>
  openDb()
    .prepare(
      `SELECT t.*, p.name AS project_name FROM threads t
       JOIN projects p ON p.id = t.project_id
       ORDER BY t.updated_at DESC`
    )
    .all();
// Hard-delete a thread. Messages cascade (ON DELETE CASCADE); any ticket that
// pointed here has its thread_id nulled (ON DELETE SET NULL) so the ticket row
// survives as backlog. The worktree checkout (if any) is reclaimed by the
// daemon before this runs — this only drops the rows.
export const deleteThread = (id) => {
  openDb().prepare(`DELETE FROM threads WHERE id = ?`).run(id);
  return true;
};
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
export const listMessages = (threadId, opts) => {
  // `opts ?? {}` (not a `= {}` param default) — the desktop's RPC layer
  // JSON-stringifies args, which turns an omitted `undefined` opts into
  // `null`, and destructuring `null` throws. This tolerates both.
  const { limit = 200, before = null } = opts ?? {};
  const d = openDb();
  const rows = before
    ? d.prepare(`SELECT * FROM messages WHERE thread_id = ? AND id < ? ORDER BY id DESC LIMIT ?`).all(threadId, before, limit)
    : d.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?`).all(threadId, limit);
  return rows.reverse();
};

// ── Tickets ──────────────────────────────────────────────────────────────────
// The board's rows. listTickets joins the project name and, when delegated,
// the thread's branch/status so cards render without extra lookups.
export const createTicket = ({ projectId, title, body = "", status = "todo" }) => {
  const d = openDb();
  const { lastInsertRowid } = d
    .prepare(`INSERT INTO tickets (project_id, title, body, status) VALUES (?, ?, ?, ?)`)
    .run(projectId, title, body, status);
  return getTicket(lastInsertRowid);
};
export const getTicket = (id) =>
  openDb()
    .prepare(
      `SELECT k.*, p.name AS project_name, t.branch, t.status AS thread_status
       FROM tickets k JOIN projects p ON p.id = k.project_id
       LEFT JOIN threads t ON t.id = k.thread_id WHERE k.id = ?`
    )
    .get(id);
export const getTicketByThread = (threadId) =>
  openDb().prepare(`SELECT * FROM tickets WHERE thread_id = ?`).get(threadId);
export const listTickets = () =>
  openDb()
    .prepare(
      `SELECT k.*, p.name AS project_name, t.branch, t.status AS thread_status
       FROM tickets k JOIN projects p ON p.id = k.project_id
       LEFT JOIN threads t ON t.id = k.thread_id
       ORDER BY k.updated_at DESC LIMIT 500`
    )
    .all();
export const updateTicket = (id, fields) => {
  const allowed = ["title", "body", "status", "thread_id"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return getTicket(id);
  openDb()
    .prepare(
      `UPDATE tickets SET ${sets.map((k) => `${k} = ?`).join(", ")},
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    )
    .run(...sets.map((k) => fields[k]), id);
  return getTicket(id);
};
// Archive-inclusive search (the team lead's board tool): LIKE over
// title+body, optional status/project filters, done tickets included.
export const searchTickets = (opts) => {
  const { query = "", status = null, projectId = null, limit = 20 } = opts ?? {};
  const d = openDb();
  const clauses = [];
  const args = [];
  if (query) {
    clauses.push("(k.title LIKE ? OR k.body LIKE ?)");
    args.push(`%${query}%`, `%${query}%`);
  }
  if (status) {
    clauses.push("k.status = ?");
    args.push(status);
  }
  if (projectId != null) {
    clauses.push("k.project_id = ?");
    args.push(projectId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return d
    .prepare(
      `SELECT k.*, p.name AS project_name FROM tickets k
       JOIN projects p ON p.id = k.project_id ${where}
       ORDER BY k.updated_at DESC LIMIT ?`
    )
    .all(...args, Math.min(Number(limit) || 20, 50));
};

export const deleteTicket = (id) => {
  openDb().prepare(`DELETE FROM tickets WHERE id = ?`).run(id);
  return true;
};

// ── Ticket comments + attachments (v5) ─────────────────────────────────────────
const touchTicket = (d, ticketId) =>
  d.prepare(`UPDATE tickets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(ticketId);

export const addTicketComment = ({ ticketId, authorKind = "human", authorName = "", body }) => {
  const d = openDb();
  const { lastInsertRowid } = d
    .prepare(`INSERT INTO ticket_comments (ticket_id, author_kind, author_name, body) VALUES (?, ?, ?, ?)`)
    .run(ticketId, authorKind, authorName, String(body));
  touchTicket(d, ticketId);
  return d.prepare(`SELECT * FROM ticket_comments WHERE id = ?`).get(lastInsertRowid);
};
export const listTicketComments = (ticketId) =>
  openDb().prepare(`SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY id`).all(ticketId);

export const addTicketAttachment = ({ ticketId, name, path, size = 0, uploadedBy = "" }) => {
  const d = openDb();
  const { lastInsertRowid } = d
    .prepare(`INSERT INTO ticket_attachments (ticket_id, name, path, size, uploaded_by) VALUES (?, ?, ?, ?, ?)`)
    .run(ticketId, name, path, size, uploadedBy);
  touchTicket(d, ticketId);
  return d.prepare(`SELECT * FROM ticket_attachments WHERE id = ?`).get(lastInsertRowid);
};
export const listTicketAttachments = (ticketId) =>
  openDb().prepare(`SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY id`).all(ticketId);

// ── Project settings ─────────────────────────────────────────────────────────
// One JSON blob per project (v2 migration). Secret VALUES NEVER go here — they
// live encrypted in project_secrets (v4, below); this blob is client-safe.
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

// ── Project secrets (v4) ───────────────────────────────────────────────────────
// Ciphertext store (encrypt/decrypt happen in daemon/project-settings.js via
// secrets.js). This layer never sees plaintext — it just persists opaque blobs
// keyed by (project_id, secret_key). Values are NEVER returned to any client.
export const setSecret = (projectId, secretKey, ciphertext) => {
  openDb()
    .prepare(
      `INSERT INTO project_secrets (project_id, secret_key, ciphertext) VALUES (?, ?, ?)
       ON CONFLICT(project_id, secret_key) DO UPDATE SET ciphertext = excluded.ciphertext`
    )
    .run(projectId, secretKey, ciphertext);
  return true;
};
export const getSecret = (projectId, secretKey) =>
  openDb()
    .prepare(`SELECT ciphertext FROM project_secrets WHERE project_id = ? AND secret_key = ?`)
    .get(projectId, secretKey)?.ciphertext ?? null;
// Keys present for a project, optionally filtered by prefix (e.g. "mcp:foo:").
export const listSecretKeys = (projectId, prefix = "") =>
  openDb()
    .prepare(
      `SELECT secret_key FROM project_secrets WHERE project_id = ?
         AND secret_key LIKE ? ESCAPE '\\' ORDER BY secret_key`
    )
    .all(projectId, `${prefix.replace(/[\\%_]/g, "\\$&")}%`)
    .map((r) => r.secret_key);
export const deleteSecret = (projectId, secretKey) => {
  openDb()
    .prepare(`DELETE FROM project_secrets WHERE project_id = ? AND secret_key = ?`)
    .run(projectId, secretKey);
  return true;
};
export const deleteSecretsByPrefix = (projectId, prefix) => {
  openDb()
    .prepare(
      `DELETE FROM project_secrets WHERE project_id = ? AND secret_key LIKE ? ESCAPE '\\'`
    )
    .run(projectId, `${prefix.replace(/[\\%_]/g, "\\$&")}%`);
  return true;
};
