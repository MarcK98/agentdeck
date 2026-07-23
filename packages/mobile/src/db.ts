// Local SQLite cache (expo-sqlite) — every list/detail the app fetches over
// the relay is written through here, and screens hydrate from it synchronously
// on mount. Cold start with the relay unreachable shows the last-known data
// (read-only) instead of spinners; reconnect reconciles.
//
// The database is opened lazily on first use, NOT at module import. Doing the
// synchronous open + schema init at top level meant any failure there (e.g. a
// release/Hermes build where the native module resolves differently) threw
// before React could render — an uncatchable black screen. A lazy, guarded
// init can only ever degrade the cache to a no-op; it can never crash startup.

import * as SQLite from "expo-sqlite";

let cachedDb: SQLite.SQLiteDatabase | null = null;
let initFailed = false;

function getDb(): SQLite.SQLiteDatabase | null {
  if (cachedDb) return cachedDb;
  if (initFailed) return null;
  try {
    const db = SQLite.openDatabaseSync("spawn-cache.db");
    db.execSync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        thread_id INTEGER NOT NULL,
        id INTEGER NOT NULL,
        role TEXT,
        text TEXT,
        tool_name TEXT,
        tool_input TEXT,
        created_at TEXT,
        PRIMARY KEY (thread_id, id)
      );
    `);
    cachedDb = db;
    return cachedDb;
  } catch (e) {
    // Never fatal: the app runs without the offline cache, just without
    // last-known data on cold start. Logged so it's diagnosable from the device.
    initFailed = true;
    console.log("[AgentDeck] local cache unavailable:", (e as any)?.message ?? e);
    return null;
  }
}

export function kvGet<T = any>(key: string): T | null {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.getFirstSync<{ value: string }>("SELECT value FROM kv WHERE key = ?", key);
    return row ? (JSON.parse(row.value) as T) : null;
  } catch {
    return null;
  }
}

export function kvSet(key: string, value: unknown) {
  const db = getDb();
  if (!db) return;
  try {
    db.runSync(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      JSON.stringify(value),
      Date.now()
    );
  } catch {
    /* cache write failure is never fatal */
  }
}

const MESSAGE_CAP = 300;

export function messagesGet(threadId: number): any[] {
  const db = getDb();
  if (!db) return [];
  try {
    return db
      .getAllSync<any>(
        "SELECT id, role, text, tool_name, tool_input, created_at FROM messages WHERE thread_id = ? ORDER BY id ASC",
        threadId
      )
      .map((m) => ({ ...m, thread_id: threadId }));
  } catch {
    return [];
  }
}

export function messagesPut(threadId: number, msgs: any[]) {
  const db = getDb();
  if (!db) return;
  try {
    db.withTransactionSync(() => {
      for (const m of msgs) {
        db.runSync(
          "INSERT OR REPLACE INTO messages (thread_id, id, role, text, tool_name, tool_input, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          threadId,
          m.id,
          m.role ?? null,
          m.text ?? null,
          m.tool_name ?? null,
          m.tool_input ?? null,
          m.created_at ?? null
        );
      }
      // Cap history per thread so the cache stays small.
      db.runSync(
        "DELETE FROM messages WHERE thread_id = ? AND id NOT IN (SELECT id FROM messages WHERE thread_id = ? ORDER BY id DESC LIMIT ?)",
        threadId,
        threadId,
        MESSAGE_CAP
      );
    });
  } catch {
    /* ignore */
  }
}

export function messageAppend(threadId: number, m: any) {
  messagesPut(threadId, [m]);
}
