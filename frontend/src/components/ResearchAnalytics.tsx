import { useState, useEffect, useRef } from "react";
import { Loader2, Activity, GitCommit, Users, ArrowLeftRight, Layers, TrendingDown, BarChart2 } from "lucide-react";
import {
  api,
  type ResearchData, type ResearchCluster,
  type BeforeAfterResult, type DecompResult, type KMResult, type FeatResult,
} from "../api";
import { useFilters } from "../FiltersContext";
import { useAssistant } from "../AssistantContext";

// ─── SPC computation ──────────────────────────────────────────────────────────

function computeSPC(counts: number[]) {
  const n    = counts.length;
  const mean = counts.reduce((s, v) => s + v, 0) / n;
  const sigma = Math.sqrt(
    counts.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(n - 1, 1)
  );
  const ucl = mean + 3 * sigma;
  const lcl = Math.max(0, mean - 3 * sigma);
  const u2  = mean + 2 * sigma;
  const l2  = Math.max(0, mean - 2 * sigma);

  // Standardized CUSUM: allowance k=0.5, decision interval H=5
  const k = 0.5, H = 5;
  let cp = 0, cn = 0;
  const cusumPos: number[] = [], cusumNeg: number[] = [];
  for (const v of counts) {
    const z = (v - mean) / Math.max(sigma, 0.001);
    cp = Math.max(0, cp + z - k);
    cn = Math.max(0, cn - z - k);
    cusumPos.push(cp);
    cusumNeg.push(cn);
  }

  const points = counts.map((v, i) => {
    const cusumSig    = cusumPos[i] > H || cusumNeg[i] > H;
    const shewhartSig = v > ucl || v < lcl;
    const warn        = !shewhartSig && ((v > u2 && v <= ucl) || (v < l2 && v >= lcl));
    return { v, i, status: (shewhartSig || cusumSig ? "signal" : warn ? "warning" : "ok") as "signal" | "warning" | "ok" };
  });

  const nSignals  = points.filter(p => p.status === "signal").length;
  const nWarnings = points.filter(p => p.status === "warning").length;
  return { mean, sigma, ucl, lcl, u2, l2, cusumPos, cusumNeg, H, points, nSignals, nWarnings };
}

// ─── Binary segmentation ──────────────────────────────────────────────────────

function binarySegmentation(data: number[], minLen = 7, maxBreaks = 4): number[] {
  function cost(arr: number[]): number {
    if (arr.length === 0) return 0;
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return arr.reduce((s, v) => s + (v - m) ** 2, 0);
  }
  const breaks: number[] = [];
  const segs: [number, number][] = [[0, data.length]];

  for (let iter = 0; iter < maxBreaks; iter++) {
    let bestGain = 0, bestBreak = -1, bestSi = -1;
    for (let si = 0; si < segs.length; si++) {
      const [s, e] = segs[si];
      if (e - s < 2 * minLen) continue;
      const base = cost(data.slice(s, e));
      for (let t = minLen; t <= e - s - minLen; t++) {
        const gain = base - cost(data.slice(s, s + t)) - cost(data.slice(s + t, e));
        if (gain > bestGain) { bestGain = gain; bestBreak = s + t; bestSi = si; }
      }
    }
    if (bestBreak < 0) break;
    breaks.push(bestBreak);
    const [s, e] = segs[bestSi];
    segs.splice(bestSi, 1, [s, bestBreak], [bestBreak, e]);
  }
  return breaks.sort((a, b) => a - b);
}

// ─── SvgTip helper ────────────────────────────────────────────────────────────

function SvgTip({ x, y, viewW, lines }: {
  x: number; y: number; viewW: number;
  lines: { text: string; color: string }[];
}) {
  const TW = 140, LH = 14, PAD = 6;
  const TH = lines.length * LH + PAD * 2;
  const tx = Math.min(Math.max(x - TW / 2, 4), viewW - TW - 4);
  const ty = y > TH + 16 ? y - TH - 10 : y + 14;
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect x={tx} y={ty} width={TW} height={TH} rx={5}
        fill="#0f172a" stroke="#334155" strokeWidth={1} fillOpacity={0.95} />
      {lines.map((l, i) => (
        <text key={i} x={tx + PAD} y={ty + PAD + LH * i + LH * 0.75}
          fontSize={9.5} fill={l.color}>{l.text}</text>
      ))}
    </g>
  );
}

// ─── Shewhart chart ───────────────────────────────────────────────────────────

