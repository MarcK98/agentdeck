import { askClaude } from "./claude.js";
import { log } from "./logger.js";

// The PR review feedback loop. Fully event-driven — nothing polls:
//   1. a coding agent opens a PR and calls mcp__approver__notify_pr_reviewer
//   2. onNotify runs the reviewer (in #pr-reviewer), which posts a GitHub review
//      and calls pr_request_changes or pr_ready_to_merge
//   3. request_changes reruns the ORIGIN agent (its own session, so it keeps the
//      feature context) to address the comments and re-notify -> loop
//   4. ready_to_merge asks the human in the thread, then merges
//
// Everything for one PR narrates into a single Discord thread, so it reads as
// one conversation. The Discord adapter supplies the hooks below.
//   reviewer()                     -> { sessionKey, cwd } | null   (#pr-reviewer)
//   origin(sessionKey)             -> { cwd } | null               (a coding channel)
//   ensureThread(prUrl, originKey) -> Promise<(text:string)=>void> (a thread sender)
//   askMerge(send, prUrl)          -> Promise<boolean>
let hooks = null;
export const registerPrReviewer = (h) => (hooks = h);
export const prReviewerReady = () => Boolean(hooks && hooks.reviewer());

const MAX_ROUNDS = Number(process.env.PR_MAX_ROUNDS) || 5;
const MERGE_METHOD = process.env.PR_MERGE_METHOD || "squash";

const prs = new Map(); // prUrl -> { send, originSessionKey, originCwd, rounds }

const reviewPrompt = (url) => `You are an automated reviewer for a teammate's pull request. Review: ${url}

1. Inspect it: \`gh pr view ${url}\`, \`gh pr diff ${url}\`, \`gh pr checks ${url}\`.
2. Look for correctness bugs, security issues, and clear quality problems. Be specific and cite file:line. Do NOT edit code or push — you only review.
3. Post your review to GitHub as a comment: \`gh pr comment ${url} --body "<review>"\`. (GitHub blocks formally approving / requesting-changes on a PR authored by the same account, so a comment is the reliable path; only use \`gh pr review\` if a separate reviewer account is configured.)
4. Then signal the bridge with exactly one tool call:
   - Changes needed → mcp__approver__pr_request_changes(pr_url="${url}", summary="<what must change, briefly>").
   - Looks good → mcp__approver__pr_ready_to_merge(pr_url="${url}", summary="<one line>").
Keep your chat replies short.`;

const fixPrompt = (url, summary) => `The reviewer requested changes on your pull request ${url}.

Reviewer summary:
${summary}

1. Read the full feedback: \`gh pr view ${url} --comments\` and \`gh pr checks ${url}\`.
2. Check out the branch if needed (\`gh pr checkout ${url}\`), address every point, commit, and push.
3. When pushed, call mcp__approver__notify_pr_reviewer(pr_url="${url}") to request a re-review.
Keep your chat replies short.`;

export async function onNotify({ prUrl, originSessionKey }) {
  if (!hooks) return log.warn("[pr] no hooks registered");
  const rev = hooks.reviewer();
  if (!rev) return log.warn("[pr] no #pr-reviewer channel configured");

  let s = prs.get(prUrl);
  if (!s) {
    const send = await hooks.ensureThread(prUrl, originSessionKey);
    s = {
      send,
      originSessionKey,
      originCwd: hooks.origin(originSessionKey)?.cwd,
      rounds: 0,
    };
    prs.set(prUrl, s);
  }
  s.send(`🔍 Reviewing ${prUrl} …`);
  const res = await askClaude(rev.sessionKey, reviewPrompt(prUrl), rev.cwd, s.send);
  if (!res.ok) s.send(`⚠️ Review run failed: ${res.text}`);
}

export async function onRequestChanges({ prUrl, summary }) {
  const s = prs.get(prUrl);
  if (!s) return log.warn(`[pr] request-changes for untracked PR ${prUrl}`);
  s.rounds++;
  s.send(`📝 **Changes requested** (round ${s.rounds})\n${summary || ""}`);
  if (s.rounds > MAX_ROUNDS) {
    return s.send(`🚫 Stopped after ${MAX_ROUNDS} review rounds — needs a human.`);
  }
  if (!s.originSessionKey) {
    return s.send("⚠️ Couldn't route back to the author (unknown origin channel).");
  }
  const res = await askClaude(s.originSessionKey, fixPrompt(prUrl, summary), s.originCwd, s.send);
  if (!res.ok) s.send(`⚠️ Fix run failed: ${res.text}`);
}

export async function onReadyToMerge({ prUrl, summary }) {
  const s = prs.get(prUrl);
  if (!s) return log.warn(`[pr] ready-to-merge for untracked PR ${prUrl}`);
  s.send(`✅ **Reviewer approved**\n${summary || ""}`);
  const approved = await hooks.askMerge(s.send, prUrl);
  if (!approved) return s.send("Merge declined — leaving the PR open.");
  const rev = hooks.reviewer();
  const res = await askClaude(
    rev.sessionKey,
    `Merge the approved pull request now: run \`gh pr merge ${prUrl} --${MERGE_METHOD}\`. Report the outcome in one short line.`,
    rev.cwd,
    s.send
  );
  if (res.ok) prs.delete(prUrl);
}
