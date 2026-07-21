// Queue-while-busy tests for the daemon (SPWN-14).
//
// One turn at a time per thread: a message sent while a turn is in flight is
// persisted and QUEUED, then drained FIFO — one follow-up turn each — on
// turn:done. Cancelling the live turn is a deliberate "take over", so it also
// drops anything queued behind it.
//
// The real Claude runner (../claude.js) drives a node-pty child and the
// approval hub binds an HTTP port — both are mocked here so the test is
// hermetic and, incidentally, so only the native SQLite module loads. That
// module is built for Homebrew node@22's ABI, so run this suite with node@22:
//
//   /opt/homebrew/opt/node@22/bin/node --test --experimental-test-module-mocks \
//     packages/core/src/daemon/queue.test.js
//
// (Under the asdf runtime node v20.9.0 better-sqlite3 fails to load — ABI
// mismatch. See packages/core/src/db/index.js.)

import { test, before, beforeEach, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the store at a throwaway dir BEFORE anything reads config.js.
const DATA_DIR = mkdtempSync(join(tmpdir(), "spawn-queue-test-"));
process.env.SPAWN_DATA_DIR = DATA_DIR;

// ── Mock the Claude runner ────────────────────────────────────────────────────
// askClaude returns a promise that stays pending until the test completes it,
// so a "turn" can be held in flight. cancelRun completes the oldest in-flight
// run as cancelled — mirroring the real kill-the-child path, which resolves the
// run's promise with { cancelled: true } and triggers the daemon's drain.
const inflight = new Map(); // threadKey -> resolve[]
const calls = []; // { key, prompt } — every launched turn, in order

function askClaude(key, prompt) {
  calls.push({ key, prompt });
  return new Promise((resolve) => {
    const arr = inflight.get(key) ?? [];
    arr.push(resolve);
    inflight.set(key, arr);
  });
}

function cancelRun(key) {
  const arr = inflight.get(key);
  if (arr && arr.length) arr.shift()({ ok: false, cancelled: true, streamed: false, text: "" });
  return true;
}

// Complete the oldest in-flight turn for a thread and let the daemon's
// done-handler microtasks (bookkeeping + drain) settle.
function completeTurn(key, res = { ok: true, cancelled: false, streamed: true, text: "" }) {
  const arr = inflight.get(key);
  assert.ok(arr && arr.length, `no in-flight turn for ${key}`);
  arr.shift()(res);
  return flush();
}
const flush = () => new Promise((r) => setImmediate(r));

mock.module("../claude.js", {
  namedExports: {
    askClaude,
    cancelRun,
    resetSession: () => true,
    getLastStats: () => null,
    getActiveRun: () => null,
    pauseInactivity: () => {},
    resumeInactivity: () => {},
  },
});

// Approval hub binds an HTTP port on construction — stub it out entirely.
mock.module("./approvals.js", {
  namedExports: {
    createApprovalHub: () => ({ port: 0, resolve: () => false, pending: () => [], close: () => {} }),
  },
});

// Deliverables commit shells out to git — no-op it so the done-handler stays
// hermetic and instant.
mock.module("../deliverables.js", {
  namedExports: {
    dirFor: () => join(DATA_DIR, "out"),
    commitAll: async () => [],
    listFiles: () => [],
  },
});

let createDaemon, db;
const threadKey = (id) => `spawn:thread:${id}`;

before(async () => {
  ({ createDaemon } = await import("./index.js"));
  db = await import("../db/index.js");
});

after(() => {
  db?.closeDb?.();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Fresh daemon (fresh activeTurns/messageQueues closures) + fresh thread per
// test, so no queue state leaks between cases.
let daemon, threadId, key, events;
beforeEach(() => {
  inflight.clear();
  calls.length = 0;
  const project = db.upsertProject(`proj-${Math.round(process.hrtime()[1])}`, join(DATA_DIR, `p-${calls.length}-${process.hrtime.bigint()}`));
  const thread = db.createThread({ projectId: project.id, kind: "chat", title: "New thread" });
  threadId = thread.id;
  key = threadKey(threadId);
  daemon = createDaemon();
  events = [];
  daemon.events.on("event", (e) => events.push(e));
});

const typed = (t) => events.filter((e) => e.type === t);

test("first message launches a turn immediately (not queued)", () => {
  const r = daemon.sendMessage(threadId, "m1");
  assert.deepEqual(r, { threadId, started: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, "m1");
  assert.equal(typed("turn:queued").length, 0);
  assert.equal(typed("turn:start").length, 1);
});

test("a message sent while a turn is in flight is queued, not run in parallel", () => {
  daemon.sendMessage(threadId, "m1"); // in flight
  const r = daemon.sendMessage(threadId, "m2");
  assert.deepEqual(r, { threadId, queued: true, depth: 1 });
  assert.equal(calls.length, 1, "no second Claude run started");
  const q = typed("turn:queued");
  assert.equal(q.length, 1);
  assert.deepEqual(q[0].payload, { threadId, depth: 1 });
});

test("queued user messages are persisted immediately (visible in transcript)", () => {
  daemon.sendMessage(threadId, "m1");
  daemon.sendMessage(threadId, "m2 queued");
  const texts = db.listMessages(threadId, { limit: 50 }).filter((m) => m.role === "user").map((m) => m.text);
  assert.deepEqual(texts, ["m1", "m2 queued"]);
});

test("multiple queued messages report increasing depth", () => {
  daemon.sendMessage(threadId, "m1");
  assert.equal(daemon.sendMessage(threadId, "m2").depth, 1);
  assert.equal(daemon.sendMessage(threadId, "m3").depth, 2);
  assert.equal(daemon.sendMessage(threadId, "m4").depth, 3);
  assert.equal(calls.length, 1);
});

test("queue drains FIFO — one follow-up turn each, in order", async () => {
  daemon.sendMessage(threadId, "m1");
  daemon.sendMessage(threadId, "m2");
  daemon.sendMessage(threadId, "m3");

  await completeTurn(key); // m1 done -> drains m2
  assert.deepEqual(calls.map((c) => c.prompt), ["m1", "m2"]);
  await completeTurn(key); // m2 done -> drains m3
  assert.deepEqual(calls.map((c) => c.prompt), ["m1", "m2", "m3"]);
  await completeTurn(key); // m3 done -> queue empty
  assert.deepEqual(calls.map((c) => c.prompt), ["m1", "m2", "m3"]);
});

test("turn:done reports the remaining queue depth (N still waiting)", async () => {
  daemon.sendMessage(threadId, "m1");
  daemon.sendMessage(threadId, "m2");
  daemon.sendMessage(threadId, "m3");

  await completeTurn(key);
  assert.equal(typed("turn:done").at(-1).payload.queued, 1); // m3 still waiting
  await completeTurn(key);
  assert.equal(typed("turn:done").at(-1).payload.queued, 0); // m3 now draining
  await completeTurn(key);
  assert.equal(typed("turn:done").at(-1).payload.queued, 0);
});

test("thread is released once the queue empties — a later message launches fresh", async () => {
  daemon.sendMessage(threadId, "m1");
  daemon.sendMessage(threadId, "m2");
  await completeTurn(key); // drains m2
  await completeTurn(key); // empties queue, releases thread

  const r = daemon.sendMessage(threadId, "m3");
  assert.deepEqual(r, { threadId, started: true }, "not queued — thread was free");
  assert.equal(calls.at(-1).prompt, "m3");
});

test("cancel clears the queue — dropped messages never run", async () => {
  daemon.sendMessage(threadId, "m1"); // in flight
  daemon.sendMessage(threadId, "m2"); // queued
  daemon.sendMessage(threadId, "m3"); // queued
  assert.equal(calls.length, 1);

  daemon.cancelTurn(threadId);

  // The queue is cleared synchronously and clients told it's empty.
  const cleared = typed("turn:queued").at(-1);
  assert.deepEqual(cleared.payload, { threadId, depth: 0 });

  // The cancelled run's turn:done then fires and finds nothing to drain.
  await flush();
  const done = typed("turn:done").at(-1);
  assert.equal(done.payload.cancelled, true);
  assert.equal(done.payload.queued, 0);

  // m2 / m3 were dropped — only the original run ever started.
  assert.deepEqual(calls.map((c) => c.prompt), ["m1"]);

  // Thread is free again: a new message launches immediately.
  const r = daemon.sendMessage(threadId, "m4");
  assert.deepEqual(r, { threadId, started: true });
  assert.deepEqual(calls.map((c) => c.prompt), ["m1", "m4"]);
});

test("cancel with an empty queue does not emit a queue update", async () => {
  daemon.sendMessage(threadId, "m1"); // in flight, nothing queued
  daemon.cancelTurn(threadId);
  assert.equal(typed("turn:queued").length, 0, "no queue to clear -> no turn:queued");
  await flush();
  assert.equal(typed("turn:done").at(-1).payload.cancelled, true);
});
