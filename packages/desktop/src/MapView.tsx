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

// Live map (Phase 4) — React Flow over the Phase 2-3 model: team-lead →
// projects → active threads, with each thread node wearing its isolation /
// process / PR / cost state as live badges. Data is one getMap() pull;
// it re-pulls on thread lifecycle events plus a slow interval (PR checks and
// git state drift outside daemon events). Click a thread → jump to it.

const POLL_MS = 20_000;

// Column layout: simple layered graph, no layout lib — three fixed columns,
// threads stacked per project, each project centered on its thread block.
const COL_X = { teamlead: 0, project: 240, thread: 500 } as const;
const THREAD_H = 96;
const PROJECT_H = 44;
const GAP = 14;
const BLOCK_GAP = 28;

type TeamLeadNodeData = { label: string; onOpen: () => void };
type ProjectNodeData = { name: string; dir: string; isTeamLead: boolean; onOpen: () => void };
type ThreadNodeData = { thread: MapThread; onOpen: () => void };

function TeamLeadNodeView({ data }: NodeProps<Node<TeamLeadNodeData, "teamlead">>) {
  return (
    <div className="map-node map-teamlead" onClick={data.onOpen}>
      🧭 {data.label}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ProjectNodeView({ data }: NodeProps<Node<ProjectNodeData, "project">>) {
  return (
    <div className="map-node map-project" onClick={data.onOpen} title={data.dir}>
      <Handle type="target" position={Position.Left} />
      {data.name}
      {data.isTeamLead && <span className="badge">team lead</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function ThreadNodeView({ data }: NodeProps<Node<ThreadNodeData, "thread">>) {
  const t = data.thread;
  return (
    <div className={`map-node map-thread ${t.running ? "running" : ""}`} onClick={data.onOpen}>
      <Handle type="target" position={Position.Left} />
      <div className="map-thread-title">
        <span className={t.running ? "dot in-progress" : `dot ${t.status}`} />
        {t.title}
      </div>
      <div className="map-badges">
        <span className="badge">{t.kind}</span>
        {t.branch && (
          <span className="badge" title={t.worktreePath ?? ""}>
            ⎇ {t.branch.replace(/^ticket\//, "")}
          </span>
        )}
        {t.dirty != null && t.dirty > 0 && <span className="badge warn">±{t.dirty}</span>}
        {t.running && <span className="badge run">pid {t.pid}</span>}
        {t.model && t.running && <span className="badge">{t.model}</span>}
      </div>
      <div className="map-badges">
        {t.pr ? (
          <a
            className={`badge pr ${t.pr.state.toLowerCase()}`}
            href={t.pr.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            PR #{t.pr.number} {t.pr.state.toLowerCase()}
            {t.pr.checks ? ` · ${t.pr.checks}` : ""}
          </a>
        ) : (
          <span className="badge dim">no PR</span>
        )}
        {t.turns > 0 && <span className="badge dim">${t.costUsd.toFixed(2)}</span>}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  teamlead: TeamLeadNodeView,
  project: ProjectNodeView,
  thread: ThreadNodeView,
};

// Pure data → graph. Exported for tests; no React Flow types leak out of the
// node/edge shells.
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
        onOpen: () => handlers.onOpenProject(p.id),
      },
    });
    if (map.teamLeadProjectId != null) {
      edges.push({
        id: `e-tl-p${p.id}`,
        source: "tl",
        target: `p${p.id}`,
        animated: threads.some((t) => t.running),
      });
    }
    y = Math.max(y, blockStart + blockH + GAP) + BLOCK_GAP - GAP;
  }

  if (map.teamLeadProjectId != null) {
    const tlName =
      map.projects.find((p) => p.id === map.teamLeadProjectId)?.name ?? "Team lead";
    nodes.push({
      id: "tl",
      type: "teamlead",
      position: { x: COL_X.teamlead, y: Math.max(y - BLOCK_GAP, PROJECT_H) / 2 - PROJECT_H / 2 },
      data: { label: tlName, onOpen: handlers.onOpenTeamLead },
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
    window.spawn.getMap().then(setMap).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // PR checks / git state change outside daemon events — slow background poll.
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    return window.spawn.onEvent((ev) => {
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
    <main className="map">
      <div className="pane-head">
        <span>Live map</span>
        <button title="Refresh map" onClick={refresh}>
          ↻
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
            <Background gap={24} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
      )}
    </main>
  );
}