function ShewhartChart({ daily }: { daily: { date: string; count: number }[] }) {
  const [hov, setHov] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (daily.length < 7) return (
    <div className="h-32 flex items-center justify-center text-slate-600 text-xs">
      Données insuffisantes (min 7 jours)
    </div>
  );

  const counts = daily.map(d => d.count);
  const spc    = computeSPC(counts);

  const W = 640, H = 180;
  const PL = 46, PR = 12, PT = 16, PB = 26;
  const cW = W - PL - PR, cH = H - PT - PB;
  const maxY = Math.max(spc.ucl * 1.08, ...counts);
  const toX  = (i: number) => PL + (i / Math.max(counts.length - 1, 1)) * cW;
  const toY  = (v: number) => PT + cH - (v / maxY) * cH;
  const yUCL = toY(spc.ucl), yLCL = toY(spc.lcl);
  const yU2  = toY(spc.u2),  yL2  = toY(spc.l2);
  const yMu  = toY(spc.mean);
  const labelStep = Math.max(1, Math.ceil(counts.length / 10));

  function onMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const el = svgRef.current; if (!el) return;
    const r  = el.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    setHov(Math.round(Math.max(0, Math.min((sx - PL) / cW, 1)) * (counts.length - 1)));
  }

  const controls = [
    { y: yUCL, c: "#f43f5e", label: `UCL ${spc.ucl.toFixed(0)}` },
    { y: yU2,  c: "#f59e0b", label: `+2σ ${spc.u2.toFixed(0)}` },
    { y: yMu,  c: "#22d3ee", label: `μ ${spc.mean.toFixed(0)}` },
    { y: yL2,  c: "#f59e0b", label: `-2σ ${spc.l2.toFixed(0)}` },
    { y: yLCL, c: "#f43f5e", label: `LCL ${spc.lcl.toFixed(0)}` },
  ];

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* zone fills */}
      <rect x={PL} y={PT}    width={cW} height={yUCL - PT}      fill="#f43f5e" fillOpacity={0.04} />
      <rect x={PL} y={yUCL}  width={cW} height={yU2 - yUCL}     fill="#f59e0b" fillOpacity={0.06} />
      <rect x={PL} y={yL2}   width={cW} height={yLCL - yL2}     fill="#f59e0b" fillOpacity={0.06} />
      <rect x={PL} y={yLCL}  width={cW} height={H - PB - yLCL}  fill="#f43f5e" fillOpacity={0.04} />

      {/* control lines */}
      {controls.map(({ y, c, label }, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={y} y2={y}
            stroke={c} strokeWidth={1} strokeDasharray="6,4" opacity={0.65} />
          <text x={W - PR - 2} y={y - 2} fontSize={7.5} fill={c} textAnchor="end" opacity={0.85}>
            {label}
          </text>
        </g>
      ))}

      {/* data line */}
      <polyline points={counts.map((v, i) => `${toX(i)},${toY(v)}`).join(" ")}
        fill="none" stroke="#475569" strokeWidth={1} opacity={0.5} />

      {/* dots */}
      {spc.points.map(({ v, i, status }) => {
        const color = status === "signal" ? "#f43f5e" : status === "warning" ? "#f59e0b" : "#22d3ee";
        const r     = status === "signal" ? 5 : status === "warning" ? 4 : 3;
        return (
          <circle key={i} cx={toX(i)} cy={toY(v)} r={hov === i ? r + 2 : r}
            fill={color} stroke="#0f172a" strokeWidth={1}
            style={status !== "ok" ? { filter: `drop-shadow(0 0 5px ${color})` } : undefined} />
        );
      })}

      {/* x labels */}
      {daily.map((d, i) => {
        if (i % labelStep !== 0 && i !== daily.length - 1) return null;
        return (
          <text key={i} x={toX(i)} y={H - 4} fontSize={7.5}
            fill={hov === i ? "#e2e8f0" : "#334155"} textAnchor="middle">
            {d.date.slice(5).replace("-", "/")}
          </text>
        );
      })}
      <text x={PL - 4} y={PT + 4}     fontSize={8} fill="#475569" textAnchor="end">{Math.round(maxY)}</text>
      <text x={PL - 4} y={H - PB + 4} fontSize={8} fill="#475569" textAnchor="end">0</text>

      {/* hover */}
      {hov !== null && (() => {
        const d = daily[hov]; const p = spc.points[hov];
        const hx = toX(hov), hy = toY(p.v);
        const color = p.status === "signal" ? "#f43f5e" : p.status === "warning" ? "#f59e0b" : "#22d3ee";
        return (
          <>
            <line x1={hx} x2={hx} y1={PT} y2={H - PB}
              stroke="#fff" strokeWidth={0.8} strokeDasharray="3,3" opacity={0.2} />
            <SvgTip x={hx} y={hy} viewW={W} lines={[
              { text: d.date.slice(5).replace("-", "/"), color: "#94a3b8" },
              { text: `Patients : ${p.v}`, color },
              { text: p.status === "signal" ? "⚠ Hors contrôle" : p.status === "warning" ? "⚡ Zone d'alerte" : "✓ Dans contrôle", color },
            ]} />
          </>
        );
      })()}

      <rect x={PL} y={PT} width={cW} height={cH} fill="transparent"
        onMouseMove={onMouseMove} onMouseLeave={() => setHov(null)} />
    </svg>
  );
}

// ─── CUSUM chart ──────────────────────────────────────────────────────────────

function CusumChart({ daily }: { daily: { date: string; count: number }[] }) {
  if (daily.length < 7) return null;
  const counts = daily.map(d => d.count);
  const { cusumPos, cusumNeg, H } = computeSPC(counts);

  const W = 640, Ht = 110;
  const PL = 46, PR = 12, PT = 12, PB = 22;
  const cW = W - PL - PR, cH = Ht - PT - PB;
  const mid  = PT + cH / 2;
  const maxY = Math.max(...cusumPos, ...cusumNeg, H + 0.5);
  const toX  = (i: number) => PL + (i / Math.max(counts.length - 1, 1)) * cW;
  const toYp = (v: number) => mid - (v / maxY) * (cH / 2);
  const toYn = (v: number) => mid + (v / maxY) * (cH / 2);
  const yH_t = toYp(H), yH_b = toYn(H);

  const pathP = cusumPos.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toYp(v).toFixed(1)}`).join(" ");
  const areaP = `${pathP} L${toX(counts.length - 1)},${mid} L${PL},${mid}Z`;
  const pathN = cusumNeg.map((v, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toYn(v).toFixed(1)}`).join(" ");
  const areaN = `${pathN} L${toX(counts.length - 1)},${mid} L${PL},${mid}Z`;

  return (
    <svg viewBox={`0 0 ${W} ${Ht}`} className="w-full h-auto">
      {/* decision interval */}
      <line x1={PL} x2={W - PR} y1={yH_t} y2={yH_t} stroke="#f43f5e" strokeWidth={1} strokeDasharray="5,4" opacity={0.6} />
      <line x1={PL} x2={W - PR} y1={yH_b} y2={yH_b} stroke="#f43f5e" strokeWidth={1} strokeDasharray="5,4" opacity={0.6} />
      <line x1={PL} x2={W - PR} y1={mid}  y2={mid}  stroke="#334155" strokeWidth={1} />
      <text x={W - PR - 2} y={yH_t - 2} fontSize={7.5} fill="#f43f5e" textAnchor="end" opacity={0.8}>H = {H}</text>

      {/* areas */}
      <path d={areaP} fill="#34d399" fillOpacity={0.15} />
      <path d={areaN} fill="#f43f5e" fillOpacity={0.15} />
      <path d={pathP} fill="none" stroke="#34d399" strokeWidth={1.5} />
      <path d={pathN} fill="none" stroke="#f43f5e" strokeWidth={1.5} />

      {/* signal markers */}
      {cusumPos.map((v, i) => v > H ? (
        <circle key={`p${i}`} cx={toX(i)} cy={toYp(v)} r={4}
          fill="#34d399" stroke="#0f172a" strokeWidth={1}
          style={{ filter: "drop-shadow(0 0 5px #34d399)" }} />
      ) : null)}
      {cusumNeg.map((v, i) => v > H ? (
        <circle key={`n${i}`} cx={toX(i)} cy={toYn(v)} r={4}
          fill="#f43f5e" stroke="#0f172a" strokeWidth={1}
          style={{ filter: "drop-shadow(0 0 5px #f43f5e)" }} />
      ) : null)}

      <text x={PL - 4} y={PT + 10} fontSize={7} fill="#34d399" textAnchor="end">C+</text>
      <text x={PL - 4} y={Ht - PB + 6} fontSize={7} fill="#f43f5e" textAnchor="end">C–</text>
    </svg>
  );
}

