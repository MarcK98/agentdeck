import { askClaude } from "./claude.js";
import { log } from "./logger.js";
import {
  isEnabled as trelloEnabled,
  peekPending as peekTrello,
  consumePending as consumeTrello,
} from "./trello.js";

// An always-on "team lead" bound to one channel. A heartbeat wakes it on an
// interval to check progress on its task board, delegate coding to project
// channels, and ping the owner when it needs a decision — without waiting for
// the owner to speak. Everything narrates into the team-lead channel.
//
// The Discord adapter registers these hooks:
//   teamlead()               -> { sessionKey, cwd, send } | null   (#team-lead)
//   resolveChannel(nameOrId) -> { channelId, sessionKey, cwd, send } | null
//   ownerMention()           -> "<@id>" | ""   (auto-learned from messages)
let hooks = null;
export const registerTeamLead = (h) => (hooks = h);

const INTERVAL_MIN = Number(process.env.TEAMLEAD_INTERVAL_MINUTES) || 30;
const MAX_TICKS_PER_DAY = Number(process.env.TEAMLEAD_MAX_TICKS_PER_DAY) || 60;

// Heartbeat ticks are lightweight bookkeeping (read TASKS.md, check git/gh,
// decide the next action), so run them cheap by default. "" = inherit the CLI
// default model.
const TICK_MODEL = process.env.TEAMLEAD_MODEL || "";
const TICK_EFFORT = process.env.TEAMLEAD_EFFORT || "low";
// Beta headers for team-lead runs only — e.g. Sonnet's 1M window
// (context-1m-2025-08-07). Applied to BOTH heartbeat ticks and the owner's
// interactive messages, since they share one session: a >200k-context run
// without the beta would be rejected by the API.
const TICK_BETAS = (process.env.TEAMLEAD_BETAS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// The team lead's model context window, for the "near the window" warning.
// Set TEAMLEAD_CONTEXT_WINDOW=1000000 when on Sonnet-1M.
const CTX_WINDOW = Number(process.env.TEAMLEAD_CONTEXT_WINDOW) || 200_000;

// Model + betas the team-lead CHANNEL should also use for the owner's interactive
// messages — the heartbeat and their messages share one session, so they must
// match (else a big-context resume without the 1M beta fails).
export const teamleadRunOpts = () => ({
  model: TICK_MODEL || undefined,
  betas: TICK_BETAS.length ? TICK_BETAS : undefined,
});
// The team lead keeps durable state in TASKS.md. By default we DON'T auto-reset
// it — instead we warn the owner as its context climbs (once per WARN_EVERY tokens)
// so they can /reset on their own terms. Set a non-zero TEAMLEAD_MAX_CONTEXT_TOKENS
// to also hard-reset past that cap. Mind the model window (~200k on haiku).
const RESET_CAP = Number(process.env.TEAMLEAD_MAX_CONTEXT_TOKENS) || 0;
const WARN_EVERY = Number(process.env.TEAMLEAD_CONTEXT_WARN_EVERY) || 20_000;
let lastWarnLevel = 0; // highest WARN_EVERY step we've already warned about

let paused = false;
let running = false; // guard against overlapping ticks
let heartbeat = null;
let ticksToday = 0;
let dayStamp = "";

export const isPaused = () => paused;
export const setPaused = (v) => {
  paused = Boolean(v);
  return paused;
};

// Current wall-clock, handed to the team lead each tick so he can reason about
// elapsed time, business hours, and deadlines without shelling out to `date`.
const nowStamp = () => {
  const d = new Date();
  const local = d.toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${local} (${d.toISOString()})`;
};

// Trello board changes the owner made since the last tick (moves/adds/comments).
// PEEKED, not drained — the caller consumes the queue only after the run is
// committed (see tick/nudge), so a failed run doesn't drop the changes.
const trelloInbound = () => {
  if (!trelloEnabled()) return { text: "", count: 0 };
  const { note, count } = peekTrello();
  const text = note
    ? `\n\n📥 Trello — the owner changed the board since your last tick:\n${note}\nReconcile these into TASKS.md (a card moved to "Blocked"/"Done" is the owner's decision; a comment is input for you). For a card the owner ADDED, create the matching TASKS.md task using their card's EXACT title — the next trello_sync then adopts their card instead of making a duplicate. Do NOT open a new card for something they already carded.`
    : "";
  return { text, count };
};

// Standing instruction to mirror TASKS.md to the board each run (only when the
// board is wired). Kept last so it runs after TASKS.md is up to date.
const trelloSyncStep = () =>
  trelloEnabled()
    ? `\n7. Mirror the board: call mcp__approver__trello_sync with every active task
   (\`key\` = stable slug, \`title\`, \`status\` = todo|in-progress|blocked|in-review|done,
   one-line \`body\`). Skip the call only if no task changed since last sync.`
    : "";

const tickPrompt = (ownerMention, inboundText = "") =>
  `⏰ Team-lead heartbeat check-in.  Current time: ${nowStamp()}.

You are the team lead, dedicated to the tasks the owner has assigned you. Work
proactively — this is an automatic tick, not a message from the owner.

1. Read your task board \`TASKS.md\` in this folder (create it from what the owner
   has assigned if it's missing). If there are no active tasks, reply with just
   "idle — no active tasks" and stop (keep it cheap).
2. For each in-progress task, check *concrete* progress: \`git log\`, \`gh pr list\`,
   \`gh pr checks\`, files on disk, the delegate channel's latest activity. Take
   the next action to move it forward.
3. Delegate coding/implementation to the right project channel with the
   mcp__approver__delegate tool (channel name/ID + a clear, self-contained task,
   plus \`model\`/\`effort\` to right-size cost: sonnet for coding, haiku for
   trivial/general, opus for heavy reasoning; effort low→max). Don't do heavy
   implementation yourself — you coordinate and verify. Channels map to repos
   under PROJECTS_ROOT. See CLAUDE.md for the full model/effort/token policy.
4. Update \`TASKS.md\` (status + next step per task).
5. Post a SHORT status here: what moved, what's blocked, what's next.
6. Only if you need a decision or input from the owner, @mention them: ${ownerMention || "the owner"}.
   Otherwise do not ping.${trelloSyncStep()}${inboundText}

Be terse and token-cheap. If nothing changed since the last tick, say so in one line.`;

async function tick() {
  if (paused || running || !hooks) return;
  const tl = hooks.teamlead();
  if (!tl) return;

  const day = new Date().toISOString().slice(0, 10);
  if (day !== dayStamp) {
    dayStamp = day;
    ticksToday = 0;
  }
  if (MAX_TICKS_PER_DAY && ticksToday >= MAX_TICKS_PER_DAY) {
    return; // daily safety cap reached
  }
  ticksToday++;

  running = true;
  const inbound = trelloInbound(); // peek; consumed below only if the run commits
  try {
    const res = await askClaude(
      tl.sessionKey,
      tickPrompt(hooks.ownerMention?.(), inbound.text),
      tl.cwd,
      tl.send,
      {
        model: TICK_MODEL || undefined,
        effort: TICK_EFFORT || undefined,
        betas: TICK_BETAS.length ? TICK_BETAS : undefined,
        maxContextTokens: RESET_CAP, // 0 = warn only, never reset
        meta: { channelName: "team-lead", source: "teamlead-tick" },
      }
    );
    // Warn as context climbs — once per WARN_EVERY-token step — without resetting.
    const ctx = res.contextTokens || 0;
    if (WARN_EVERY && ctx) {
      const level = Math.floor(ctx / WARN_EVERY);
      if (level > lastWarnLevel) {
        lastWarnLevel = level;
        const k = Math.round(ctx / 1000);
        const winK = Math.round(CTX_WINDOW / 1000);
        const nearWindow = ctx >= CTX_WINDOW - 10_000;
        tl.send?.(
          `📈 My context is ~${k}k tokens and climbing (I won't auto-reset).` +
            (nearWindow
              ? ` ⚠️ Near the ~${winK}k model window — Claude will auto-compact soon; \`/reset\` me${CTX_WINDOW >= 1_000_000 ? "" : " or move me to a 1M model"}.`
              : ` \`/reset\` me anytime for a clean slate — state is safe in TASKS.md.`)
        );
      } else if (level < lastWarnLevel) {
        lastWarnLevel = level; // context shrank (you reset me) — rearm warnings
      }
    }
    // Only fires if you set a non-zero TEAMLEAD_MAX_CONTEXT_TOKENS hard cap.
    if (res.contextReset) {
      tl.send?.(
        `🧹 Context passed the ~${Math.round(RESET_CAP / 1000)}k cap — reset my session; next tick rebuilds from TASKS.md.`
      );
    }
    if (!res.ok) tl.send(`⚠️ Team-lead tick failed: ${res.text}`);
    else consumeTrello(inbound.count); // committed — safe to clear these changes
  } catch (err) {
    log.warn("[teamlead] tick error:", err.message); // leave changes queued for next tick
  } finally {
    running = false;
  }
}

// Start the heartbeat. Returns a stop() function. Arms whenever a channel is
// configured; each tick resolves the channel (the client cache isn't ready yet
// at startup), so it no-ops safely until the channel exists.
export function startTeamLead() {
  if (!process.env.TEAMLEAD_CHANNEL) {
    log.info("[teamlead] idle (TEAMLEAD_CHANNEL not set)");
    return () => {};
  }
  clearInterval(heartbeat);
  heartbeat = setInterval(tick, INTERVAL_MIN * 60_000);
  log.info(`[teamlead] armed — heartbeat every ${INTERVAL_MIN}m (cap ${MAX_TICKS_PER_DAY}/day)`);
  return () => clearInterval(heartbeat);
}

// Act on the owner's queued Trello changes right away (only when TRELLO_NUDGE_ON_CHANGE
// is on). Shares the overlap guard with the heartbeat, so it no-ops while a tick
// or another nudge is running — the queue is durable, so the next poll or tick
// retries it; nothing is dropped. Drains the queue only AFTER a run is committed.
export async function nudgeTeamLead() {
  if (paused || running || !hooks) return;
  if (!trelloEnabled()) return;
  const tl = hooks.teamlead();
  if (!tl) return;
  running = true;
  try {
    const { note, count } = peekTrello(); // peek; consumed only after a committed run
    if (!note) return;
    log.info("[teamlead] acting on Trello change(s) now");
    const res = await askClaude(
      tl.sessionKey,
      `🗂️ Trello — the owner changed the board:\n${note}\n\nAct on this now: read the relevant card's comments with mcp__approver__trello_read if you need the full text, update \`TASKS.md\`, take the next action (delegate if it's implementation), reply to the owner on the card with mcp__approver__trello_write if useful, then re-sync with mcp__approver__trello_sync. Be terse.`,
      tl.cwd,
      tl.send,
      {
        model: TICK_MODEL || undefined,
        effort: TICK_EFFORT || undefined,
        betas: TICK_BETAS.length ? TICK_BETAS : undefined,
        maxContextTokens: RESET_CAP,
        meta: { channelName: "team-lead", source: "teamlead-trello" },
      }
    );
    if (res?.ok) consumeTrello(count); // committed — clear; else leave queued for the poll/tick to retry
  } catch (err) {
    log.warn("[teamlead] trello nudge error:", err.message);
  } finally {
    running = false;
  }
}

// Delegate a task to a project channel's agent (the delegate MCP tool routes
// here). The work runs — and streams — in that channel; the team lead monitors.
export async function onDelegate({ channel, task, model, effort }) {
  if (!hooks) return;
  const tl = hooks.teamlead();
  const target = hooks.resolveChannel(channel);
  if (!target) {
    tl?.send(`⚠️ Delegate failed — channel "${channel}" not found.`);
    return;
  }
  const tag = [model, effort].filter(Boolean).join("/");
  tl?.send(
    `📤 Delegated to <#${target.channelId}>${tag ? ` \`${tag}\`` : ""}: ${String(task).slice(0, 200)}`
  );
  const prompt = `You've been assigned a task by the team lead:\n\n${task}\n\nWork on it in this project. Commit/push or open a PR as appropriate. If you produce a document, report, export, or log the owner should see, share it with the mcp__approver__share_file tool (it uploads the file to this channel). When done or blocked, summarize the outcome in one short message.`;
  const res = await askClaude(target.sessionKey, prompt, target.cwd, target.send, {
    model: model || undefined,
    effort: effort || undefined,
    meta: { channelName: channel || null, source: "teamlead-delegate" },
  });
  if (!res.ok) tl?.send(`⚠️ Delegated task run failed in <#${target.channelId}>.`);
}
