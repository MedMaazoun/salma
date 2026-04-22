import { useMemo } from "react";
import type { Sankey as SankeyData } from "../api";

type Props = { data: SankeyData; height?: number };

type Node = {
  idx: number;
  label: string;
  layer: number;
  value: number;
  y: number;
  h: number;
};

type Link = {
  source: number;
  target: number;
  value: number;
  sy: number;
  ty: number;
  sh: number;
  th: number;
};

export function SankeyDiagram({ data, height = 440 }: Props) {
  const { nodes, links, width, nodeW } = useMemo(() => {
    const W = 960;
    const NW = 14;
    const H = height;
    const PAD = 10;
    const layers = Math.max(1, ...(data.layer || []).map((l) => l + 1));
    const layerX = (l: number) => (W - NW) * (layers > 1 ? l / (layers - 1) : 0);

    // Compute node totals (value = sum of outgoing or incoming, whichever bigger)
    const outByNode = new Map<number, number>();
    const inByNode = new Map<number, number>();
    data.source.forEach((s, i) => {
      outByNode.set(s, (outByNode.get(s) ?? 0) + data.value[i]);
      inByNode.set(data.target[i], (inByNode.get(data.target[i]) ?? 0) + data.value[i]);
    });

    // Group nodes by layer
    const byLayer: Record<number, number[]> = {};
    data.labels.forEach((_, idx) => {
      const l = data.layer[idx] ?? 0;
      (byLayer[l] ||= []).push(idx);
    });

    // Compute node heights
    const maxTotalPerLayer = Object.values(byLayer).map((ids) =>
      ids.reduce((a, id) => a + Math.max(outByNode.get(id) ?? 0, inByNode.get(id) ?? 0), 0)
    );
    const maxLayerTotal = Math.max(1, ...maxTotalPerLayer);

    const nodesOut: Node[] = [];
    for (const [lStr, ids] of Object.entries(byLayer)) {
      const l = Number(lStr);
      const totals = ids.map((id) =>
        Math.max(outByNode.get(id) ?? 0, inByNode.get(id) ?? 0)
      );
      // sort descending to top-pack
      const order = ids
        .map((id, i) => ({ id, v: totals[i] }))
        .sort((a, b) => b.v - a.v);
      const gap = 4;
      const availH = H - gap * Math.max(0, order.length - 1);
      const scale = (availH * 0.9) / maxLayerTotal;
      let y = 0;
      for (const { id, v } of order) {
        const h = Math.max(4, v * scale);
        nodesOut.push({ idx: id, label: data.labels[id], layer: l, value: v, y, h });
        y += h + gap;
      }
    }

    const nodeMap = new Map<number, Node>();
    nodesOut.forEach((n) => nodeMap.set(n.idx, n));

    // Compute link positions
    const srcOffset = new Map<number, number>();
    const tgtOffset = new Map<number, number>();
    // Order links by source node y, then by target node y
    const linkIdxs = data.source.map((_, i) => i);
    linkIdxs.sort((a, b) => {
      const na = nodeMap.get(data.source[a])!;
      const nb = nodeMap.get(data.source[b])!;
      if (na.y !== nb.y) return na.y - nb.y;
      const ta = nodeMap.get(data.target[a])!;
      const tb = nodeMap.get(data.target[b])!;
      return ta.y - tb.y;
    });
    const linksOut: Link[] = [];
    // Scale link heights proportional to node values
    // Use same scale as node (approx)
    const linkScale = (maxLayerTotal > 0 ? H * 0.9 / maxLayerTotal : 1);
    for (const i of linkIdxs) {
      const sNode = nodeMap.get(data.source[i])!;
      const tNode = nodeMap.get(data.target[i])!;
      const h = Math.max(1, data.value[i] * linkScale);
      const so = srcOffset.get(sNode.idx) ?? 0;
      const to = tgtOffset.get(tNode.idx) ?? 0;
      linksOut.push({
        source: sNode.idx,
        target: tNode.idx,
        value: data.value[i],
        sy: sNode.y + so,
        ty: tNode.y + to,
        sh: h,
        th: h,
      });
      srcOffset.set(sNode.idx, so + h);
      tgtOffset.set(tNode.idx, to + h);
    }

    // re-assign nodes x via layerX
    nodesOut.forEach((n) => ((n as Node & { x?: number }).x = layerX(n.layer) + PAD));

    return { nodes: nodesOut, links: linksOut, width: W + PAD * 2, nodeW: NW };
  }, [data, height]);

  const layerX = (l: number) => {
    const layers = Math.max(1, ...(data.layer || []).map((ll) => ll + 1));
    const W = 960;
    return (W - nodeW) * (layers > 1 ? l / (layers - 1) : 0) + 10;
  };

  const palette = ["#22d3ee", "#38bdf8", "#818cf8", "#a78bfa", "#f472b6"];

  return (
    <div className="overflow-x-auto">
      <svg width={width} height={height + 40} className="block">
        <defs>
          {links.map((l, i) => (
            <linearGradient key={i} id={`sgrad-${i}`} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={palette[l.source % palette.length]} stopOpacity="0.55" />
              <stop offset="100%" stopColor={palette[l.target % palette.length]} stopOpacity="0.55" />
            </linearGradient>
          ))}
        </defs>

        {links.map((l, i) => {
          const sx = layerX(nodes.find((n) => n.idx === l.source)!.layer) + nodeW;
          const tx = layerX(nodes.find((n) => n.idx === l.target)!.layer);
          const sy = l.sy + l.sh / 2;
          const ty = l.ty + l.th / 2;
          const midX = (sx + tx) / 2;
          const d = `M${sx},${sy} C${midX},${sy} ${midX},${ty} ${tx},${ty}`;
          return (
            <path
              key={i}
              d={d}
              stroke={`url(#sgrad-${i})`}
              strokeWidth={Math.max(1, (l.sh + l.th) / 2)}
              fill="none"
              opacity={0.8}
            >
              <title>
                {data.labels[l.source]} → {data.labels[l.target]}: {l.value}
              </title>
            </path>
          );
        })}

        {nodes.map((n) => {
          const x = layerX(n.layer);
          const color = palette[n.idx % palette.length];
          return (
            <g key={n.idx}>
              <rect x={x} y={n.y} width={nodeW} height={n.h} fill={color} rx={3} />
              <text
                x={n.layer === 0 ? x + nodeW + 6 : x - 6}
                y={n.y + n.h / 2}
                fill="#cbd5e1"
                fontSize={11}
                dominantBaseline="middle"
                textAnchor={n.layer === 0 ? "start" : "end"}
              >
                {n.label.length > 24 ? n.label.slice(0, 22) + "…" : n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
