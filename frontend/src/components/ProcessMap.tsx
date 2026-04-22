import { useMemo } from "react";
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  type Edge,
  type Node,
  type NodeProps,
  Handle,
  Position,
} from "reactflow";
import dagre from "dagre";
import type { ProcessGraph } from "../api";

function LocNode({ data }: NodeProps<{ label: string; count: number; avg: number | null }>) {
  return (
    <div className="rounded-xl border border-brand-500/30 bg-slate-900/90 backdrop-blur px-3 py-2 shadow-glow min-w-[160px]">
      <Handle type="target" position={Position.Left} className="!bg-brand-500" />
      <div className="text-[11px] uppercase tracking-wider text-brand-300 truncate">
        {data.label}
      </div>
      <div className="flex items-baseline justify-between gap-3 mt-1">
        <span className="text-base font-semibold text-slate-100">
          {data.count.toLocaleString("fr-FR")}
        </span>
        <span className="text-[11px] text-slate-400">
          {data.avg != null ? `${Math.round(data.avg)} min` : "—"}
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-brand-500" />
    </div>
  );
}

const nodeTypes = { loc: LocNode };

function layout(nodes: Node[], edges: Edge[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 30, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  nodes.forEach((n) => g.setNode(n.id, { width: 200, height: 70 }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - 100, y: p.y - 35 } };
  });
}

export function ProcessMap({ graph }: { graph: ProcessGraph }) {
  const { nodes, edges } = useMemo(() => {
    const maxCount = Math.max(1, ...graph.edges.map((e) => e.count));
    const rawNodes: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: "loc",
      position: { x: 0, y: 0 },
      data: { label: n.label, count: n.count, avg: n.avg_duration_min },
    }));
    const rawEdges: Edge[] = graph.edges.map((e, i) => {
      const t = e.count / maxCount;
      const width = 1 + t * 5;
      return {
        id: `e${i}`,
        source: e.source,
        target: e.target,
        animated: t > 0.35,
        style: {
          stroke: `rgba(34, 211, 238, ${0.2 + t * 0.6})`,
          strokeWidth: width,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: "#22d3ee" },
        label: e.count > maxCount * 0.1 ? `${e.count}` : undefined,
        labelStyle: { fill: "#94a3b8", fontSize: 10 },
        labelBgStyle: { fill: "#0f172a", opacity: 0.7 },
      };
    });
    return { nodes: layout(rawNodes, rawEdges), edges: rawEdges };
  }, [graph]);

  return (
    <div className="h-[620px] rounded-xl overflow-hidden border border-slate-800/70 bg-slate-950/60">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background color="#1e293b" gap={24} />
        <Controls
          className="!bg-slate-900 !border-slate-700 [&>button]:!bg-slate-900 [&>button]:!border-slate-700 [&>button]:!text-slate-200"
        />
      </ReactFlow>
    </div>
  );
}
