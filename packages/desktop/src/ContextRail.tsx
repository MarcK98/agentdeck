import { useCallback, useEffect, useState } from "react";
import type { DeliverableFile, ThreadContext } from "./types";

const fmtSize = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} kB` : `${n} B`;

// The 3b right rail: Run / Isolation / Pull request sections over
// getThreadContext, with Stop, Reset session, and worktree cleanup.

export default function ContextRail({ threadId }: { threadId: number }) {
  const [ctx, setCtx] = useState<ThreadContext | null>(null);
  const [dirtyCount, setDirtyCount] = useState<number | null>(null);
  const [outputs, setOutputs] = useState<{ dir: string | null; files: DeliverableFile[] }>({
    dir: null,
    files: [],
  });

  const refresh = useCallback(() => {
    window.spawn
      .getThreadContext(threadId)
      .then(setCtx)
      .catch(() => setCtx(null));
    window.spawn
      .listDeliverables(threadId)
      .then(setOutputs)
      .catch(() => setOutputs({ dir: null, files: [] }));
  }, [threadId]);

  useEffect(() => {
    setCtx(null);
    setDirtyCount(null);
    refresh();
  }, [refresh]);

  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if ((ev.type === "turn:start" || ev.type === "turn:done") && ev.payload.threadId === threadId) refresh();
      if (ev.type === "deliverables:updated" && ev.payload.threadId === threadId) refresh();
      if (ev.type === "thread:updated" && ev.payload.id === threadId) refresh();
    });
  }, [threadId, refresh]);

  const cleanup = async (force: boolean) => {
    const r = await window.spawn.cleanupThread(threadId, force);
    if (!r.ok && r.reason === "dirty") {
      setDirtyCount(r.dirty ?? 0);
      return;
    }
    setDirtyCount(null);
    refresh();
  };

  if (!ctx) return <aside className="rail fade-l" />;

  const shortPath = ctx.worktreePath ? `…/${ctx.worktreePath.split("/").slice(-2).join("/")}` : null;

  return (
    <aside className="rail fade-l">
      <div className="rail-sect">
        <span className="h">Run</span>
        {ctx.process.running ? (
          <>
            <span className="row">
              <span className="dot-live pulse" />
              running · pid {ctx.process.pid}
              {ctx.process.model ? ` · ${ctx.process.model}` : ""}
            </span>
            {ctx.cost.lastContextTokens != null && (
              <span className="row">
                <i className="ph ph-gauge" />
                {Math.round(ctx.cost.lastContextTokens / 1000)}k ctx last turn
              </span>
            )}
          </>
        ) : (
          <span className="row">
            <span className="dot-idle" />
            idle
            {ctx.cost.lastModel ? ` · last ran ${ctx.cost.lastModel}` : ""}
          </span>
        )}
        <span className="row">
          <i className="ph ph-stack" />${ctx.cost.totalUsd.toFixed(4)} · {ctx.cost.turns} turn
          {ctx.cost.turns === 1 ? "" : "s"}
        </span>
        <span className="btns">
          {ctx.process.running && (
            <button className="btn btn-ghost small-btn" onClick={() => window.spawn.cancelTurn(threadId)}>
              Stop
            </button>
          )}
          <button
            className="btn btn-ghost small-btn"
            title="Forget this thread's session — next message starts fresh"
            onClick={() => window.spawn.resetThreadSession(threadId)}
          >
            <i className="ph ph-arrow-counter-clockwise" /> Reset session
          </button>
        </span>
      </div>

      <div className="rail-sect">
        <span className="h">Isolation</span>
        {ctx.branch ? (
          <>
            <span className="row">
              <i className="ph ph-git-branch" />
              <code className="pill">{ctx.branch}</code>
            </span>
            {shortPath && (
              <span className="row" title={ctx.worktreePath ?? ""}>
                <i className="ph ph-folder-open" />
                <span className="ell">{ctx.status === "archived" ? "worktree removed" : shortPath}</span>
              </span>
            )}
            {ctx.git && (
              <span className="row">
                <i className="ph ph-file-dashed" />
                {ctx.git.dirty > 0 ? `${ctx.git.dirty} uncommitted` : "clean"}
                {ctx.git.ahead > 0 && ` · ↑${ctx.git.ahead}`}
                {ctx.git.behind > 0 && ` · ↓${ctx.git.behind}`}
              </span>
            )}
            {ctx.git?.lastCommit && (
              <span className="row" title={ctx.git.lastCommit}>
                <i className="ph ph-git-commit" />
                <span className="ell mono" style={{ fontSize: 11 }}>
                  {ctx.git.lastCommit}
                </span>
              </span>
            )}
            {ctx.worktreePath && !ctx.process.running && (
              <span className="btns">
                {dirtyCount == null ? (
                  <button className="btn btn-ghost small-btn" onClick={() => cleanup(false)}>
                    Clean up worktree
                  </button>
                ) : (
                  <>
                    <span className="warn-c" style={{ fontSize: 11 }}>
                      {dirtyCount} uncommitted — discard?
                    </span>
                    <button className="btn btn-ghost small-btn err-c" onClick={() => cleanup(true)}>
                      Force
                    </button>
                    <button className="btn btn-ghost small-btn" onClick={() => setDirtyCount(null)}>
                      Keep
                    </button>
                  </>
                )}
              </span>
            )}
          </>
        ) : (
          <span className="row">
            <i className="ph ph-git-branch" />
            none — runs in the project dir
          </span>
        )}
      </div>

      {outputs.files.length > 0 && (
        <div className="rail-sect">
          <span className="h">Outputs</span>
          {outputs.files.slice(0, 8).map((f) => (
            <button
              key={f.path}
              className="row out-file"
              title={`${f.name} · ${fmtSize(f.size)} — reveal in Finder`}
              onClick={() => window.spawn.revealFile(f.path)}
            >
              <i className="ph ph-file-arrow-down" />
              <span className="ell">{f.name}</span>
              <span style={{ marginLeft: "auto", flex: "none", color: "var(--color-neutral-600)", fontSize: 10.5 }}>
                {fmtSize(f.size)}
              </span>
            </button>
          ))}
          {outputs.dir && (
            <span className="btns">
              <button className="btn btn-ghost small-btn" onClick={() => window.spawn.openDir(outputs.dir!)}>
                <i className="ph ph-folder-open" /> Open folder
              </button>
            </span>
          )}
        </div>
      )}

      <div className="rail-sect">
        <span className="h">Pull request</span>
        {ctx.pr ? (
          <span className="row">
            <i className="ph ph-git-pull-request" />
            <a href={ctx.pr.url} target="_blank" rel="noreferrer">
              #{ctx.pr.number}
            </a>
            <span className={ctx.pr.state === "OPEN" ? "ok-c" : ctx.pr.state === "MERGED" ? "" : "err-c"}>
              {ctx.pr.state.toLowerCase()}
            </span>
            {ctx.pr.checks && (
              <span className={ctx.pr.checks === "passing" ? "ok-c" : ctx.pr.checks === "failing" ? "err-c" : "warn-c"}>
                · checks {ctx.pr.checks}
              </span>
            )}
          </span>
        ) : (
          <span className="row">
            <i className="ph ph-git-pull-request" />
            {ctx.branch ? "none yet — opens when the agent finishes" : "no ticket branch"}
          </span>
        )}
      </div>
    </aside>
  );
}
