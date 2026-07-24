import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve as resolvePath, sep } from "node:path";
import { tmpdir } from "node:os";
import { config, dataPath } from "./config.js";
import { log } from "./logger.js";

// Two-way sync between the team lead's TASKS.md and a Trello board.
//
//   TASKS.md -> Trello : the team lead calls the `trello_sync` MCP tool each
//     tick with its current tasks; syncTasks() upserts one card per task and
//     files it in the list that matches its status. The LLM does the fuzzy
//     "read my prose task board" parse it's good at; this module does the
//     deterministic Trello API calls.
//
//   Trello -> team lead : a poll loop (and optional webhook) watches the board
//     for changes the OWNER makes — moving a card, adding one, commenting — and
//     surfaces them so the team lead reconciles TASKS.md. To avoid reacting to
//     our OWN writes (the API token is the owner's, so their moves and ours look
//     the same), we remember the list we last filed each card in (`expected`)
//     and only report divergences from that.

const T = config.trello;
const API = "https://api.trello.com/1";
const auth = () => `key=${encodeURIComponent(T.key)}&token=${encodeURIComponent(T.token)}`;

// A stable per-task marker hidden at the end of a card's description, so we can
// match a card back to its TASKS.md task across renames.
const MARKER = /\[\[tl:([^\]]+)\]\]/;
const withMarker = (body, key) =>
  key ? `${(body || "").trim()}\n\n[[tl:${key}]]` : (body || "").trim();
const stripMarker = (desc) => String(desc || "").replace(MARKER, "").trim();
const keyOf = (desc) => (String(desc || "").match(MARKER) || [])[1] || null;
// Normalize a card title for adoption matching (trim, collapse whitespace,
// case-insensitive) so a task adopts the owner's hand-made card despite minor casing.
const normTitle = (s) => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();

// Registered by the Discord adapter: notify() posts a human-readable line to the
// team-lead channel; nudge() wakes the team lead to act on a change right away.
let hooks = null;
export const registerTrello = (h) => (hooks = h);

// Board is "enabled" once the env flag + credentials are present. Whether the
// board/lists have actually been resolved is tracked separately (see ensureReady).
const enabledBasic = () => Boolean(T.enabled && T.key && T.token && T.boardId);
export const isEnabled = () => enabledBasic();

