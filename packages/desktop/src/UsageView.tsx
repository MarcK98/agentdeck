import { Fragment, useCallback, useEffect, useState } from "react";
import type { UsageSummary } from "./types";

// Usage (design 3d): tokens over time, split by model and project, live
// sessions with context size + per-thread session reset. All from the
// daemon's usage ledger (getUsage) — exact attribution, not estimates.

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

// Sub-day ranges (hour-scale) carry fractional `days`; the daemon adapts the
// series bucket size (5-min / 15-min bars) so short windows still show a shape.
const RANGES: { label: string; days: number }[] = [
  { label: "1h", days: 1 / 24 },
  { label: "2h", days: 2 / 24 },
  { label: "4h", days: 4 / 24 },
  { label: "5h", days: 5 / 24 },
  { label: "Today", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

export default function UsageView() {
  const [days, setDays] = useState(1 / 24);
  const [u, setU] = useState<UsageSummary | null>(null);

  const refresh = useCallback(() => {
    window.spawn.getUsage(days).then(setU).catch(() => {});
  }, [days]);

  useEffect(refresh, [refresh]);
  useEffect(() => {
    return window.spawn.onEvent((ev) => {
      if (ev.type === "turn:done") refresh();
    });
  }, [refresh]);

  const maxSeries = u ? Math.max(...u.series.map((s) => s.tokens), 1) : 1;
  const maxProject = u ? Math.max(...u.byProject.map((p) => p.tokens), 1) : 1;
  const totalModel = u ? Math.max(u.byModel.reduce((a, m) => a + m.tokens, 0), 1) : 1;

  return (
    <div className="view">
      <div className="view-head">
        <h4>Usage</h4>
        <span className="sub">all projects · exact ledger attribution</span>
        <span className="spacer" />
        <span className="range-seg">
          {RANGES.map((r) => (
            <button key={r.days} className={days === r.days ? "on" : ""} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </span>
      </div>
      <div className="usage-body">
        <div className="usage-grid">
          <div className="panel">
            <div className="headline">
              <span className="big">{u ? `${fmt(u.totalTokens)}` : "—"}</span>
              <span className="sub">
                {u ? `tokens · ${u.turns} turns · ${u.threads} threads · $${u.totalCost.toFixed(2)}` : ""}
              </span>
            </div>
            {u && u.series.length > 0 && (
              <>
                <svg width="100%" height="140" viewBox="0 0 760 140" preserveAspectRatio="none" style={{ marginTop: 12 }}>
                  <line x1="0" y1="139" x2="760" y2="139" stroke="var(--color-neutral-800)" strokeWidth="1" />
                  {u.series.map((s, i) => {
                    const w = Math.max(760 / u.series.length - 6, 6);
                    const x = (i / u.series.length) * 760 + 3;
                    const h = Math.max((s.tokens / maxSeries) * 115, 2);
                    const last = i === u.series.length - 1;
                    return (
                      <rect
                        key={s.ts}
                        x={x}
                        y={139 - h}
                        width={w}
                        height={h}
                        rx="2"
                        fill={last ? "var(--color-accent-500)" : "var(--color-accent-700)"}
                      >
                        <title>{`${new Date(s.ts).toLocaleString()} — ${fmt(s.tokens)} tok`}</title>
                      </rect>
                    );
                  })}
                </svg>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 10,
                    color: "var(--color-neutral-600)",
                    marginTop: 4,
                  }}
                >
                  <span>
                    {u.series.length > 0
                      ? new Date(u.series[0].ts).toLocaleString(undefined, days <= 1 ? { hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" })
                      : ""}
                  </span>
                  <span>now</span>
                </div>
              </>
            )}
            {u && u.series.length === 0 && (
              <div style={{ color: "var(--color-neutral-600)", fontSize: 12, marginTop: 12 }}>
                No runs recorded in this window.
              </div>
            )}
          </div>

          <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <div style={{ font: "500 13px var(--font-heading)" }}>By model</div>
            {u?.byModel.map((m) => (
              <div key={m.model} className="model-row">
                <div className="lbl">
                  <span>{m.model}</span>
                  <span>
                    {fmt(m.tokens)} · {Math.round((m.tokens / totalModel) * 100)}%
                  </span>
                </div>
                <div className="bar" style={{ height: 4 }}>
                  <span style={{ width: `${(m.tokens / totalModel) * 100}%` }} />
                </div>
              </div>
            ))}
            {(!u || u.byModel.length === 0) && (
              <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>No runs yet.</span>
            )}
          </div>
        </div>

        <div className="usage-grid">
          <div className="panel">
            <div style={{ font: "500 13px var(--font-heading)", marginBottom: 8 }}>By project</div>
            <div className="by-project">
              <span className="th">project</span>
              <span className="th r">threads</span>
              <span className="th r">turns</span>
              <span className="th r">tokens</span>
              <span />
              {u?.byProject.map((p) => (
                <Fragment key={p.project}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span className="chip" style={{ background: "var(--color-accent-500)" }} />
                    {p.project}
                  </span>
                  <span className="r">{p.threads}</span>
                  <span className="r">{p.turns}</span>
                  <span className="r">{fmt(p.tokens)}</span>
                  <span className="bar" style={{ height: 4 }}>
                    <span style={{ width: `${(p.tokens / maxProject) * 100}%` }} />
                  </span>
                </Fragment>
              ))}
            </div>
            {(!u || u.byProject.length === 0) && (
              <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>Nothing in this window.</span>
            )}
          </div>

          <div className="panel" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ font: "500 13px var(--font-heading)" }}>Live sessions</div>
            {u?.sessions.map((s) => (
              <div key={s.threadId} className="sess-row">
                <div className="lbl">
                  {s.running && <span className="dot-live pulse" />}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.kind === "teamlead" ? "team lead" : s.title}
                  </span>
                  <span className="r">
                    {s.contextTokens != null ? `${fmt(s.contextTokens)} ctx` : "no context yet"}
                    {s.model ? ` · ${s.model}` : ""}
                  </span>
                  <button
                    className="reset"
                    title="Reset this thread's session (fresh context next turn)"
                    onClick={() => window.spawn.resetThreadSession(s.threadId).then(refresh)}
                  >
                    <i className="ph ph-arrow-counter-clockwise" />
                  </button>
                </div>
                {s.contextTokens != null && (
                  <div className="bar">
                    <span style={{ width: `${Math.min((s.contextTokens / 200_000) * 100, 100)}%` }} />
                  </div>
                )}
              </div>
            ))}
            {(!u || u.sessions.length === 0) && (
              <span style={{ fontSize: 12, color: "var(--color-neutral-600)" }}>No live sessions.</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
