import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { log } from "./logger.js";
import { costFor, modelTier, totalTokens } from "./pricing.js";
import { readUsageEvents } from "./usage-log.js";
import { readBackfill } from "./usage-backfill.js";

const HTML_PATH = fileURLToPath(new URL("../public/dashboard.html", import.meta.url));

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WINDOWS = { "5h": 5 * HOUR, "24h": DAY, "7d": 7 * DAY, "30d": 30 * DAY };

const emptyAgg = () => ({
  cost: 0,
  tokens: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  runs: 0,
});

// Fold one record (bridge or backfill) into an accumulator. `cost` lets bridge
// records use the authoritative total_cost_usd from the CLI result event.
function add(acc, rec, cost) {
  acc.cost += cost;
  acc.tokens += totalTokens(rec);
  acc.input += rec.input_tokens || 0;
  acc.output += rec.output_tokens || 0;
  acc.cacheRead += rec.cache_read_input_tokens || 0;
  acc.cacheCreate += rec.cache_creation_input_tokens || 0;
  acc.runs += 1;
}

const round = (o) => {
  o.cost = Math.round(o.cost * 100) / 100;
  return o;
};

const localDay = (ts) => {
  const d = new Date(ts);
  // Local YYYY-MM-DD so day buckets line up with the user's calendar.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
};

function aggregate({ days }) {
  const now = Date.now();
  const backfillMs = days * DAY;
  const since = now - backfillMs;

  const backfill = readBackfill({ sinceTs: since });
  const bridge = readUsageEvents();

  // ── Plan-limit windows: account-wide, from the JSONL backfill ──────────────
  const windows = {};
  for (const key of Object.keys(WINDOWS)) windows[key] = emptyAgg();
  for (const r of backfill) {
    if (r.ts == null) continue;
    const cost = costFor(r.model, r);
    for (const [key, span] of Object.entries(WINDOWS)) {
      if (r.ts >= now - span) add(windows[key], r, cost);
    }
  }

  // ── Account-wide breakdowns (byModel / byProject / byDay / byHour) ─────────
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();
  const byHour = Array.from({ length: 24 }, () => emptyAgg());
  const accTotal = emptyAgg();

  for (const r of backfill) {
    const cost = costFor(r.model, r);
    add(accTotal, r, cost);

    const mk = r.model || "unknown";
    if (!byModel.has(mk)) byModel.set(mk, { model: mk, tier: modelTier(mk), ...emptyAgg() });
    add(byModel.get(mk), r, cost);

    const pk = r.project || "unknown";
    if (!byProject.has(pk)) byProject.set(pk, { project: pk, ...emptyAgg() });
    add(byProject.get(pk), r, cost);

    if (r.ts != null) {
      const dk = localDay(r.ts);
      if (!byDay.has(dk)) byDay.set(dk, { date: dk, ...emptyAgg() });
      add(byDay.get(dk), r, cost);
      add(byHour[new Date(r.ts).getHours()], r, cost);
    }
  }

  // ── Bridge attribution: per channel, per source/team-lead ─────────────────
  const byChannel = new Map();
  const bySource = new Map();
  const bridgeTotal = emptyAgg();
  const bridgeCost = (r) =>
    typeof r.cost_usd === "number" ? r.cost_usd : costFor(r.model, r);

  for (const r of bridge) {
    if (r.ts != null && r.ts < since) continue;
    const cost = bridgeCost(r);
    add(bridgeTotal, r, cost);

    const ck = r.channelId || "unknown";
    if (!byChannel.has(ck))
      byChannel.set(ck, {
        channelId: ck,
        channelName: r.channelName || null,
        ...emptyAgg(),
      });
    const chan = byChannel.get(ck);
    if (!chan.channelName && r.channelName) chan.channelName = r.channelName;
    add(chan, r, cost);

    const sk = r.source || "chat";
    if (!bySource.has(sk)) bySource.set(sk, { source: sk, ...emptyAgg() });
    add(bySource.get(sk), r, cost);
  }

  // Dense day series across the whole window (fill gaps with zeros).
  const daySeries = [];
  for (let t = now - backfillMs + DAY; t <= now + DAY; t += DAY) {
    const dk = localDay(t);
    daySeries.push(round(byDay.get(dk) || { date: dk, ...emptyAgg() }));
  }

  const byCost = (a, b) => b.cost - a.cost;
  return {
    generatedAt: new Date().toISOString(),
    days,
    windows: Object.fromEntries(
      Object.entries(windows).map(([k, v]) => [k, round(v)])
    ),
    limits: {
      usd5h: config.dashboard.limitUsd5h,
      usd7d: config.dashboard.limitUsd7d,
      tokens5h: config.dashboard.limitTokens5h,
      tokens7d: config.dashboard.limitTokens7d,
    },
    account: {
      total: round(accTotal),
      byModel: [...byModel.values()].map(round).sort(byCost),
      byProject: [...byProject.values()].map(round).sort(byCost).slice(0, 25),
      byDay: daySeries,
      byHour: byHour.map((h, hour) => round({ hour, ...h })),
    },
    bridge: {
      total: round(bridgeTotal),
      byChannel: [...byChannel.values()].map(round).sort(byCost),
      bySource: [...bySource.values()].map(round).sort(byCost),
    },
  };
}

export function startDashboard() {
  const { port } = config.dashboard;
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      if (url.pathname === "/api/usage") {
        const days = Math.max(
          1,
          Math.min(365, Number(url.searchParams.get("days")) || config.dashboard.backfillDays)
        );
        const body = JSON.stringify(aggregate({ days }));
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(HTML_PATH));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    } catch (err) {
      log.error("[dashboard] request failed:", err.message);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal error");
    }
  });
  server.listen(port, "127.0.0.1", () => {
    log.info(`[dashboard] http://localhost:${port}`);
  });
  return () => server.close();
}

// Run standalone: `node src/dashboard.js` / `npm run dashboard`.
if (import.meta.url === `file://${process.argv[1]}`) {
  startDashboard();
}