// ── Trello REST helper — never throws; resolves { ok, data } | { ok:false, error }
async function api(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API}${path}${sep}${auth()}`;
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) return { ok: false, error: `${res.status} ${data?.message || text}` };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Board / list resolution ──────────────────────────────────────────────────
let resolved = false;
let boardId = ""; // canonical (long) id — needed to create lists/webhooks
let boardName = "";
const listIdByStatus = new Map(); // "in-progress" -> listId
const statusByListId = new Map(); // listId -> "in-progress"
const nameByListId = new Map(); // listId -> "In Progress"

async function resolveBoard() {
  const b = await api("GET", `/boards/${T.boardId}?fields=id,name`);
  if (!b.ok) throw new Error(`board ${T.boardId}: ${b.error}`);
  boardId = b.data.id;
  boardName = b.data.name;

  const l = await api("GET", `/boards/${boardId}/lists?fields=name`);
  if (!l.ok) throw new Error(`lists: ${l.error}`);
  const byName = new Map(l.data.map((x) => [x.name.trim().toLowerCase(), x]));

  for (const [status, name] of Object.entries(T.lists)) {
    let list = byName.get(name.trim().toLowerCase());
    if (!list) {
      // Configured list is missing on the board — create it so sync never
      // silently drops a status.
      const c = await api("POST", "/lists", { name, idBoard: boardId, pos: "bottom" });
      if (!c.ok) {
        log.warn(`[trello] could not create list "${name}": ${c.error}`);
        continue;
      }
      list = c.data;
      log.info(`[trello] created missing list "${name}"`);
    }
    listIdByStatus.set(status, list.id);
    statusByListId.set(list.id, status);
    nameByListId.set(list.id, list.name);
  }
  resolved = true;
  log.info(`[trello] board "${boardName}" ready (${listIdByStatus.size} lists mapped)`);
  return true;
}

let readyPromise = null;
function ensureReady() {
  if (!enabledBasic()) return Promise.resolve(false);
  if (!readyPromise) {
    readyPromise = resolveBoard().catch((err) => {
      readyPromise = null; // let a later call retry
      log.warn(`[trello] not ready: ${err.message}`);
      return false;
    });
  }
  return readyPromise;
}

// ── TASKS.md -> Trello (push) ────────────────────────────────────────────────
// State shared with the poll loop so it can tell our writes from the owner's.
const expected = new Map(); // cardId -> listId we last filed it in
const known = new Set(); // every card id we've seen on the board
const ourComments = new Set(); // ids of comment actions WE posted (skip in poll)

// tasks: [{ key, title, status, body?, url? }]. archiveMissing archives managed
// cards whose key no longer appears in `tasks` (default off — safe).
export async function syncTasks({ tasks = [], archiveMissing = false } = {}) {
  if (!enabledBasic()) return { ok: false, error: "Trello is off (TRELLO_ENABLED)." };
  if (!(await ensureReady())) return { ok: false, error: "Trello board not reachable." };
  if (!Array.isArray(tasks)) return { ok: false, error: "tasks must be an array." };

  const cards = await api(
    "GET",
    `/boards/${boardId}/cards?fields=name,idList,desc,shortUrl`
  );
  if (!cards.ok) return { ok: false, error: `list cards: ${cards.error}` };

  const managed = new Map(); // key -> card (cards we created, by marker)
  // Cards the owner made by hand (no marker) indexed by normalized title, so a task
  // can ADOPT the matching one instead of minting a duplicate. Consumed as we go
  // so two tasks never claim the same card.
  const untrackedByTitle = new Map();
  for (const c of cards.data) {
    known.add(c.id);
    expected.set(c.id, c.idList);
    const k = keyOf(c.desc);
    if (k) {
      managed.set(k, c);
    } else {
      const n = normTitle(c.name);
      if (n && !untrackedByTitle.has(n)) untrackedByTitle.set(n, c);
    }
  }

  const out = { created: 0, updated: 0, moved: 0, adopted: 0, archived: 0, cards: [] };
  const seen = new Set();

  for (const t of tasks) {
    if (!t || !t.key || !t.title) continue;
    const status = String(t.status || "todo").toLowerCase();
    const idList = listIdByStatus.get(status) || listIdByStatus.get("todo");
    if (!idList) continue;
    seen.add(t.key);
    const desc = withMarker(t.body, t.key);
    const existing = managed.get(t.key);

    if (existing) {
      const patch = {};
      if (existing.idList !== idList) patch.idList = idList;
      if (existing.name !== t.title) patch.name = t.title;
      if (stripMarker(existing.desc) !== (t.body || "").trim()) patch.desc = desc;
      if (Object.keys(patch).length) {
        const r = await api("PUT", `/cards/${existing.id}`, patch);
        if (!r.ok) {
          log.warn(`[trello] update "${t.title}": ${r.error}`);
          continue;
        }
        if (patch.idList) out.moved++;
        else out.updated++;
        expected.set(existing.id, idList);
      }
      out.cards.push({ key: t.key, title: t.title, status, url: existing.shortUrl });
      continue;
    }

    // No marker match. Before minting a new card, adopt the untracked card the
    // owner made with the same title: stamp our marker so we work with THEIR card,
    // not a duplicate. Keep their description when the task carries no body of its own.
    const adopt = untrackedByTitle.get(normTitle(t.title));
    if (adopt) {
      untrackedByTitle.delete(normTitle(t.title));
      const keepBody = t.body && t.body.trim() ? t.body : stripMarker(adopt.desc);
      const patch = { desc: withMarker(keepBody, t.key) };
      if (adopt.idList !== idList) patch.idList = idList;
      const r = await api("PUT", `/cards/${adopt.id}`, patch);
      if (!r.ok) {
        log.warn(`[trello] adopt "${t.title}": ${r.error}`);
        continue;
      }
      out.adopted++;
      managed.set(t.key, adopt); // now ours — protected from archive_missing this run
      known.add(adopt.id);
      expected.set(adopt.id, idList);
      out.cards.push({ key: t.key, title: t.title, status, url: adopt.shortUrl });
      continue;
    }

    const r = await api("POST", "/cards", { idList, name: t.title, desc, pos: "bottom" });
    if (!r.ok) {
      log.warn(`[trello] create "${t.title}": ${r.error}`);
      continue;
    }
    out.created++;
    known.add(r.data.id);
    expected.set(r.data.id, idList);
    out.cards.push({ key: t.key, title: t.title, status, url: r.data.shortUrl });
  }

  if (archiveMissing) {
    for (const [k, c] of managed) {
      if (seen.has(k)) continue;
      const r = await api("PUT", `/cards/${c.id}`, { closed: true });
      if (r.ok) out.archived++;
    }
  }

  saveState(); // remember where WE filed each card, so the poll doesn't later
  // mistake our own writes for the owner moving them (esp. across a restart).
  out.ok = true;
  return out;
}

// Resolve a card from a board-cards list by its stable marker key (cards the
// team lead created) OR a cardRef — a card id, shortLink, or trello.com/c/... URL
// — which additionally reaches UNTRACKED cards the owner made by hand (no marker).
// Returns { card } or { error }.
function resolveCard(cards, { cardKey, cardRef }) {
  if (cardKey) {
    const card = cards.find((c) => keyOf(c.desc) === cardKey);
    return card ? { card } : { error: `no card with key "${cardKey}".` };
  }
  const ref = String(cardRef).trim();
  const link = (ref.match(/\/c\/([^/]+)/) || [])[1] || ref; // shortLink out of a URL
  const card = cards.find(
    (c) => c.id === ref || c.shortLink === ref || c.shortLink === link
  );
  return card ? { card } : { error: `no card matching ref "${cardRef}".` };
}

// On-demand WRITE — one targeted change (reply/comment, move, update, create,
// archive) by card key, so the team lead can act immediately instead of waiting
// for the next full trello_sync. Comments WE post are recorded so the poll won't
// echo them back as if the owner wrote them.
export async function writeCard({ cardKey, cardRef, action, text, status, title, body } = {}) {
  if (!enabledBasic()) return { ok: false, error: "Trello is off (TRELLO_ENABLED)." };
  if (!(await ensureReady())) return { ok: false, error: "Trello board not reachable." };
  const act = String(action || "").toLowerCase();

  // Resolve the card (everything except create needs one).
  let card = null;
  if (act !== "create") {
    if (!cardKey && !cardRef)
      return { ok: false, error: "card_key or card_ref is required." };
    const cardsRes = await api(
      "GET",
      `/boards/${boardId}/cards?fields=name,idList,desc,shortUrl,shortLink`
    );
    if (!cardsRes.ok) return { ok: false, error: `list cards: ${cardsRes.error}` };
    const r = resolveCard(cardsRes.data, { cardKey, cardRef });
    if (r.error) return { ok: false, error: r.error };
    card = r.card;
  }

  if (act === "comment") {
    if (!text) return { ok: false, error: "comment needs `text`." };
    const r = await api(
      "POST",
      `/cards/${card.id}/actions/comments?text=${encodeURIComponent(text)}`
    );
    if (!r.ok) return { ok: false, error: r.error };
    ourComments.add(r.data.id); // don't let our own comment loop back via the poll
    if (r.data.date) lastActionDate = r.data.date; // advance the cursor past it
    saveState();
    return { ok: true, action: "comment", card: card.name, url: card.shortUrl };
  }
  if (act === "move") {
    const idList = listIdByStatus.get(String(status || "").toLowerCase());
    if (!idList) return { ok: false, error: `unknown status "${status}".` };
    const r = await api("PUT", `/cards/${card.id}`, { idList });
    if (!r.ok) return { ok: false, error: r.error };
    expected.set(card.id, idList); // our write, not the owner's — record it
    saveState();
    return { ok: true, action: "move", card: card.name, status, url: card.shortUrl };
  }
  if (act === "update") {
    const patch = {};
    if (title) patch.name = title;
    // Re-stamp only with the card's OWN key. An untracked card (resolved by
    // cardRef, no cardKey) stays untracked — never adopt it with a marker, or
    // a later archive_missing resync would silently archive it.
    if (body != null) patch.desc = withMarker(body, cardKey || keyOf(card.desc));
    if (!Object.keys(patch).length)
      return { ok: false, error: "update needs `title` and/or `body`." };
    const r = await api("PUT", `/cards/${card.id}`, patch);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, action: "update", card: title || card.name, url: card.shortUrl };
  }
  if (act === "archive") {
    const r = await api("PUT", `/cards/${card.id}`, { closed: true });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, action: "archive", card: card.name };
  }
  if (act === "create") {
    if (!cardKey || !title) return { ok: false, error: "create needs `card_key` + `title`." };
    const idList =
      listIdByStatus.get(String(status || "todo").toLowerCase()) || listIdByStatus.get("todo");
    const r = await api("POST", "/cards", {
      idList,
      name: title,
      desc: withMarker(body, cardKey),
      pos: "bottom",
    });
    if (!r.ok) return { ok: false, error: r.error };
    known.add(r.data.id);
    expected.set(r.data.id, idList);
    saveState();
    return { ok: true, action: "create", card: title, url: r.data.shortUrl };
  }
  return {
    ok: false,
    error: `unknown action "${action}" — use comment | move | update | create | archive.`,
  };
}

// Workspace roots a local attachment must live under (light hygiene, mirrors
// share_file). Resolved lazily so config/env is read at call time.
function attachRoots() {
  return [
    config.projects.root,
    config.projects.defaultDir,
    ...(config.share?.allowedDirs || []),
    tmpdir(),
  ]
    .filter(Boolean)
    .map((r) => {
      try {
        return realpathSync(resolvePath(r));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Attach a file (local `path`) or a link (`url`) to a card. Card is addressed by
// cardKey (a tracked card) or cardRef (id/shortLink/URL — reaches the owner's cards).
// Local uploads must be an absolute path inside the workspace, under the size cap.
export async function attachCard({ cardKey, cardRef, path: filePath, url, name } = {}) {
  if (!enabledBasic()) return { ok: false, error: "Trello is off (TRELLO_ENABLED)." };
  if (!(await ensureReady())) return { ok: false, error: "Trello board not reachable." };
  if (!cardKey && !cardRef) return { ok: false, error: "card_key or card_ref is required." };
  if (!filePath && !url) return { ok: false, error: "attach needs `path` or `url`." };

  const cardsRes = await api(
    "GET",
    `/boards/${boardId}/cards?fields=name,idList,desc,shortUrl,shortLink`
  );
  if (!cardsRes.ok) return { ok: false, error: `list cards: ${cardsRes.error}` };
  const found = resolveCard(cardsRes.data, { cardKey, cardRef });
  if (found.error) return { ok: false, error: found.error };
  const card = found.card;
  const endpoint = `${API}/cards/${card.id}/attachments?${auth()}`;

  // Link attachment — Trello just stores the URL, no upload.
  if (url) {
    const form = new URLSearchParams({ url });
    if (name) form.set("name", name);
    let res, text, data;
    try {
      res = await fetch(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(30000) });
      text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (!res.ok) return { ok: false, error: `${res.status} ${data?.message || text}` };
    return { ok: true, action: "attach", card: card.name, attachment: data?.name || url, url: card.shortUrl };
  }

  // File upload — absolute path, must resolve to a regular file in the workspace.
  if (!isAbsolute(filePath)) return { ok: false, error: "`path` must be absolute." };
  let real, st;
  try {
    real = realpathSync(resolvePath(filePath));
    st = statSync(real);
  } catch {
    return { ok: false, error: `file not found: ${filePath}` };
  }
  if (!st.isFile()) return { ok: false, error: "not a regular file." };
  const roots = attachRoots();
  if (!roots.some((r) => real === r || real.startsWith(r + sep)))
    return {
      ok: false,
      error: `"${real}" is outside the allowed dirs (${roots.join(", ")}). Use a path under the project workspace, or add its dir to SHARE_ALLOWED_DIRS.`,
    };
  const maxBytes = (config.attachments?.maxMb || 25) * 1024 * 1024;
  if (st.size > maxBytes)
    return {
      ok: false,
      error: `file is ${(st.size / 1048576).toFixed(1)}MB, over the ${config.attachments?.maxMb || 25}MB limit.`,
    };

  let res, text, data;
  try {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(real)]), name || basename(real));
    if (name) form.append("name", name);
    res = await fetch(endpoint, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    text = await res.text();
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res.ok) return { ok: false, error: `${res.status} ${data?.message || text}` };
  return { ok: true, action: "attach", card: card.name, attachment: data?.name || basename(real), url: card.shortUrl };
}

// On-demand READ of the board — so the team lead can check a comment / the board
// state without waiting for the poll feed. Returns current cards (with their
// status list) and recent comments. `cardKey` filters comments to one card.
export async function readBoard({ limit = 20, cardKey } = {}) {
  if (!enabledBasic()) return { ok: false, error: "Trello is off (TRELLO_ENABLED)." };
  if (!(await ensureReady())) return { ok: false, error: "Trello board not reachable." };

  // Pull attachments inline (attachments=true) so a link/file the owner pasted onto
  // a card reaches the team lead too — not just the description. attachment_fields
  // keeps the payload to name+url.
  const cardsRes = await api(
    "GET",
    `/boards/${boardId}/cards?fields=name,idList,desc,shortUrl,shortLink&attachments=true&attachment_fields=name,url`
  );
  if (!cardsRes.ok) return { ok: false, error: `list cards: ${cardsRes.error}` };
  const cards = cardsRes.data.map((c) => ({
    key: keyOf(c.desc),
    ref: c.shortLink, // stable handle for trello_write when key is null (untracked)
    title: c.name,
    desc: stripMarker(c.desc), // the card's description (our [[tl:...]] marker removed)
    status: statusByListId.get(c.idList) || nameByListId.get(c.idList) || null,
    url: c.shortUrl,
    attachments: (c.attachments || [])
      .map((a) => ({ name: a.name || null, url: a.url || null }))
      .filter((a) => a.url || a.name),
  }));

  const actsRes = await api(
    "GET",
    `/boards/${boardId}/actions?filter=commentCard&limit=${Math.min(Number(limit) || 20, 50)}`
  );
  let comments =
    actsRes.ok && Array.isArray(actsRes.data)
      ? actsRes.data.map((a) => ({
          card: a.data?.card?.name,
          cardId: a.data?.card?.id,
          text: a.data?.text,
          date: a.date,
          by: a.memberCreator?.fullName || a.idMemberCreator,
        }))
      : [];
  if (cardKey) {
    const target = cardsRes.data.find((c) => keyOf(c.desc) === cardKey);
    comments = target ? comments.filter((c) => c.cardId === target.id) : [];
  }
  return { ok: true, cards, comments };
}

// ── Trello -> team lead (poll + optional webhook) ────────────────────────────
// The poll cursor is PERSISTED to disk so a restart resumes instead of
// re-baselining. `node --watch` reloads the bridge on every code edit, and a
// fresh baseline swallows whatever exists at startup — so without this, a comment
// or move made in that gap would be lost forever. With it, the first poll after a
// restart reports everything newer than the saved cursor.
const STATE_FILE = dataPath(".trello-state.json");
let baselined = false; // until baselined, the first poll only records (no report)
let lastActionDate = ""; // ISO cursor for the commentCard actions feed
const pendingForTick = []; // change lines the next heartbeat tick will reconcile

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    lastActionDate = s.lastActionDate || "";
    for (const [id, list] of s.expected || []) expected.set(id, list);
    for (const id of s.known || []) known.add(id);
    for (const id of s.ourComments || []) ourComments.add(id); // don't loop on our own replies after a restart
    if (Array.isArray(s.pending)) pendingForTick.push(...s.pending); // unhandled changes
    baselined = true; // we have history — report anything newer than the cursor
    log.info(
      `[trello] resumed poll cursor (since ${lastActionDate || "start"})` +
        (pendingForTick.length ? `, ${pendingForTick.length} change(s) still pending` : "")
    );
  } catch {
    /* no prior state — the first poll will establish a fresh baseline */
  }
}

function saveState() {
  try {
    writeFileSync(
      STATE_FILE,
      JSON.stringify({
        lastActionDate,
        expected: [...expected],
        known: [...known],
        pending: [...pendingForTick], // survive a restart so nothing is dropped
        ourComments: [...ourComments].slice(-100), // recent own-reply ids (bounded)
      })
    );
  } catch (err) {
    log.warn(`[trello] could not persist state: ${err.message}`);
  }
}
loadState();

// Drained by the team lead when it acts on the owner's changes (heartbeat tick or an
// immediate nudge). Clears the queue and persists so a restart won't replay it.
// Read the queued changes WITHOUT clearing them, plus how many there are. The
// caller builds its run prompt from `note`, then calls consumePending(count)
// only AFTER the run is committed — so a failed run leaves the changes queued
// for the next tick instead of dropping them. `count` (not clear-all) is spliced
// so changes the poll appends DURING the run survive to the next tick.
export function peekPending() {
  return { note: pendingForTick.join("\n"), count: pendingForTick.length };
}

export function consumePending(count) {
  if (count > 0) {
    pendingForTick.splice(0, count);
    saveState();
  }
}

// Ask the team lead to act on whatever is queued — but only when nudgeOnChange is
// on. nudge() no-ops if the team lead is busy; the queue persists and the next
// poll (or heartbeat tick) retries, so a change is never silently dropped.
function maybeNudge() {
  if (T.nudgeOnChange && pendingForTick.length && hooks?.nudge) hooks.nudge();
}

// Record a batch of detected changes: always queue (durably) + show the owner in
// the channel, then try to act on the queue now.
function report(lines) {
  if (!lines.length) return;
  pendingForTick.push(...lines);
  saveState();
  hooks?.notify?.(`🗂️ Trello:\n${lines.join("\n")}`);
  maybeNudge();
}

// One card move/add, expressed as a human line. Returns null if it's our write.
function cardDelta(card) {
  if (!known.has(card.id)) {
    known.add(card.id);
    expected.set(card.id, card.idList);
    if (keyOf(card.desc)) return null; // one of ours, created elsewhere
    const where = nameByListId.get(card.idList) || "board";
    return `added "${card.name}" in ${where}`;
  }
  const prev = expected.get(card.id);
  if (prev && prev !== card.idList) {
    expected.set(card.id, card.idList);
    const where = nameByListId.get(card.idList);
    const status = statusByListId.get(card.idList);
    return `moved "${card.name}" -> ${where || card.idList}${status ? ` (${status})` : ""}`;
  }
  return null;
}

async function poll() {
  if (!(await ensureReady())) return;
  const lines = [];

  const cards = await api(
    "GET",
    `/boards/${boardId}/cards?fields=name,idList,desc,shortUrl`
  );
  if (cards.ok) {
    for (const c of cards.data) {
      const d = cardDelta(c);
      if (d && baselined) lines.push(d);
    }
  }

  // Comments are unambiguous (we never post them), so no expected-state filter.
  const since = lastActionDate ? `&since=${encodeURIComponent(lastActionDate)}` : "";
  const acts = await api(
    "GET",
    `/boards/${boardId}/actions?filter=commentCard&limit=50${since}`
  );
  if (acts.ok && Array.isArray(acts.data)) {
    // Feed is newest-first; walk oldest-first and advance the cursor.
    for (const a of acts.data.slice().reverse()) {
      if (a.date) lastActionDate = a.date;
      if (ourComments.has(a.id)) continue; // a reply WE posted — don't echo it
      if (baselined) lines.push(`comment on "${a.data?.card?.name}": ${a.data?.text}`);
    }
  }

  saveState(); // persist the cursor + card state every cycle (survives restarts)

  if (!baselined) {
    baselined = true; // first pass established the baseline; report from now on
    return;
  }
  if (lines.length) log.info(`[trello] surfaced ${lines.length} change(s) from the owner`);
  report(lines);
  // Retry acting on anything still queued (e.g. a prior nudge fired while the team
  // lead was mid-run), so a change doesn't wait for the 30-min heartbeat.
  maybeNudge();
}

// ── Webhook (real-time; only if a public callback URL is configured) ─────────
async function registerWebhook() {
  const existing = await api("GET", `/tokens/${T.token}/webhooks`);
  if (existing.ok && Array.isArray(existing.data)) {
    // Our callback URL changes every ngrok restart, so a webhook for THIS board
    // with a different URL is stale — delete it, else Trello keeps POSTing to a
    // dead tunnel until it gives up.
    for (const w of existing.data) {
      if (w.idModel !== boardId) continue;
      if (w.callbackURL === T.webhookCallbackUrl) {
        log.info("[trello] webhook already registered");
        return;
      }
      await api("DELETE", `/webhooks/${w.id}`);
      log.info("[trello] removed stale webhook");
    }
  }
  const r = await api("POST", "/webhooks", {
    idModel: boardId,
    callbackURL: T.webhookCallbackUrl,
    description: "claude-spawn team-lead board sync",
  });
  if (r.ok) log.info("[trello] webhook registered");
  else log.warn(`[trello] webhook registration failed (poll still active): ${r.error}`);
}

// Trello signs each webhook POST: base64(HMAC-SHA1(rawBody + callbackURL,
// apiSecret)) in the X-Trello-Webhook header. Verify it so the endpoint (a
// PUBLIC URL) can't be driven by forged POSTs — each accepted event can wake a
// paid team-lead run. Returns false unless the signature matches; if no secret
// is configured we can't verify, so we also reject (fail closed).
function validWebhook(rawBody, header) {
  if (!T.apiSecret || !header) return false;
  let expected, got;
  try {
    expected = createHmac("sha1", T.apiSecret)
      .update(rawBody)
      .update(T.webhookCallbackUrl || "")
      .digest();
    got = Buffer.from(String(header), "base64");
  } catch {
    return false;
  }
  return expected.length === got.length && timingSafeEqual(expected, got);
}

function startWebhookServer() {
  if (T.webhookCallbackUrl && !T.apiSecret)
    log.warn(
      "[trello] TRELLO_API_SECRET not set — webhook POSTs cannot be verified and will be rejected; poll loop still active."
    );
  // Trello validates a new webhook by sending HEAD, then POSTs each action.
  const server = createServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(200).end();
      return;
    }
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!validWebhook(raw, req.headers["x-trello-webhook"])) {
        res.writeHead(401).end(); // forged/unsigned — drop before doing any work
        return;
      }
      res.writeHead(200).end();
      let action;
      try {
        action = JSON.parse(raw.toString("utf8") || "{}").action;
      } catch {
        return;
      }
      if (!action || !baselined) return;
      if (action.type === "commentCard" && ourComments.has(action.id)) return;
      const lines = [];
      if (action.type === "commentCard") {
        lines.push(`comment on "${action.data?.card?.name}": ${action.data?.text}`);
      } else if (action.type === "createCard" || action.type === "updateCard") {
        const card = action.data?.card;
        if (card?.id) {
          const d = cardDelta({
            id: card.id,
            name: card.name,
            idList: action.data?.listAfter?.id || action.data?.list?.id || card.idList,
            desc: card.desc,
          });
          if (d) lines.push(d);
        }
      }
      report(lines);
    });
  });
  server.on("error", (err) => log.warn(`[trello] webhook server: ${err.message}`));
  server.listen(T.webhookPort, () =>
    log.info(`[trello] webhook server on :${T.webhookPort}`)
  );
  return server;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
export function startTrello() {
  if (!enabledBasic()) {
    log.info("[trello] idle (TRELLO_ENABLED off or credentials missing)");
    return () => {};
  }
  let timer = null;
  let webhook = null;

  ensureReady().then(async (ok) => {
    if (!ok) return;
    if (T.webhookCallbackUrl) {
      webhook = startWebhookServer();
      await registerWebhook();
    }
    await poll(); // establish the baseline immediately
    timer = setInterval(() => poll().catch((e) => log.warn(`[trello] poll: ${e.message}`)), T.pollMs);
    log.info(
      `[trello] armed — polling every ${Math.round(T.pollMs / 1000)}s${
        T.webhookCallbackUrl ? " + webhook" : ""
      }`
    );
  });

  return () => {
    if (timer) clearInterval(timer);
    if (webhook) webhook.close();
  };
}