// ─── Breakpoint chart ─────────────────────────────────────────────────────────

const SEG_FILLS = ["#22d3ee14", "#818cf814", "#34d39914", "#f59e0b14", "#f43f5e14"];

function BreakpointChart({ daily }: { daily: { date: string; count: number }[] }) {
  const [hov, setHov] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (daily.length < 14) return (
    <div className="h-32 flex items-center justify-center text-slate-600 text-xs">
      Données insuffisantes (min 14 jours)
    </div>
  );

  const counts = daily.map(d => d.count);
  const breaks = binarySegmentation(counts);
  const bps    = [0, ...breaks, counts.length];

  const W = 640, H = 190;
  const PL = 46, PR = 12, PT = 20, PB = 26;
  const cW = W - PL - PR, cH = H - PT - PB;
  const maxY = Math.max(...counts) * 1.1;
  const toX  = (i: number) => PL + (i / Math.max(counts.length - 1, 1)) * cW;
  const toY  = (v: number) => PT + cH - (v / maxY) * cH;
  const labelStep = Math.max(1, Math.ceil(counts.length / 10));

  function onMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const el = svgRef.current; if (!el) return;
    const r  = el.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * W;
    setHov(Math.round(Math.max(0, Math.min((sx - PL) / cW, 1)) * (counts.length - 1)));
  }

  // Segment stats for comparison cards
  const segStats = bps.slice(0, -1).map((start, si) => {
    const end  = bps[si + 1];
    const seg  = counts.slice(start, end);
    const mean = seg.reduce((s, v) => s + v, 0) / seg.length;
    const prev = si > 0
      ? counts.slice(bps[si - 1], start).reduce((s, v) => s + v, 0) / (start - bps[si - 1])
      : null;
    const delta    = prev != null ? mean - prev : null;
    const deltaPct = prev != null && prev > 0 ? (delta! / prev) * 100 : null;
    return { si, start, end, mean, delta, deltaPct };
  });

  return (
    <>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
        {/* segment backgrounds */}
        {bps.slice(0, -1).map((start, si) => {
          const end = bps[si + 1];
          return (
            <rect key={si}
              x={toX(start)} y={PT} width={toX(end - 1) - toX(start)} height={cH}
              fill={SEG_FILLS[si % SEG_FILLS.length]} />
          );
        })}

        {/* grid lines */}
        {[0.25, 0.5, 0.75, 1].map((f, i) => (
          <line key={i} x1={PL} x2={W - PR}
            y1={PT + cH * (1 - f)} y2={PT + cH * (1 - f)}
            stroke="#1e293b" strokeWidth={1} />
        ))}

        {/* segment mean lines */}
        {segStats.map(({ si, start, end, mean }) => (
          <line key={si}
            x1={toX(start)} x2={toX(end - 1)} y1={toY(mean)} y2={toY(mean)}
            stroke="#e2e8f0" strokeWidth={1.5} strokeDasharray="6,3" opacity={0.65} />
        ))}

        {/* data line */}
        <polyline points={counts.map((v, i) => `${toX(i)},${toY(v)}`).join(" ")}
          fill="none" stroke="#22d3ee" strokeWidth={1.5}
          style={{ filter: "drop-shadow(0 0 3px #22d3ee)" }} />

        {/* breakpoint lines + date labels */}
        {breaks.map((bp, i) => (
          <g key={i}>
            <line x1={toX(bp)} x2={toX(bp)} y1={PT} y2={H - PB}
              stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,3" opacity={0.85} />
            <text x={toX(bp)} y={PT - 4} fontSize={7.5} fill="#f59e0b" textAnchor="middle">
              {daily[bp]?.date.slice(5).replace("-", "/")}
            </text>
          </g>
        ))}

        {/* x labels */}
        {daily.map((d, i) => {
          if (i % labelStep !== 0 && i !== daily.length - 1) return null;
          return (
            <text key={i} x={toX(i)} y={H - 4} fontSize={7.5}
              fill={hov === i ? "#e2e8f0" : "#334155"} textAnchor="middle">
              {d.date.slice(5).replace("-", "/")}
            </text>
          );
        })}
        <text x={PL - 4} y={PT + 4}     fontSize={8} fill="#475569" textAnchor="end">{Math.round(maxY)}</text>
        <text x={PL - 4} y={H - PB + 4} fontSize={8} fill="#475569" textAnchor="end">0</text>

        {/* hover */}
        {hov !== null && (() => {
          const d   = daily[hov];
          const hx  = toX(hov), hy = toY(d.count);
          const si  = segStats.findIndex(({ start, end }) => hov >= start && hov < end);
          return (
            <>
              <line x1={hx} x2={hx} y1={PT} y2={H - PB}
                stroke="#fff" strokeWidth={0.8} strokeDasharray="3,3" opacity={0.2} />
              <circle cx={hx} cy={hy} r={4} fill="#22d3ee" stroke="#0f172a" strokeWidth={1.5} />
              <SvgTip x={hx} y={hy} viewW={W} lines={[
                { text: d.date.slice(5).replace("-", "/"), color: "#94a3b8" },
                { text: `Patients : ${d.count}`, color: "#22d3ee" },
                { text: `Segment ${si + 1} · moy ${segStats[si]?.mean.toFixed(1)}`, color: "#94a3b8" },
              ]} />
            </>
          );
        })()}

        <rect x={PL} y={PT} width={cW} height={cH} fill="transparent"
          onMouseMove={onMouseMove} onMouseLeave={() => setHov(null)} />
      </svg>

      {/* Segment comparison cards */}
      <div className={`grid gap-3 mt-3 grid-cols-${Math.min(segStats.length, 4)}`}
        style={{ gridTemplateColumns: `repeat(${Math.min(segStats.length, 4)}, minmax(0,1fr))` }}>
        {segStats.map(({ si, start, end, mean, delta, deltaPct }) => (
          <div key={si} className="card p-3">
            <div className="text-[10px] uppercase text-slate-500 tracking-wide mb-0.5">Segment {si + 1}</div>
            <div className="text-[9px] text-slate-600 mb-2">
              {daily[start]?.date.slice(5).replace("-", "/")} → {daily[end - 1]?.date.slice(5).replace("-", "/")}
            </div>
            <div className="text-lg font-bold text-slate-100">{mean.toFixed(1)}</div>
            <div className="text-[9px] text-slate-500">patients / jour</div>
            {delta != null && (
              <div className={`text-xs font-semibold mt-1.5 ${delta > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                {delta > 0 ? "↗ +" : "↘ "}{delta.toFixed(1)} ({deltaPct! > 0 ? "+" : ""}{deltaPct!.toFixed(0)}%)
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ─── Cluster scatter plot ─────────────────────────────────────────────────────

function ClusterScatter({
  scatter, clusters,
}: {
  scatter: { hour: number; los: number; cluster: number }[];
  clusters: ResearchCluster[];
}) {
  if (scatter.length === 0) return null;

  const W = 640, H = 230;
  const PL = 52, PR = 12, PT = 14, PB = 30;
  const cW = W - PL - PR, cH = H - PT - PB;
  const maxLOS = Math.min(Math.max(...scatter.map(p => p.los), 60), 720);
  const toX = (h: number) => PL + (h / 23) * cW;
  const toY = (l: number) => PT + cH - (Math.min(l, 720) / maxLOS) * cH;
  const colorOf = (cl: number) => clusters.find(c => c.id === cl)?.color ?? "#22d3ee";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* grid */}
      {[0, .25, .5, .75, 1].map((f, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={PT + cH * (1 - f)} y2={PT + cH * (1 - f)}
          stroke="#1e293b" strokeWidth={1} />
      ))}
      {[0, 6, 12, 18, 23].map((h) => (
        <line key={h} x1={toX(h)} x2={toX(h)} y1={PT} y2={H - PB}
          stroke="#1e293b" strokeWidth={1} />
      ))}

      {/* dots with deterministic jitter */}
      {scatter.map((p, i) => {
        const jitter = ((i * 37 + p.cluster * 13) % 10 - 5) * 0.07;
        return (
          <circle key={i}
            cx={toX(p.hour + jitter)} cy={toY(p.los)}
            r={2.2} fill={colorOf(p.cluster)} opacity={0.5} />
        );
      })}

      {/* x axis */}
      {[0, 6, 12, 18, 23].map((h) => (
        <text key={h} x={toX(h)} y={H - 6} fontSize={8} fill="#475569" textAnchor="middle">{h}h</text>
      ))}
      <text x={PL + cW / 2} y={H - 2} fontSize={8} fill="#475569" textAnchor="middle">
        Heure d'arrivée
      </text>

      {/* y axis */}
      {[0, .25, .5, .75, 1].map((f, i) => (
        <text key={i} x={PL - 5} y={PT + cH * (1 - f) + 3}
          fontSize={7.5} fill="#475569" textAnchor="end">
          {Math.round(maxLOS * f)} min
        </text>
      ))}
    </svg>
  );
}

// ─── Cluster profile cards ────────────────────────────────────────────────────

const DOW_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];

function ClusterCards({ clusters }: { clusters: ResearchCluster[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {clusters.map((c) => (
        <div key={c.id} className="card p-4 space-y-2" style={{ borderColor: `${c.color}44` }}>
          <div className="flex items-center justify-between">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: c.color }} />
            <span className="text-[10px] font-mono text-slate-500">{c.pct} %</span>
          </div>
          <div className="text-sm font-semibold text-slate-100">{c.name}</div>
          <div className="text-2xl font-bold" style={{ color: c.color }}>
            {c.count.toLocaleString()}
          </div>
          <div className="text-[9px] text-slate-500">passages</div>
          <div className="border-t border-slate-800/60 pt-2 space-y-1 text-[10px] text-slate-400">
            <div className="flex justify-between">
              <span>LOS moyen</span>
              <span className="text-slate-200">{c.avg_los.toFixed(0)} min</span>
            </div>
            <div className="flex justify-between">
              <span>LOS médiane</span>
              <span className="text-slate-200">{c.median_los.toFixed(0)} min</span>
            </div>
            <div className="flex justify-between">
              <span>Arrivée moy.</span>
              <span className="text-slate-200">{c.avg_hour.toFixed(0)} h</span>
            </div>
            <div className="flex justify-between">
              <span>Jour typique</span>
              <span className="text-slate-200">{DOW_LABELS[Math.round(c.avg_dow) % 7]}</span>
            </div>
            <div className="flex justify-between">
              <span>Hospitalisé</span>
              <span style={{ color: c.hosp_rate > 30 ? "#f59e0b" : "#22d3ee" }}>
                {c.hosp_rate.toFixed(0)} %
              </span>
            </div>
          </div>
          {/* mini LOS bar */}
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div className="h-full rounded-full transition-all"
              style={{ width: `${Math.min(c.avg_los / 720 * 100, 100)}%`, background: c.color }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Avant / Après ────────────────────────────────────────────────────────────

function fmtP(p: number): string {
  if (p < 0.001) return "p < 0,001";
  return `p = ${p.toFixed(3)}`;
}
function cohenLabel(d: number): string {
  const a = Math.abs(d);
  if (a < 0.2) return "Négligeable";
  if (a < 0.5) return "Petit";
  if (a < 0.8) return "Moyen";
  return "Large";
}

function BoxViz({ stats, color }: { stats: BeforeAfterResult["before"]; color: string }) {
  const W = 220, H = 44, PL = 10, PR = 10;
  const cW = W - PL - PR;
  const max = stats.p90 + 10;
  const toX = (v: number) => PL + (v / max) * cW;
  const cy = H / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* whiskers */}
      <line x1={toX(stats.p10)} x2={toX(stats.p90)} y1={cy} y2={cy} stroke="#334155" strokeWidth={1} />
      <line x1={toX(stats.p10)} x2={toX(stats.p10)} y1={cy - 6} y2={cy + 6} stroke="#475569" strokeWidth={1.5} />
      <line x1={toX(stats.p90)} x2={toX(stats.p90)} y1={cy - 6} y2={cy + 6} stroke="#475569" strokeWidth={1.5} />
      {/* IQR box */}
      <rect x={toX(stats.p25)} y={cy - 9} width={toX(stats.p75) - toX(stats.p25)} height={18}
        fill={color} fillOpacity={0.18} stroke={color} strokeWidth={1.5} rx={2} />
      {/* median */}
      <line x1={toX(stats.median)} x2={toX(stats.median)} y1={cy - 9} y2={cy + 9}
        stroke={color} strokeWidth={2} />
      {/* mean diamond */}
      <polygon points={`${toX(stats.mean)},${cy - 5} ${toX(stats.mean) + 5},${cy} ${toX(stats.mean)},${cy + 5} ${toX(stats.mean) - 5},${cy}`}
        fill={color} fillOpacity={0.7} />
      {/* labels */}
      <text x={toX(stats.p10)} y={H - 2} fontSize={7} fill="#475569" textAnchor="middle">p10</text>
      <text x={toX(stats.p90)} y={H - 2} fontSize={7} fill="#475569" textAnchor="middle">p90</text>
      <text x={toX(stats.median)} y={6} fontSize={7} fill={color} textAnchor="middle">{stats.median.toFixed(0)}</text>
    </svg>
  );
}

function AvantApresSection({ defaultDate }: { defaultDate: string }) {
  const { filters } = useFilters();
  const [splitDate, setSplitDate] = useState(defaultDate);
  const [data, setData]     = useState<BeforeAfterResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!splitDate) return;
    let cancelled = false;
    setLoading(true);
    api.researchBeforeAfter(splitDate, filters)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [splitDate, filters]);

  const significant = data && !data.error && data.p_value < 0.05;
  const pColor = significant ? "#34d399" : "#f43f5e";

  return (
    <div className="card p-5 space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">Test statistique avant / après (Mann-Whitney U)</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Sélectionnez une date de coupure · test non-paramétrique sur la distribution du LOS · effet de Cohen d
        </p>
      </div>

      {/* Date picker */}
      <div className="flex items-center gap-3">
        <label className="text-xs text-slate-400">Date de coupure</label>
        <input type="date" value={splitDate} onChange={(e) => setSplitDate(e.target.value)}
          className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-brand-500/50" />
        {loading && <Loader2 size={14} className="animate-spin text-slate-500" />}
      </div>

      {data?.error && <div className="text-rose-300 text-xs">{data.error}</div>}

      {data && !data.error && (
        <>
          {/* Period comparison */}
          <div className="grid md:grid-cols-2 gap-4">
            {[
              { label: "Avant", stats: data.before, color: "#22d3ee", period: "< " + splitDate },
              { label: "Après", stats: data.after,  color: "#818cf8", period: "≥ " + splitDate },
            ].map(({ label, stats, color, period }) => (
              <div key={label} className="card p-4 space-y-2" style={{ borderColor: `${color}44` }}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold" style={{ color }}>{label}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{period}</span>
                </div>
                <div className="text-[10px] text-slate-500 font-mono">{stats.n} patients</div>
                <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400 pt-1">
                  <div>Moyenne <span className="text-slate-200 font-semibold">{stats.mean.toFixed(0)} min</span></div>
                  <div>Médiane <span className="text-slate-200 font-semibold">{stats.median.toFixed(0)} min</span></div>
                  <div>P25 <span className="text-slate-300">{stats.p25.toFixed(0)}</span></div>
                  <div>P75 <span className="text-slate-300">{stats.p75.toFixed(0)}</span></div>
                  <div>P10 <span className="text-slate-300">{stats.p10.toFixed(0)}</span></div>
                  <div>P90 <span className="text-slate-300">{stats.p90.toFixed(0)}</span></div>
                </div>
                <BoxViz stats={stats} color={color} />
              </div>
            ))}
          </div>

          {/* Test results */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card p-3 text-center" style={{ borderColor: `${pColor}44` }}>
              <div className="text-xs text-slate-500 mb-1">Valeur p (Mann-Whitney)</div>
              <div className="text-lg font-bold" style={{ color: pColor }}>{fmtP(data.p_value)}</div>
              <div className="text-[10px] mt-1" style={{ color: pColor }}>
                {significant ? "Différence significative" : "Non significatif"} (α = 0,05)
              </div>
            </div>
            <div className="card p-3 text-center">
              <div className="text-xs text-slate-500 mb-1">Taille d'effet (Cohen d)</div>
              <div className={`text-lg font-bold ${Math.abs(data.cohen_d) > 0.5 ? "text-amber-400" : "text-slate-300"}`}>
                {data.cohen_d > 0 ? "+" : ""}{data.cohen_d.toFixed(2)}
              </div>
              <div className="text-[10px] text-slate-500 mt-1">{cohenLabel(data.cohen_d)}</div>
            </div>
            <div className="card p-3 text-center">
              <div className="text-xs text-slate-500 mb-1">Δ médiane LOS</div>
              <div className={`text-lg font-bold ${data.after.median > data.before.median ? "text-rose-400" : "text-emerald-400"}`}>
                {data.after.median - data.before.median > 0 ? "+" : ""}
                {(data.after.median - data.before.median).toFixed(0)} min
              </div>
              <div className="text-[10px] text-slate-500 mt-1">
                {(((data.after.median - data.before.median) / Math.max(data.before.median, 1)) * 100).toFixed(0)}% vs avant
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Décomposition STL ────────────────────────────────────────────────────────

function MiniSeriesChart({
  label, values, dates, color,
}: {
  label: string; values: (number|null)[]; dates: string[]; color: string;
}) {
  const [hov, setHov] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;

  const W = 640, H = 90;
  const PL = 46, PR = 10, PT = 12, PB = 18;
  const cW = W - PL - PR, cH = H - PT - PB;
  const minV = Math.min(...nums), maxV = Math.max(...nums);
  const range = Math.max(maxV - minV, 1);
  const toX = (i: number) => PL + (i / Math.max(values.length - 1, 1)) * cW;
  const toY = (v: number) => PT + cH - ((v - minV) / range) * cH;
  const labelStep = Math.max(1, Math.ceil(values.length / 10));
  const zeroY = minV < 0 && maxV > 0 ? toY(0) : null;

  const pathD = values.map((v, i) => {
    if (v === null) return null;
    return `${i === 0 || values[i-1] === null ? "M" : "L"}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`;
  }).filter(Boolean).join(" ");

  function onMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const el = svgRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    setHov(Math.round(Math.max(0, Math.min((((e.clientX - r.left) / r.width) * W - PL) / cW, 1)) * (values.length - 1)));
  }

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <text x={PL - 4} y={PT + 8} fontSize={8} fill={color} textAnchor="end" fontWeight={600}>{label}</text>
      {zeroY && <line x1={PL} x2={W - PR} y1={zeroY} y2={zeroY} stroke="#334155" strokeWidth={1} />}
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5}
        style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
      <text x={PL - 4} y={PT + 4}     fontSize={7} fill="#475569" textAnchor="end">{maxV.toFixed(0)}</text>
      <text x={PL - 4} y={H - PB + 4} fontSize={7} fill="#475569" textAnchor="end">{minV.toFixed(0)}</text>
      {dates.map((d, i) => {
        if (i % labelStep !== 0 && i !== dates.length - 1) return null;
        return <text key={i} x={toX(i)} y={H - 2} fontSize={7} fill="#334155" textAnchor="middle">{d.slice(5).replace("-","/")}</text>;
      })}
      {hov !== null && values[hov] !== null && (() => {
        const hx = toX(hov), hy = toY(values[hov] as number);
        return (
          <>
            <line x1={hx} x2={hx} y1={PT} y2={H - PB} stroke="#fff" strokeWidth={0.7} strokeDasharray="3,3" opacity={0.2} />
            <circle cx={hx} cy={hy} r={3} fill={color} stroke="#0f172a" strokeWidth={1} />
            <SvgTip x={hx} y={hy} viewW={W} lines={[
              { text: dates[hov].slice(5).replace("-","/"), color: "#94a3b8" },
              { text: `${(values[hov] as number).toFixed(1)}`, color },
            ]} />
          </>
        );
      })()}
      <rect x={PL} y={PT} width={cW} height={cH} fill="transparent"
        onMouseMove={onMouseMove} onMouseLeave={() => setHov(null)} />
    </svg>
  );
}

function STLSection() {
  const { filters } = useFilters();
  const [data, setData]       = useState<DecompResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    api.researchDecomposition(filters)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr((e as Error).message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  if (loading) return <div className="flex justify-center py-16"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  if (err) return <div className="card p-4 text-rose-300 text-sm">Erreur : {err}</div>;
  if (!data || data.dates.length === 0) return <div className="card p-4 text-slate-500 text-sm">Données insuffisantes (min 14 jours)</div>;

  const rows: { label: string; values: (number|null)[]; color: string }[] = [
    { label: "Observé",     values: data.observed.map(v => v as number),  color: "#22d3ee" },
    { label: "Tendance",    values: data.trend,    color: "#818cf8" },
    { label: "Saisonnalité",values: data.seasonal.map(v => v as number), color: "#34d399" },
    { label: "Résidu",      values: data.residual, color: "#f59e0b" },
  ];

  return (
    <div className="card p-5 space-y-1">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-slate-100">Décomposition classique additive (période = 7j)</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Observé = Tendance + Saisonnalité hebdomadaire + Résidu ·
          tendance par moyenne mobile centrée · saisonnalité par moyenne journalière par jour de semaine
        </p>
      </div>
      <div className="flex flex-wrap gap-4 text-[10px] text-slate-500 mb-3">
        {rows.map(r => (
          <span key={r.label} className="flex items-center gap-1.5">
            <span className="inline-block w-4 h-0.5" style={{ background: r.color }} />
            {r.label}
          </span>
        ))}
      </div>
      <div className="divide-y divide-slate-800/60 space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="pt-1">
            <MiniSeriesChart label={r.label} values={r.values} dates={data.dates} color={r.color} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Kaplan-Meier ─────────────────────────────────────────────────────────────

function KMSection() {
  const { filters } = useFilters();
  const [data, setData]       = useState<KMResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    api.researchKaplanMeier(filters)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr((e as Error).message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  if (loading) return <div className="flex justify-center py-16"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  if (err) return <div className="card p-4 text-rose-300 text-sm">Erreur : {err}</div>;
  if (!data || data.overall.length === 0) return <div className="card p-4 text-slate-500 text-sm">Données insuffisantes</div>;

  const W = 640, H = 260;
  const PL = 46, PR = 20, PT = 16, PB = 36;
  const cW = W - PL - PR, cH = H - PT - PB;
  const maxT = 720;
  const toX  = (t: number) => PL + (Math.min(t, maxT) / maxT) * cW;
  const toY  = (s: number) => PT + cH - s * cH;

  function stepPath(pts: KMResult["overall"]): string {
    if (pts.length === 0) return "";
    const p = pts.filter(p => p.t <= maxT);
    return p.map((pt, i) => {
      const x = toX(pt.t).toFixed(1), y = toY(pt.s).toFixed(1);
      if (i === 0) return `M${x},${toY(1).toFixed(1)} L${x},${y}`;
      return `L${x},${toY(p[i-1].s).toFixed(1)} L${x},${y}`;
    }).join(" ");
  }

  function ciPath(pts: KMResult["overall"]): string {
    if (pts.length === 0) return "";
    const p = pts.filter(pt => pt.t <= maxT);
    const upper = p.map(pt => `${toX(pt.t).toFixed(1)},${toY(pt.ci_hi).toFixed(1)}`).join(" L");
    const lower = [...p].reverse().map(pt => `${toX(pt.t).toFixed(1)},${toY(pt.ci_lo).toFixed(1)}`).join(" L");
    return `M ${upper} L ${lower} Z`;
  }

  const lines: { label: string; pts: KMResult["overall"]; color: string; n: number; median: number }[] = [
    { label: "Global",    pts: data.overall,  color: "#22d3ee", n: data.n_total,   median: data.median_overall  },
    { label: "Semaine",   pts: data.weekday,  color: "#34d399", n: data.n_weekday, median: data.median_weekday  },
    { label: "Weekend",   pts: data.weekend,  color: "#f59e0b", n: data.n_weekend, median: data.median_weekend  },
  ].filter(l => l.pts.length > 0);

  const ticksH = [0, 1, 2, 3, 4, 6, 8, 10, 12];

  return (
    <div className="space-y-4">
      <div className="card p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">Courbe de survie — Kaplan-Meier</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            S(t) = probabilité d'être encore aux urgences à t min · bandes = IC 95% ·
            stratification semaine / weekend
          </p>
        </div>

        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
          {/* grid */}
          {[0, .25, .5, .75, 1].map((f, i) => (
            <line key={i} x1={PL} x2={W - PR} y1={PT + cH * (1 - f)} y2={PT + cH * (1 - f)}
              stroke="#1e293b" strokeWidth={1} />
          ))}
          {ticksH.map(h => (
            <line key={h} x1={toX(h * 60)} x2={toX(h * 60)} y1={PT} y2={H - PB}
              stroke="#1e293b" strokeWidth={1} />
          ))}

          {/* CI bands */}
          {lines.map(({ pts, color }) => (
            <path key={color + "ci"} d={ciPath(pts)} fill={color} fillOpacity={0.08} />
          ))}

          {/* Step functions */}
          {lines.map(({ pts, color, label }) => (
            <path key={label} d={stepPath(pts)} fill="none" stroke={color} strokeWidth={1.5}
              style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
          ))}

          {/* Median markers */}
          {lines.map(({ median, color }) => {
            if (median > maxT || median <= 0) return null;
            const mx = toX(median);
            return (
              <g key={color + "med"}>
                <line x1={mx} x2={mx} y1={toY(0.5)} y2={H - PB}
                  stroke={color} strokeWidth={1} strokeDasharray="4,3" opacity={0.6} />
                <line x1={PL} x2={mx} y1={toY(0.5)} y2={toY(0.5)}
                  stroke={color} strokeWidth={1} strokeDasharray="4,3" opacity={0.3} />
                <text x={mx} y={H - PB + 10} fontSize={7.5} fill={color} textAnchor="middle">
                  {median.toFixed(0)}min
                </text>
              </g>
            );
          })}

          {/* x axis */}
          {ticksH.map(h => (
            <text key={h} x={toX(h * 60)} y={H - 8} fontSize={8} fill="#475569" textAnchor="middle">{h}h</text>
          ))}
          <text x={PL + cW / 2} y={H - 2} fontSize={8} fill="#475569" textAnchor="middle">Temps (heures)</text>

          {/* y axis */}
          {[0, .25, .5, .75, 1].map((f, i) => (
            <text key={i} x={PL - 5} y={PT + cH * (1 - f) + 3} fontSize={7.5} fill="#475569" textAnchor="end">
              {(f * 100).toFixed(0)}%
            </text>
          ))}
          <text x={10} y={PT + cH / 2} fontSize={8} fill="#475569" textAnchor="middle"
            transform={`rotate(-90, 10, ${PT + cH / 2})`}>Prob. encore présent</text>
        </svg>

        {/* Legend + stats */}
        <div className="grid grid-cols-3 gap-3 text-xs">
          {lines.map(({ label, color, n, median }) => (
            <div key={label} className="card p-3" style={{ borderColor: `${color}44` }}>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="inline-block w-4 h-0.5" style={{ background: color }} />
                <span className="font-semibold text-slate-200">{label}</span>
              </div>
              <div className="text-[10px] text-slate-500">n = {n.toLocaleString()}</div>
              <div className="text-[10px] text-slate-500">Médiane : <span style={{ color }}>{median.toFixed(0)} min</span></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Feature Importance ───────────────────────────────────────────────────────

function FeaturesSection() {
  const [data, setData]       = useState<FeatResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const [hov, setHov]         = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    api.researchFeatureImportance()
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr((e as Error).message); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="flex justify-center py-16"><Loader2 size={18} className="animate-spin text-slate-500" /></div>;
  if (err) return <div className="card p-4 text-rose-300 text-sm">Erreur : {err}</div>;
  if (!data || data.features.length === 0) return <div className="card p-4 text-slate-500 text-sm">Modèle non disponible</div>;

  const CAT_COLOR: Record<string, string> = { time: "#22d3ee", location: "#818cf8", exit: "#f59e0b" };
  const CAT_LABEL: Record<string, string> = { time: "Temporel", location: "Premier local", exit: "Mode de sortie" };
  const maxImp = data.features[0].importance;
  const W = 540, BAR_H = 22, PAD_L = 150, PAD_R = 60;
  const totalH = data.features.length * BAR_H + 20;

  return (
    <div className="card p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">Importance des variables — modèle GBM</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          Variables les plus prédictives du LOS · gradient boosting entraîné sur l'ensemble du dataset ·
          importance normalisée par le gain de réduction de variance
        </p>
      </div>

      <div className="flex flex-wrap gap-4 text-[10px] text-slate-500 mb-2">
        {Object.entries(CAT_COLOR).map(([k, c]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-sm" style={{ background: c }} />
            {CAT_LABEL[k]}
          </span>
        ))}
      </div>

      <svg viewBox={`0 0 ${W + PAD_L + PAD_R} ${totalH}`} className="w-full h-auto">
        {data.features.map((f, i) => {
          const y   = i * BAR_H + 4;
          const bW  = (f.importance / maxImp) * W;
          const col = CAT_COLOR[f.category] ?? "#22d3ee";
          const isHov = hov === i;
          return (
            <g key={f.rank} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
              style={{ cursor: "default" }}>
              {/* feature name */}
              <text x={PAD_L - 6} y={y + BAR_H * 0.65} fontSize={9} fill={isHov ? "#e2e8f0" : "#94a3b8"} textAnchor="end">
                {f.name}
              </text>
              {/* bar */}
              <rect x={PAD_L} y={y + 2} width={bW} height={BAR_H - 6} rx={3}
                fill={col} fillOpacity={isHov ? 0.85 : 0.55}
                style={isHov ? { filter: `drop-shadow(0 0 4px ${col})` } : undefined} />
              {/* value */}
              <text x={PAD_L + bW + 5} y={y + BAR_H * 0.65} fontSize={8.5} fill={col}>
                {(f.importance * 100).toFixed(1)}%
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Main exported component ──────────────────────────────────────────────────

type Section = "ruptures" | "avant_apres";

export function ResearchAnalytics() {
  const { filters }  = useFilters();
  const { setAssistant, clearAssistant } = useAssistant();
  const [data, setData]       = useState<ResearchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState<string | null>(null);
  const [section, setSection] = useState<Section>("ruptures");

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setErr(null);
    api.research(filters)
      .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setErr((e as Error).message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [filters]);

  useEffect(() => {
    if (!data) return;
    if (section === "ruptures") {
      const counts = data.daily.map(d => d.count);
      const breaks = binarySegmentation(counts);
      const segments = [0, ...breaks, counts.length].slice(0, -1).map((start, si) => {
        const end = [0, ...breaks, counts.length][si + 1];
        const seg = counts.slice(start, end);
        const mean = seg.reduce((s, v) => s + v, 0) / Math.max(seg.length, 1);
        return {
          from: data.daily[start]?.date,
          to:   data.daily[Math.max(end - 1, 0)]?.date,
          n_days: end - start,
          mean: Number(mean.toFixed(1)),
        };
      });
      setAssistant({
        kind: "rupture",
        context: {
          period: { from: data.daily[0]?.date, to: data.daily[data.daily.length - 1]?.date, n_days: data.daily.length },
          breakpoints: breaks.map(i => data.daily[i]?.date).filter(Boolean),
          segments,
          overall_mean: Number((counts.reduce((s, v) => s + v, 0) / Math.max(counts.length, 1)).toFixed(1)),
        },
        suggestions: [
          "Explique-moi les ruptures détectées",
          "Quelle rupture est la plus marquée ?",
          "Quelles hypothèses pour expliquer ce changement ?",
        ],
      });
    } else if (section === "avant_apres") {
      setAssistant({
        kind: "avant_apres",
        context: {
          period: { from: data.daily[0]?.date, to: data.daily[data.daily.length - 1]?.date, n_days: data.daily.length },
          note: "Le test Mann-Whitney U et la taille d'effet Cohen d sont calculés autour d'une date de coupure choisie par l'utilisateur.",
        },
        suggestions: [
          "Comment interpréter une p-value < 0,05 ?",
          "Que veut dire un Cohen d de 0,5 ici ?",
          "La différence est-elle cliniquement pertinente ?",
        ],
      });
    }
    return () => clearAssistant();
  }, [section, data, setAssistant, clearAssistant]);

  if (loading) return (
    <div className="flex items-center justify-center h-64 gap-3 text-slate-500">
      <Loader2 size={18} className="animate-spin" />
      <span className="text-sm">Calcul des modèles statistiques…</span>
    </div>
  );

  if (err) return (
    <div className="card p-4 text-rose-300 text-sm">Erreur : {err}</div>
  );

  if (!data) return null;

  const SECTIONS: { id: Section; label: string; icon: React.ReactNode; desc: string }[] = [
    {
      id: "ruptures", label: "Détection de rupture", icon: <GitCommit size={13} />,
      desc: "Identifie les changements structurels (Binary Segmentation) et quantifie l'effet avant/après",
    },
    {
      id: "avant_apres", label: "Test avant / après", icon: <ArrowLeftRight size={13} />,
      desc: "Comparez deux périodes avec le test de Mann-Whitney U et la taille d'effet Cohen d",
    },
  ];

  return (
    <div className="space-y-5">
      {/* Section nav */}
      <div className="flex flex-wrap gap-2">
        {SECTIONS.map((s) => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm border transition ${
              section === s.id
                ? "bg-brand-500/15 border-brand-500/30 text-brand-200"
                : "border-slate-700/60 text-slate-400 hover:bg-slate-800/50"
            }`}>
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      {/* ── Ruptures ─────────────────────────────────────────────────────── */}
      {section === "ruptures" && (
        <div className="card p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Détection de ruptures — Binary Segmentation
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Identifie automatiquement les ruptures structurelles dans le flux patient ·
              lignes verticales ambre = dates de rupture · lignes horizontales = moyenne de chaque segment
            </p>
          </div>
          <BreakpointChart daily={data.daily} />
        </div>
      )}

      {/* ── Avant / Après ────────────────────────────────────────────────── */}
      {section === "avant_apres" && (
        <AvantApresSection defaultDate={data.daily[Math.floor(data.daily.length / 2)]?.date ?? ""} />
      )}
    </div>
  );
}
