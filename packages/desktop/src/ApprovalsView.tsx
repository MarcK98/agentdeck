import { useCallback, useEffect, useState } from "react";
import type { ActiveThread, ApprovalDecision, ApprovalRequest } from "./types";

// Approvals inbox (design 3c): the pending queue with full input context and
// a decided-today trail. "Allow + rule" (standing allowlists) is a future
// step — the daemon answers one prompt at a time today.

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function ApprovalsView({
  active,
  onOpenThread,
}: {
  active: ActiveThread[];
  onOpenThread: (projectId: number, threadId: number) => void;
}) {
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [decisions, setDecisions] = useState<ApprovalDecision[]>([]);

  const refresh = useCallback(() => {
    window.spawn.listApprovals().then(setPending).catch(() => {});
    window.spawn.listDecisions().then(setDecisions).catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (ev.type === "approval:request" || ev.type === "approval:resolved") refresh();
    });
  }, [refresh]);

  const answer = async (id: number, allow: boolean) => {
    await window.spawn.resolveApproval(id, allow);
    refresh();
  };

  const threadOf = (threadId: number | null) => active.find((t) => t.id === threadId) ?? null;

  return (
    <div className="view">
      <div className="view-head">
        <h4>Approvals</h4>
        <span className="sub">
          {pending.length === 0
            ? "nothing waiting on you"
            : `${pending.length} thread${pending.length === 1 ? "" : "s"} paused, waiting on you`}
        </span>
      </div>
      <div className="approvals-body">
        <div className="appr-list">
          {pending.map((a) => {
            const t = threadOf(a.threadId);
            return (
              <div key={a.id} className="appr-card">
                <div className="head">
                  <i className="ph-fill ph-hand-palm" />
                  <span className="tool">{a.tool}</span>
                  <span className="ctx">
                    {t ? `${t.title} · ${t.project_name}` : a.threadId != null ? `thread ${a.threadId}` : ""}
                    {t?.branch ? " · " : ""}
                    {t?.branch && <code className="pill">{t.branch}</code>}
                  </span>
                </div>
                <pre className="input">{JSON.stringify(a.input, null, 2)}</pre>
                <div className="acts">
                  <button className="btn btn-primary small-btn" onClick={() => answer(a.id, true)}>
                    Allow once
                  </button>
                  <button className="btn btn-ghost small-btn" onClick={() => answer(a.id, false)}>
                    Deny
                  </button>
                  {t && (
                    <button
                      className="btn btn-ghost small-btn"
                      style={{ marginLeft: "auto" }}
                      onClick={() => onOpenThread(t.project_id, t.id)}
                    >
                      Open thread
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {pending.length === 0 && (
            <div className="panel" style={{ color: "var(--color-neutral-500)", fontSize: 12.5 }}>
              No pending approvals. Prompted requests land here and pause only their own thread.
            </div>
          )}

          <div className="sect" style={{ marginTop: 6 }}>
            <span>Decided recently</span>
            <span className="line" />
          </div>
          <div>
            {decisions.map((d) => (
              <div key={`${d.id}-${d.at}`} className="decision-row">
                <i className={d.allow ? "ph ph-check ok-c" : "ph ph-x err-c"} />
                <code className="pill">{d.tool}</code>
                <span className="when">
                  {threadOf(d.threadId)?.title ?? (d.threadId != null ? `thread ${d.threadId}` : "")} ·{" "}
                  {d.allow ? "allowed" : "denied"} · {hhmm(d.at)}
                </span>
              </div>
            ))}
            {decisions.length === 0 && (
              <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>
                Nothing decided since the daemon started.
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="panel">
            <div className="p-title">
              <i className="ph ph-shield-check" />
              Standing rules
            </div>
            <div className="note" style={{ marginTop: 0 }}>
              One-click "Allow + rule" auto-allowlists are planned — today every prompt is answered
              individually. Projects that should never prompt can switch to auto-approve in Settings →
              Approvals.
            </div>
          </div>
          <div className="panel">
            <div className="p-title">
              <i className="ph ph-timer" />
              Timeout
            </div>
            <div className="note" style={{ marginTop: 0 }}>
              A prompt that waits too long auto-denies (daemon default 5 min) so a run never wedges. The
              thread keeps running and can retry.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
