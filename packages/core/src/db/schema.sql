-- Spawn core schema v1 — projects / threads / messages.
-- Applied via PRAGMA user_version migrations in index.js; this file is the
-- v1 baseline. Extend by appending a numbered migration there, not editing this.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,          -- channel-style short name
  dir         TEXT NOT NULL UNIQUE,          -- absolute path on disk
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS threads (
  id            INTEGER PRIMARY KEY,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'chat'  -- chat | ticket | teamlead
                CHECK (kind IN ('chat','ticket','teamlead')),
  title         TEXT NOT NULL,
  ticket_key    TEXT,                         -- Trello card key when kind=ticket
  branch        TEXT,                         -- ticket/<key> when isolated
  worktree_path TEXT,
  status        TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','done','blocked','archived')),
  session_id    TEXT,                         -- claude session id (resume); null = fresh
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id, status);
CREATE INDEX IF NOT EXISTS idx_threads_ticket  ON threads(ticket_key) WHERE ticket_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  text        TEXT NOT NULL DEFAULT '',
  tool_name   TEXT,                           -- role=tool: which tool ran
  tool_input  TEXT,                           -- role=tool: JSON input snapshot
  seq         INTEGER NOT NULL DEFAULT 0,     -- stream order within a turn
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
