import { askClaude } from "./claude.js";
import { log } from "./logger.js";

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

const tickPrompt = (ownerMention) =>
  `⏰ Team-lead heartbeat check-in.

You are the team lead, dedicated to the tasks Marc has assigned you. Work
proactively — this is an automatic tick, not a message from Marc.

1. Read your task board \`TASKS.md\` in this folder (create it from what Marc has
   assigned if it's missing). If there are no active tasks, reply with just
   "idle — no active tasks" and stop (keep it cheap).
2. For each in-progress task, check *concrete* progress: \`git log\`, \`gh pr list\`,
   \`gh pr checks\`, files on disk, the delegate channel's latest activity. Take
   the next action to move it forward.
3. Delegate coding/implementation to the right project channel with the
   mcp__approver__delegate tool (a channel name/ID + a clear, self-contained
   task). Don't do heavy implementation yourself — you coordinate and verify.
   Project channels map to repos under PROJECTS_ROOT.
4. Update \`TASKS.md\` (status + next step per task).
5. Post a SHORT status here: what moved, what's blocked, what's next.
6. Only if you need a decision or input from Marc, @mention him: ${ownerMention || "Marc"}.
   Otherwise do not ping.

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
  try {
    const res = await askClaude(tl.sessionKey, tickPrompt(hooks.ownerMention?.()), tl.cwd, tl.send);
    if (!res.ok) tl.send(`⚠️ Team-lead tick failed: ${res.text}`);
  } catch (err) {
    log.warn("[teamlead] tick error:", err.message);
  } finally {
    running = false;
  }
}

// Start the heartbeat. Returns a stop() function.
export function startTeamLead() {
  if (!hooks?.teamlead()) {
    log.info("[teamlead] idle (TEAMLEAD_CHANNEL not set / not found)");
    return () => {};
  }
  clearInterval(heartbeat);
  heartbeat = setInterval(tick, INTERVAL_MIN * 60_000);
  log.info(`[teamlead] armed — heartbeat every ${INTERVAL_MIN}m (cap ${MAX_TICKS_PER_DAY}/day)`);
  return () => clearInterval(heartbeat);
}

// Delegate a task to a project channel's agent (the delegate MCP tool routes
// here). The work runs — and streams — in that channel; the team lead monitors.
export async function onDelegate({ channel, task }) {
  if (!hooks) return;
  const tl = hooks.teamlead();
  const target = hooks.resolveChannel(channel);
  if (!target) {
    tl?.send(`⚠️ Delegate failed — channel "${channel}" not found.`);
    return;
  }
  tl?.send(`📤 Delegated to <#${target.channelId}>: ${String(task).slice(0, 200)}`);
  const prompt = `You've been assigned a task by the team lead:\n\n${task}\n\nWork on it in this project. Commit/push or open a PR as appropriate. When done or blocked, summarize the outcome in one short message.`;
  const res = await askClaude(target.sessionKey, prompt, target.cwd, target.send);
  if (!res.ok) tl?.send(`⚠️ Delegated task run failed in <#${target.channelId}>.`);
}
