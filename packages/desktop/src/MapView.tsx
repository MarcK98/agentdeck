import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { MapData, MapThread } from "./types";

// Live map — React Flow over team-lead → projects → active threads, restyled
// to Nocturne (design 1c's node language: section-indigo lead node, surface
// cards with pulse dots and badge rows). Same data/refresh contract as
// before: getMap on thread lifecycle events + a slow poll for PR/git drift.

const POLL_MS = 20_000;
const COL_X = { teamlead: 0, project: 260, thread: 540 } as const;
const THREAD_H = 104;
const PROJECT_H = 44;
const GAP = 14;
const BLOCK_GAP = 28;

type TeamLeadNodeData = { label: string; liveCount: number; onOpen: () => void };
type ProjectNodeData = { name: string; dir: string; isTeamLead: boolean; liveCount: number; onOpen: () => void };
type ThreadNodeData = { thread: MapThread; onOpen: () => void };

function TeamLeadNodeView({ data }: NodeProps<Node<TeamLeadNodeData, "teamlead">>) {
  return (
    <div className="map-node map-teamlead" onClick={data.onOpen}>
      <i className="ph ph-compass" />
      {data.label}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ProjectNodeView({ data }: NodeProps<Node<ProjectNodeData, "project">>) {
  return (
    <div className="map-node map-project" onClick={data.onOpen} title={data.dir}>
      <Handle type="target" position={Position.Left} />
      <span className="chip" style={{ background: "var(--color-accent-500)" }} />
      {data.name}
      {data.liveCount > 0 && (
        <span className="ok-c" style={{ marginLeft: "auto", fontSize: 10.5 }}>
          ● {data.liveCount}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ThreadNodeView({ data }: NodeProps<Node<ThreadNodeData, "thread">>) {
  const t = data.thread;
  return (
    <div className={`map-node map-thread ${t.running ? "running" : ""}`} onClick={data.onOpen}>
      <Handle type="target" position={Position.Left} />
      <div className="t">
        {t.running ? <span className="dot-live pulse" /> : <span className="dot-idle" />}
        <span className="ell">{t.title}</span>
      </div>
      <div className="tags">
        {t.branch && (
          <span className="tag tag-outline" title={t.worktreePath ?? ""}>
            <i className="ph ph-git-branch" style={{ marginRight: 3 }} />
            {t.branch.replace(/^ticket\//, "")}
          </span>
        )}
        {t.running && t.model && <span className="tag tag-accent">{t.model}</span>}
        {t.dirty != null && t.dirty > 0 && <span className="tag tag-neutral warn-c">±{t.dirty}</span>}
        {t.turns > 0 && <span className="tag tag-neutral">${t.costUsd.toFixed(2)}</span>}
      </div>
      <div className="tags">
        {t.pr ? (
          <a
            className={`tag tag-outline ${t.pr.state === "OPEN" ? "ok-c" : t.pr.state === "MERGED" ? "" : "err-c"}`}
            href={t.pr.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            <i className="ph ph-git-pull-request" style={{ marginRight: 3 }} />#{t.pr.number}{" "}
            {t.pr.state.toLowerCase()}
            {t.pr.checks ? ` · ${t.pr.checks}` : ""}
          </a>
        ) : (
          <span style={{ fontSize: 10.5, color: "var(--color-neutral-600)" }}>no PR</span>
        )}
        {t.running && (
          <span style={{ fontSize: 10.5, color: "oklch(0.72 0.1 150)", marginLeft: "auto" }}>pid {t.pid}</span>
        )}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  teamlead: TeamLeadNodeView,
  project: ProjectNodeView,
  thread: ThreadNodeView,
};

export function buildGraph(
  map: MapData,
  handlers: {
    onOpenTeamLead: () => void;
    onOpenProject: (projectId: number) => void;
    onOpenThread: (projectId: number, threadId: number) => void;
  }
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let y = 0;

  for (const p of map.projects) {
    // The team-lead home renders as the root node, not a second project box —
    // its threads (the console) hang off the root directly.
    if (p.id === map.teamLeadProjectId) {
      for (const t of map.threads.filter((x) => x.projectId === p.id)) {
        nodes.push({
          id: `t${t.id}`,
          type: "thread",
          position: { x: COL_X.thread, y },
          data: { thread: t, onOpen: () => handlers.onOpenThread(t.projectId, t.id) },
        });
        edges.push({
          id: `e-tl-t${t.id}`,
          source: "tl",
          target: `t${t.id}`,
          animated: t.running,
          style: { stroke: "var(--color-accent-700)" },
        });
        y += THREAD_H + GAP;
      }
      continue;
    }
    const threads = map.threads.filter((t) => t.projectId === p.id);
    const blockStart = y;
    for (const t of threads) {
      nodes.push({
        id: `t${t.id}`,
        type: "thread",
        position: { x: COL_X.thread, y },
        data: { thread: t, onOpen: () => handlers.onOpenThread(t.projectId, t.id) },
      });
      edges.push({
        id: `e-p${p.id}-t${t.id}`,
        source: `p${p.id}`,
        target: `t${t.id}`,
        animated: t.running,
        style: t.running ? { stroke: "oklch(0.55 0.07 150)" } : { stroke: "var(--color-neutral-800)" },
      });
      y += THREAD_H + GAP;
    }
    const blockH = Math.max(y - blockStart - GAP, PROJECT_H);
    nodes.push({
      id: `p${p.id}`,
      type: "project",
      position: { x: COL_X.project, y: blockStart + blockH / 2 - PROJECT_H / 2 },
      data: {
        name: p.name,
        dir: p.dir,
        isTeamLead: p.id === map.teamLeadProjectId,
        liveCount: threads.filter((t) => t.running).length,
        onOpen: () => handlers.onOpenProject(p.id),
      },
    });
    if (map.teamLeadProjectId != null) {
      edges.push({
        id: `e-tl-p${p.id}`,
        source: "tl",
        target: `p${p.id}`,
        animated: threads.some((t) => t.running),
        style: { stroke: "var(--color-accent-700)" },
      });
    }
    y = Math.max(y, blockStart + blockH + GAP) + BLOCK_GAP - GAP;
  }

  if (map.teamLeadProjectId != null) {
    const tlName = map.projects.find((p) => p.id === map.teamLeadProjectId)?.name ?? "Team lead";
    nodes.push({
      id: "tl",
      type: "teamlead",
      position: { x: COL_X.teamlead, y: Math.max(y - BLOCK_GAP, PROJECT_H) / 2 - PROJECT_H / 2 },
      data: {
        label: tlName,
        liveCount: map.threads.filter((t) => t.running).length,
        onOpen: handlers.onOpenTeamLead,
      },
    });
  }

  return { nodes, edges };
}

export default function MapView({
  onOpenTeamLead,
  onOpenProject,
  onOpenThread,
}: {
  onOpenTeamLead: () => void;
  onOpenProject: (projectId: number) => void;
  onOpenThread: (projectId: number, threadId: number) => void;
}) {
  const [map, setMap] = useState<MapData | null>(null);

  const refresh = useCallback(() => {
    window.agentdeck.getMap().then(setMap).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Poll only while the window is actually visible — a hidden window
    // shouldn't keep hitting the daemon every 20s.
    const tick = () => {
      if (!document.hidden) refresh();
    };
    const timer = setInterval(tick, POLL_MS);
    const onVis = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  useEffect(() => {
    return window.agentdeck.onEvent((ev) => {
      if (
        ev.type === "thread:created" ||
        ev.type === "thread:updated" ||
        ev.type === "turn:start" ||
        ev.type === "turn:done"
      ) {
        refresh();
      }
    });
  }, [refresh]);

  const graph = useMemo(
    () => (map ? buildGraph(map, { onOpenTeamLead, onOpenProject, onOpenThread }) : null),
    [map, onOpenTeamLead, onOpenProject, onOpenThread]
  );

  return (
    <div className="map-view">
      <div className="view-head" style={{ padding: 0 }}>
        <h4>Live map</h4>
        <span className="sub">team lead → projects → running threads · click a node to jump</span>
        <span className="spacer" />
        <button className="btn btn-secondary small-btn" onClick={refresh}>
          <i className="ph ph-arrows-clockwise" /> Refresh
        </button>
      </div>
      {!graph ? (
        <div className="empty">Loading map…</div>
      ) : graph.nodes.length === 0 ? (
        <div className="empty">Nothing on the map — no team lead configured and no active threads.</div>
      ) : (
        <div className="map-canvas">
          <ReactFlow
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            nodesDraggable
            nodesConnectable={false}
            colorMode="dark"
          >
            <Background gap={26} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </div>
  );
}
