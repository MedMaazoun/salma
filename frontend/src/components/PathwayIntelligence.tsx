import { useState, useEffect, useRef } from "react";
import {
  X, ChevronRight, Route, Ruler, Shuffle,
  Loader2, Activity, RotateCcw, Info,
} from "lucide-react";
import {
  api,
  type Variant,
  type FloorRoom, type FloorPlanData,
  type PathwayPrediction, type PathwayNextResponse,
} from "../api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function locColor(name: string): string {
  const n = name.toUpperCase();
  if (n.includes("TRIAGE"))                               return "#34d399";
  if (n.includes("ACCUEIL"))                              return "#6ee7b7";
  if (n.includes("RADIO") || n.includes("SCANNER") || n.includes("ECHO")) return "#60a5fa";
  if (n.includes("BOX") || n.includes("SALLE") || n.includes("SOINS"))    return "#a78bfa";
  if (n.includes("UHCD") || n.includes("HOSP"))           return "#f59e0b";
  if (n.includes("LAB") || n.includes("BIOL") || n.includes("PRÉL") || n.includes("PREL")) return "#fb7185";
  if (n.includes("SORTIE") || n.includes("DÉPART") || n.includes("DEPART")) return "#94a3b8";
  if (n.includes("ATTENTE"))                              return "#e879f9";
  return "#818cf8";
}

function locInitials(name: string): string {
  return name
    .split(/[\s_\-/]+/)
    .map(w => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 3);
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fmtMin(v: number | null) {
  if (v == null || isNaN(v)) return "—";
  if (v < 60) return `${Math.round(v)} min`;
  return `${Math.floor(v / 60)}h${String(Math.round(v % 60)).padStart(2, "0")}`;
}

function entropyLabel(bits: number): { text: string; color: string } {
  if (bits < 1.0) return { text: "Parcours déterministe", color: "#34d399" };
  if (bits < 2.0) return { text: "Parcours probable",     color: "#f59e0b" };
  return              { text: "Parcours incertain",        color: "#f43f5e" };
}

// ─── SequenceTile ─────────────────────────────────────────────────────────────

function SequenceTile({
  name, step, onRemove,
}: { name: string; step: number; onRemove: () => void }) {
  const color = locColor(name);
  const inits = locInitials(name);
  return (
    <div className="relative flex-shrink-0 group" title={name}>
      <div className="flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border min-w-[96px] transition-all"
        style={{ borderColor: color + "55", background: color + "14" }}>
        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-xs font-bold"
          style={{ background: color + "28", color }}>
          {inits}
        </div>
        <div className="text-[10px] font-semibold text-center leading-tight"
          style={{ color }} title={name}>
          {trunc(name, 14)}
        </div>
      </div>
      {/* Step badge */}
      <div className="absolute -top-2 -left-2 w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-slate-900"
        style={{ background: color }}>
        {step}
      </div>
      {/* Remove */}
      <button onClick={onRemove}
        className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-slate-800 border border-slate-600 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-rose-500/30 hover:border-rose-500/50 transition">
        <X size={8} className="text-slate-300" />
      </button>
    </div>
  );
}

// ─── EntropyBar ───────────────────────────────────────────────────────────────

function EntropyBar({ bits }: { bits: number }) {
  const maxBits = 3;
  const pct = Math.min(100, (bits / maxBits) * 100);
  const { text, color } = entropyLabel(bits);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-slate-500 flex items-center gap-1">
          <Activity size={9} /> Entropie décisionnelle
        </span>
        <span style={{ color }} className="font-semibold">{text}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="text-[9px] text-slate-600">{bits.toFixed(2)} bits · max théorique ≈ 3 bits</div>
    </div>
  );
}

// ─── Floor Plan SVG — AutoCAD/Blueprint style ────────────────────────────────

const CAD_STYLES = `
@keyframes dash-flow  { to { stroke-dashoffset: -30; } }
@keyframes pulse-glow { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
`;

const TRAJ_PALETTE = [
  "#22d3ee", "#a78bfa", "#34d399", "#f59e0b",
  "#f43f5e", "#60a5fa", "#e879f9", "#fb923c",
];

function FloorPlanSVG({
  data, journey, variants = [],
}: { data: FloorPlanData; journey: string[]; variants?: Variant[] }) {
  const CW = data.canvas.w, CH = data.canvas.h;
  const [hovered,   setHovered]   = useState<string | null>(null);
  const [showTrajs, setShowTrajs] = useState(true);
  const [vb, setVb] = useState({ x: 0, y: 0, w: CW, h: CH });
  const svgRef  = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ cx: number; cy: number; vbx: number; vby: number } | null>(null);

  useEffect(() => {
    if (!document.getElementById("cad-anim-styles")) {
      const s = document.createElement("style");
      s.id = "cad-anim-styles";
      s.textContent = CAD_STYLES;
      document.head.appendChild(s);
    }
  }, []);

  // ── Zoom/Pan handlers ──
  function onWheel(e: React.WheelEvent<SVGSVGElement>) {
    e.preventDefault();
    const rect = svgRef.current!.getBoundingClientRect();
    const mx = vb.x + (e.clientX - rect.left) / rect.width  * vb.w;
    const my = vb.y + (e.clientY - rect.top)  / rect.height * vb.h;
    const factor = e.deltaY > 0 ? 1.18 : 0.85;
    const nw = Math.min(Math.max(vb.w * factor, CW / 5), CW * 2);
    const nh = nw * (CH / CW);
    setVb({ x: mx - (mx - vb.x) / vb.w * nw, y: my - (my - vb.y) / vb.h * nh, w: nw, h: nh });
  }
  function onMouseDown(e: React.MouseEvent<SVGSVGElement>) {
    if (e.button !== 0) return;
    dragRef.current = { cx: e.clientX, cy: e.clientY, vbx: vb.x, vby: vb.y };
  }
  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    if (!dragRef.current) return;
    const rect = svgRef.current!.getBoundingClientRect();
    const sdx = (e.clientX - dragRef.current.cx) / rect.width  * vb.w;
    const sdy = (e.clientY - dragRef.current.cy) / rect.height * vb.h;
    setVb(v => ({ ...v, x: dragRef.current!.vbx - sdx, y: dragRef.current!.vby - sdy }));
  }
  function onMouseUp() { dragRef.current = null; }
  function resetView()  { setVb({ x: 0, y: 0, w: CW, h: CH }); }
  function zoomBy(f: number) {
    setVb(v => {
      const nw = Math.min(Math.max(v.w * f, CW / 5), CW * 2);
      const nh = nw * (CH / CW);
      return { x: v.x + (v.w - nw) / 2, y: v.y + (v.h - nh) / 2, w: nw, h: nh };
    });
  }

  const zoomPct    = Math.round(CW / vb.w * 100);
  const roomMap    = Object.fromEntries(data.rooms.map(r => [r.id, r]));
  const journeySet = new Set(journey);
  const corridorY  = CH / 2;
  const corridorH  = 22;

  // ── Path routing: cubic bezier dipping through corridor spine ──
  function buildPath(seq: string[]): string {
    const rooms = seq.map(id => roomMap[id]).filter(Boolean);
    if (rooms.length < 2) return "";
    const s = rooms[0];
    let d = `M${s.x + s.w / 2},${s.y + s.h / 2}`;
    for (let i = 0; i < rooms.length - 1; i++) {
      const a = rooms[i], b = rooms[i + 1];
      const ax = a.x + a.w / 2, bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      d += ` C${ax},${corridorY} ${bx},${corridorY} ${bx},${by}`;
    }
    return d;
  }

  const jPath = journey.length >= 2 ? buildPath(journey) : "";

  // ── Distance estimate ──
  let distUnits = 0;
  for (let i = 0; i < journey.length - 1; i++) {
    const a = roomMap[journey[i]], b = roomMap[journey[i + 1]];
    if (a && b) {
      const dx = (a.x + a.w / 2) - (b.x + b.w / 2);
      const dy = (a.y + a.h / 2) - (b.y + b.h / 2);
      distUnits += Math.sqrt(dx * dx + dy * dy);
    }
  }
  const distM = Math.round(distUnits * data.scale_m_per_unit);

  // ── Door gap: cut 14px opening on one side of room rect ──
  function roomOutlinePath(r: FloorRoom): string {
    const { x, y, w, h } = r;
    const doorSide = r.avg_pos < 0.5 ? "right" : "left";
    const dw = 14, dy2 = h * 0.35;
    if (doorSide === "right") {
      return (
        `M${x+4},${y} L${x+w},${y} L${x+w},${y+dy2}` +
        ` M${x+w},${y+dy2+dw} L${x+w},${y+h} L${x},${y+h} L${x},${y} Z`
      );
    }
    return (
      `M${x+w-4},${y} L${x},${y} L${x},${y+dy2}` +
      ` M${x},${y+dy2+dw} L${x},${y+h} L${x+w},${y+h} L${x+w},${y} Z`
    );
  }

  // ── Door arc ──
  function doorArc(r: FloorRoom): string {
    const { x, y, h } = r;
    const dy2 = h * 0.35, dw = 14;
    const doorSide = r.avg_pos < 0.5 ? "right" : "left";
    if (doorSide === "right") {
      const ox = x + r.w, oy = y + dy2;
      return `M${ox},${oy} A${dw},${dw} 0 0,1 ${ox - dw},${oy + dw}`;
    }
    const ox = x, oy = y + dy2;
    return `M${ox},${oy} A${dw},${dw} 0 0,0 ${ox + dw},${oy + dw}`;
  }

  // ── Room connector line to corridor ──
  function connectorPath(r: FloorRoom): string {
    const rx = r.x + r.w / 2;
    const ry = r.y + r.h / 2;
    const cy = r.y + r.h / 2 < corridorY
      ? corridorY - corridorH / 2
      : corridorY + corridorH / 2;
    return `M${rx},${ry < corridorY ? r.y + r.h : r.y} L${rx},${cy}`;
  }

  const hoveredRoom   = hovered ? roomMap[hovered] : null;
  const scaleBarUnits = Math.round(10 / data.scale_m_per_unit);

  const layerXSet = new Map<number, number>();
  for (const r of data.rooms) {
    if (!layerXSet.has(r.layer)) layerXSet.set(r.layer, r.x + r.w / 2);
  }
  const phaseLabels = ["TRIAGE", "ÉVALUATION", "TRAITEMENT", "SORTIE"];

  return (
    <div className="space-y-3">
      {/* ── Metric badges ── */}
      {journey.length >= 2 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-medium">
            <Ruler size={12} />
            Distance estimée : <strong>{distM} m</strong>
            <span className="text-slate-500 text-[10px]">
              (~{journey.length} zones × {Math.round(distM / Math.max(journey.length - 1, 1))} m/étape)
            </span>
          </div>
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-xs">
            <Route size={12} />
            {journey.length} étapes
          </div>
        </div>
      )}

      {/* ── SVG Canvas + Overlays ── */}
      <div className="relative rounded-xl overflow-hidden border border-slate-700/50 shadow-2xl"
        style={{ background: "#060d18" }}>

        {/* Zoom controls */}
        <div className="absolute top-2 right-2 z-10 flex flex-col items-center gap-1">
          <button onClick={() => zoomBy(0.7)} title="Zoom +"
            className="w-8 h-8 rounded-lg bg-slate-900/90 border border-slate-700/60 text-slate-300 hover:bg-slate-800 hover:text-white transition flex items-center justify-center text-lg font-bold leading-none select-none">+</button>
          <button onClick={() => zoomBy(1.43)} title="Zoom −"
            className="w-8 h-8 rounded-lg bg-slate-900/90 border border-slate-700/60 text-slate-300 hover:bg-slate-800 hover:text-white transition flex items-center justify-center text-lg font-bold leading-none select-none">−</button>
          <button onClick={resetView} title="Réinitialiser"
            className="w-8 h-8 rounded-lg bg-slate-900/90 border border-slate-700/60 text-slate-400 hover:bg-slate-800 hover:text-white transition flex items-center justify-center text-base font-bold select-none">↺</button>
          <span className="text-[8px] text-slate-600 font-mono mt-0.5">{zoomPct}%</span>
        </div>

        {/* Trajectory toggle */}
        <div className="absolute top-2 left-2 z-10">
          <button onClick={() => setShowTrajs(t => !t)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-semibold transition ${
              showTrajs
                ? "bg-violet-500/15 border-violet-500/40 text-violet-300"
                : "bg-slate-900/80 border-slate-700/50 text-slate-500"}`}>
            <Route size={10} />
            Trajets réels {variants.length > 0 ? `(${Math.min(variants.length, 8)})` : ""}
          </button>
        </div>

        <svg ref={svgRef}
          viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
          className="w-full select-none"
          style={{ maxHeight: 540, display: "block", cursor: dragRef.current ? "grabbing" : "grab" }}
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}>

          <defs>
            {/* Fine blueprint grid */}
            <pattern id="cad-minor" width="20" height="20" patternUnits="userSpaceOnUse">
              <path d="M20 0 L0 0 0 20" fill="none" stroke="#0d2040" strokeWidth="0.4"/>
            </pattern>
            <pattern id="cad-major" width="100" height="100" patternUnits="userSpaceOnUse">
              <rect width="100" height="100" fill="url(#cad-minor)"/>
              <path d="M100 0 L0 0 0 100" fill="none" stroke="#0d2a50" strokeWidth="0.9"/>
            </pattern>

            {/* Wall hatch (45°) */}
            <pattern id="wall-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="#1e3a5f" strokeWidth="1.2"/>
            </pattern>

            {/* Journey gradient */}
            <linearGradient id="j-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%"   stopColor="#34d399"/>
              <stop offset="45%"  stopColor="#22d3ee"/>
              <stop offset="100%" stopColor="#f59e0b"/>
            </linearGradient>

            {/* Glow filter */}
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <filter id="glow-strong" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="6" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>

            {/* Arrow markers */}
            <marker id="arr-hist" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">
              <path d="M0,0 L5,2.5 L0,5 Z" fill="#1e3a5f"/>
            </marker>
            <marker id="arr-journey" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="url(#j-grad)"/>
            </marker>
          </defs>

          {/* ── Blueprint background ── */}
          <rect width={CW} height={CH} fill="#060d18"/>
          <rect width={CW} height={CH} fill="url(#cad-major)"/>

          {/* ── Column zone bands ── */}
          {Array.from(layerXSet.entries()).map(([layer, cx]) => (
            <rect key={layer}
              x={cx - 76} y={0} width={152} height={CH}
              fill={`#0a1628`} opacity={0.35}/>
          ))}

          {/* ── Phase labels (top) ── */}
          {Array.from(layerXSet.entries()).map(([layer, cx]) => (
            <g key={`ph${layer}`}>
              <line x1={cx} y1={0} x2={cx} y2={12} stroke="#1e3a5f" strokeWidth={1}/>
              <text x={cx} y={22} textAnchor="middle"
                fill="#1e4976" fontSize={9} fontWeight="700" letterSpacing="2">
                {phaseLabels[layer] ?? `PHASE ${layer + 1}`}
              </text>
            </g>
          ))}

          {/* ── Main corridor spine ── */}
          <rect x={0} y={corridorY - corridorH / 2} width={CW} height={corridorH}
            fill="#081626" stroke="#0d2a50" strokeWidth={1}/>
          {/* Corridor center line */}
          <line x1={0} y1={corridorY} x2={CW} y2={corridorY}
            stroke="#102244" strokeWidth={0.8} strokeDasharray="12 6"/>
          {/* Corridor label */}
          <text x={10} y={corridorY + 4} fill="#102244" fontSize={7.5} fontWeight="600" letterSpacing="1.5">
            COULOIR PRINCIPAL
          </text>

          {/* ── Room connector stubs ── */}
          {data.rooms.map(r => (
            <path key={`conn-${r.id}`} d={connectorPath(r)}
              fill="none" stroke="#0d2a50" strokeWidth={2.5}/>
          ))}

          {/* ── Historical flow edges (very subtle) ── */}
          {data.edges.slice(0, 25).map((e, i) => {
            const a = roomMap[e.source], b = roomMap[e.target];
            if (!a || !b) return null;
            const ax = a.x + a.w / 2, bx = b.x + b.w / 2;
            const ay = a.y + a.h / 2, by = b.y + b.h / 2;
            const alpha = Math.round(10 + e.weight * 20).toString(16).padStart(2, "0");
            return (
              <path key={i}
                d={`M${ax},${ay} C${ax},${corridorY} ${bx},${corridorY} ${bx},${by}`}
                fill="none" stroke={`#1e4a7a${alpha}`} strokeWidth={0.5 + e.weight}
                markerEnd="url(#arr-hist)"/>
            );
          })}

          {/* ── Real trajectories from top variants ── */}
          {showTrajs && variants.slice(0, 8).map((v, vi) => {
            const color = TRAJ_PALETTE[vi % TRAJ_PALETTE.length];
            const d = buildPath(v.sequence);
            if (!d) return null;
            const opBase = Math.min(0.85, 0.15 + v.pct * 1.8);
            return (
              <g key={`traj-${vi}`}>
                <path d={d} fill="none" stroke={color} strokeWidth={6}
                  opacity={opBase * 0.18} strokeLinecap="round" strokeLinejoin="round"
                  filter="url(#glow)"/>
                <path d={d} fill="none" stroke={color} strokeWidth={1.8}
                  opacity={opBase} strokeLinecap="round" strokeLinejoin="round"/>
              </g>
            );
          })}

          {/* ── Room wall fill (hatch) ── */}
          {data.rooms.map(r => {
            const inJ = journeySet.has(r.id);
            return (
              <rect key={`hatch-${r.id}`}
                x={r.x} y={r.y} width={r.w} height={r.h}
                fill="url(#wall-hatch)" opacity={inJ ? 0.5 : 0.22}/>
            );
          })}

          {/* ── Room floor fill ── */}
          {data.rooms.map(r => {
            const color = locColor(r.id);
            const inJ = journeySet.has(r.id);
            const wall = 4;
            return (
              <rect key={`floor-${r.id}`}
                x={r.x + wall} y={r.y + wall}
                width={r.w - wall * 2} height={r.h - wall * 2}
                fill={inJ ? color + "18" : "#081626"}
                stroke="none"/>
            );
          })}

          {/* ── Room outlines (thick CAD walls) ── */}
          {data.rooms.map(r => {
            const color = locColor(r.id);
            const inJ = journeySet.has(r.id);
            const isHov = hovered === r.id;
            return (
              <g key={`outline-${r.id}`}
                onMouseEnter={() => { if (!dragRef.current) setHovered(r.id); }}
                onMouseLeave={() => setHovered(null)}
                style={{ cursor: "default" }}>

                {/* Outer glow for journey rooms */}
                {inJ && (
                  <rect x={r.x - 4} y={r.y - 4} width={r.w + 8} height={r.h + 8}
                    fill={color} opacity={0.07}
                    style={{ animation: "pulse-glow 2s ease-in-out infinite" }}/>
                )}

                {/* Wall outline */}
                <path d={roomOutlinePath(r)}
                  fill="none"
                  stroke={inJ ? color : "#1e3a5f"}
                  strokeWidth={inJ ? 2.2 : 1.5}
                  strokeLinejoin="round"
                  filter={inJ ? "url(#glow)" : undefined}
                  opacity={isHov ? 1 : inJ ? 0.9 : 0.6}/>

                {/* Door arc */}
                <path d={doorArc(r)}
                  fill="none"
                  stroke={inJ ? color + "cc" : "#1e3a5f88"}
                  strokeWidth={0.9}/>

                {/* Room name */}
                {(() => {
                  const words = r.label.split(/[\s_]+/);
                  const mid   = Math.ceil(words.length / 2);
                  const l1    = words.slice(0, mid).join(" ");
                  const l2    = words.slice(mid).join(" ");
                  const fc    = inJ ? color : "#2a5080";
                  const fw    = inJ ? "600" : "400";
                  const fs    = 9;
                  return (
                    <g>
                      <text x={r.x + r.w / 2} y={r.y + r.h / 2 - (l2 ? 6 : 0)}
                        textAnchor="middle" dominantBaseline="middle"
                        fill={fc} fontSize={fs} fontWeight={fw}>
                        {trunc(l1, 14)}
                      </text>
                      {l2 && (
                        <text x={r.x + r.w / 2} y={r.y + r.h / 2 + 10}
                          textAnchor="middle" dominantBaseline="middle"
                          fill={fc} fontSize={fs} fontWeight={fw}>
                          {trunc(l2, 14)}
                        </text>
                      )}
                    </g>
                  );
                })()}

                {/* Visit count (bottom) */}
                <text x={r.x + r.w / 2} y={r.y + r.h - 5}
                  textAnchor="middle"
                  fill={inJ ? color + "99" : "#1e3a5fcc"}
                  fontSize={7}>
                  {r.count}
                </text>

                {/* Hover overlay */}
                {isHov && (
                  <rect x={r.x} y={r.y} width={r.w} height={r.h}
                    fill={locColor(r.id)} opacity={0.06}
                    style={{ pointerEvents: "none" }}/>
                )}
              </g>
            );
          })}

          {/* ── Journey path glow ── */}
          {jPath && (
            <>
              <path d={jPath} fill="none"
                stroke="#22d3ee" strokeWidth={14} opacity={0.04}
                filter="url(#glow-strong)"/>
              <path d={jPath} fill="none"
                stroke="url(#j-grad)" strokeWidth={3}
                strokeLinecap="round" opacity={0.25}/>
            </>
          )}

          {/* ── Journey animated dashes ── */}
          {jPath && (
            <path d={jPath} fill="none"
              stroke="url(#j-grad)" strokeWidth={2.2}
              strokeDasharray="10 6" strokeLinecap="round"
              style={{ animation: "dash-flow 1s linear infinite" }}/>
          )}

          {/* ── Journey step badges ── */}
          {journey.map((id, i) => {
            const r = roomMap[id];
            if (!r) return null;
            const color = locColor(id);
            const cx = r.x + r.w / 2;
            return (
              <g key={`badge-${id}-${i}`} filter="url(#glow)">
                <circle cx={cx} cy={r.y - 10} r={10}
                  fill="#060d18" stroke={color} strokeWidth={1.8}/>
                <text x={cx} y={r.y - 10} textAnchor="middle" dominantBaseline="middle"
                  fill={color} fontSize={8.5} fontWeight="bold">{i + 1}</text>
              </g>
            );
          })}

          {/* ── Step connector dots along path ── */}
          {journey.map((id, i) => {
            if (i === 0) return null;
            const a = roomMap[journey[i - 1]], b = roomMap[id];
            if (!a || !b) return null;
            const mx = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
            const myv = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
            const color = locColor(id);
            return (
              <circle key={`dot-${i}`} cx={mx} cy={myv} r={3}
                fill={color} opacity={0.7} filter="url(#glow)"/>
            );
          })}

          {/* ── Hover tooltip ── */}
          {hoveredRoom && (() => {
            const r = hoveredRoom;
            const color = locColor(r.id);
            const tw = 172, th = 58;
            const tx = Math.min(Math.max(r.x + r.w / 2 - tw / 2, vb.x + 4), vb.x + vb.w - tw - 4);
            const ty = Math.max(r.y - th - 8, vb.y + 4);
            return (
              <g style={{ pointerEvents: "none" }}>
                {/* Shadow */}
                <rect x={tx + 2} y={ty + 2} width={tw} height={th} rx={4}
                  fill="#000" opacity={0.6}/>
                <rect x={tx} y={ty} width={tw} height={th} rx={4}
                  fill="#060d18" stroke={color + "55"} strokeWidth={1}/>
                {/* Top accent bar */}
                <rect x={tx} y={ty} width={tw} height={3} rx={4}
                  fill={color} opacity={0.8}/>
                <text x={tx + 8} y={ty + 18} fill={color} fontSize={9.5} fontWeight="700">
                  {trunc(r.label, 22)}
                </text>
                <text x={tx + 8} y={ty + 33} fill="#4a7aaa" fontSize={8}>
                  {r.count.toLocaleString()} passages · durée moy. {fmtMin(r.avg_duration_min)}
                </text>
                <text x={tx + 8} y={ty + 47} fill="#2a5070" fontSize={7.5}>
                  Position moy. : {Math.round(r.avg_pos * 100)}% du parcours
                </text>
              </g>
            );
          })()}

          {/* ── Scale bar (bottom-left) ── */}
          <g transform={`translate(16, ${CH - 30})`}>
            <rect x={0} y={0} width={scaleBarUnits} height={5} fill="#1e3a5f"/>
            <rect x={0} y={0} width={scaleBarUnits / 2} height={5} fill="#2a5080"/>
            <line x1={0} y1={0} x2={0} y2={-4} stroke="#2a5080" strokeWidth={1}/>
            <line x1={scaleBarUnits} y1={0} x2={scaleBarUnits} y2={-4} stroke="#2a5080" strokeWidth={1}/>
            <text x={0} y={15} fill="#2a5080" fontSize={7} fontWeight="600">0</text>
            <text x={scaleBarUnits} y={15} fill="#2a5080" fontSize={7} fontWeight="600" textAnchor="end">
              10 m
            </text>
          </g>

          {/* ── Title block (bottom-right) ── */}
          <g transform={`translate(${CW - 190}, ${CH - 50})`}>
            <rect x={0} y={0} width={186} height={46} fill="#030a14" stroke="#0d2a50" strokeWidth={1}/>
            <line x1={0} y1={16} x2={186} y2={16} stroke="#0d2a50" strokeWidth={0.8}/>
            <text x={93} y={11} textAnchor="middle" fill="#1e4976" fontSize={7.5} fontWeight="700" letterSpacing="1.5">
              URGENCES PÉDIATRIQUES
            </text>
            <text x={8} y={27} fill="#1a3a60" fontSize={7} fontWeight="600">PLAN 2D — PARCOURS PATIENT</text>
            <text x={8} y={38} fill="#102040" fontSize={6.5}>
              Échelle 1:{Math.round(1 / data.scale_m_per_unit * 100)}  ·  {new Date().toLocaleDateString("fr-FR")}
            </text>
            <text x={178} y={38} textAnchor="end" fill="#102040" fontSize={6.5}>IA Flux ED</text>
          </g>

          {/* ── North arrow (bottom-right corner) ── */}
          <g transform={`translate(${CW - 202}, ${CH - 42})`}>
            <polygon points="0,-14 4,0 0,-4 -4,0" fill="#1e3a5f"/>
            <polygon points="0,-4 4,0 0,0 -4,0" fill="#0d2040"/>
            <text x={0} y={8} textAnchor="middle" fill="#1e3a5f" fontSize={7} fontWeight="700">N</text>
          </g>
        </svg>
      </div>

      {/* Real trajectory legend */}
      {showTrajs && variants.length > 0 && (
        <div className="flex flex-wrap gap-3 px-1 pt-1">
          <span className="text-[10px] text-slate-600 font-semibold uppercase tracking-wider self-center">Trajets :</span>
          {variants.slice(0, 8).map((v, vi) => {
            const color = TRAJ_PALETTE[vi % TRAJ_PALETTE.length];
            const label = v.sequence
              .filter(id => roomMap[id])
              .map(id => id.split(/[\s_]+/).map(w => w[0]).join("").toUpperCase().slice(0, 3))
              .join("→");
            return (
              <div key={vi} className="inline-flex items-center gap-1.5 text-[10px]">
                <svg width={20} height={6}><line x1={0} y1={3} x2={20} y2={3} stroke={color} strokeWidth={2} strokeLinecap="round"/></svg>
                <span className="text-slate-500">{label || `T${vi + 1}`}</span>
                <span className="text-slate-700">({(v.pct * 100).toFixed(1)}%)</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-5 text-[10px] text-slate-600">
        <span className="flex items-center gap-1.5">
          <svg width={24} height={8}><line x1={0} y1={4} x2={18} y2={4} stroke="#22d3ee" strokeWidth={2} strokeDasharray="5 3"/><polygon points="18,1 24,4 18,7" fill="#22d3ee"/></svg>
          Parcours sélectionné (animé)
        </span>
        <span className="flex items-center gap-1.5">
          <Info size={9} />
          Molette = zoom · Glisser = déplacer · Survol = détails
        </span>
      </div>
    </div>
  );
}

// ─── Clinical categories ─────────────────────────────────────────────────────

type CatId = "admission" | "soins" | "imagerie" | "biologie" | "transfert" | "sortie" | "autres";

// Catégories basées sur les vrais noms du CSV (sep=";")
// Locations réelles : ATTENTE POST-TRI, REORIENTATION, BOX 1/2/3,
// IMAGERIE, SAUV PEDIATRIQUE, SALLE DE SUTURES/PLATRE,
// GYN-OBST, CS PED 1/2, ATTENTE EXAMEN, ATTENTE SORTIE,
// UHCD 5P/6F/..., COULOIR UHCD, UNV, POLICE, BENVENUTO

const CATEGORIES: { id: CatId; label: string; icon: string; color: string; order: number }[] = [
  { id: "admission", label: "Triage / Entrée",    icon: "🚦", color: "#34d399", order: 0 },
  { id: "soins",     label: "Soins / Boxes",      icon: "💊", color: "#a78bfa", order: 1 },
  { id: "imagerie",  label: "Imagerie",           icon: "🔬", color: "#60a5fa", order: 2 },
  { id: "biologie",  label: "Attente",            icon: "⏳", color: "#94a3b8", order: 3 },
  { id: "transfert", label: "UHCD / Hospit.",     icon: "🏥", color: "#f59e0b", order: 4 },
  { id: "sortie",    label: "Sortie / Réorientation", icon: "🚪", color: "#64748b", order: 5 },
  { id: "autres",    label: "Autres",             icon: "⚙️", color: "#818cf8", order: 6 },
];

function locCatId(name: string): CatId {
  const n = name.toUpperCase().trim();
  // Triage / entrée
  if (n.includes("POST-TRI") || n.includes("BENVENUTO") ||
      n === "IOA" || n.includes("TRI-IOA"))
    return "admission";
  // Attente (sauf sortie)
  if (n.startsWith("ATTENTE") && !n.includes("SORTIE"))
    return "biologie";
  // Imagerie
  if (n.includes("IMAGERIE") || n.includes("RADIO") || n.includes("SCANNER") ||
      n.includes("ECHO") || n.includes("IRM"))
    return "imagerie";
  // UHCD / hospitalisation
  if (n.includes("UHCD") || n.includes("UNV") || n === "HOSPITALISATION" ||
      n.includes("COULOIR UHCD"))
    return "transfert";
  // Sortie / réorientation
  if (n.includes("SORTIE") || n.includes("REORIENTATION") || n === "POLICE" ||
      n.includes("DÉPART") || n.includes("DEPART"))
    return "sortie";
  // Soins / boxes (BOX, SALLE, SAUV, ZT*, CS PED, GYN, COULOIR)
  if (n.includes("BOX") || n.includes("SALLE") || n.includes("SAUV") ||
      n.startsWith("ZT") || n.startsWith("CS ") || n.includes("GYN") ||
      n.includes("SUTURES") || n.includes("PLATRE") || n.includes("COULOIR") ||
      n.includes("SURVEILLANCE") || n.includes("DOUCHE"))
    return "soins";
  return "autres";
}

// ─── BlockGrid — blocs toujours visibles, groupés par catégorie ──────────────

function BlockGrid({
  availableLocs,
  predMap,
  onAdd,
}: {
  availableLocs: string[];
  predMap: Map<string, PathwayPrediction>;
  onAdd: (loc: string) => void;
}) {
  const [openCats, setOpenCats] = useState<Set<CatId>>(
    new Set(["admission", "soins", "imagerie", "biologie", "transfert", "sortie", "autres"])
  );

  // Group locs by category
  const grouped = new Map<CatId, string[]>();
  for (const cat of CATEGORIES) grouped.set(cat.id, []);
  for (const loc of availableLocs) {
    grouped.get(locCatId(loc))!.push(loc);
  }

  function toggleCat(id: CatId) {
    setOpenCats(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-2">
      {CATEGORIES.map(cat => {
        const locs = grouped.get(cat.id) ?? [];
        if (locs.length === 0) return null;
        const isOpen = openCats.has(cat.id);
        const nPred  = locs.filter(l => predMap.has(l)).length;

        return (
          <div key={cat.id} className="rounded-xl border border-slate-800/70 overflow-hidden">
            {/* Category header */}
            <button
              onClick={() => toggleCat(cat.id)}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-800/40 transition text-left"
              style={{ background: cat.color + "0a" }}>
              <span className="text-base leading-none">{cat.icon}</span>
              <span className="text-xs font-semibold flex-1" style={{ color: cat.color }}>
                {cat.label}
              </span>
              {nPred > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold text-slate-900"
                  style={{ background: cat.color }}>
                  <Activity size={8} /> {nPred} IA
                </span>
              )}
              <span className="text-[9px] text-slate-600 mr-1">{locs.length}</span>
              <svg width={10} height={10} viewBox="0 0 24 24" fill="none"
                stroke={cat.color + "aa"} strokeWidth={2.5}
                className={`flex-shrink-0 transition-transform duration-200 ${isOpen ? "rotate-90" : ""}`}>
                <path d="M9 18l6-6-6-6"/>
              </svg>
            </button>

            {/* Blocks grid */}
            {isOpen && (
              <div className="px-3 pb-3 pt-2 flex flex-wrap gap-2 border-t border-slate-800/50">
                {locs.map(loc => {
                  const pred    = predMap.get(loc);
                  const color   = locColor(loc);
                  const inits   = locInitials(loc);
                  const isTop   = pred && pred === [...predMap.values()].sort((a,b) => b.prob - a.prob)[0];
                  return (
                    <button key={loc} onClick={() => onAdd(loc)} title={loc}
                      className="relative flex items-center gap-2 px-3 py-2 rounded-xl border transition-all hover:scale-[1.04] active:scale-95"
                      style={{
                        borderColor: pred ? color + "88" : color + "28",
                        background:  pred ? color + "18" : color + "0a",
                        boxShadow:   pred ? `0 0 12px ${color}22` : undefined,
                      }}>
                      {/* initials badge */}
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[9px] font-bold flex-shrink-0"
                        style={{ background: color + "28", color }}>
                        {inits}
                      </div>
                      {/* name */}
                      <span className="text-[11px] font-medium max-w-[90px] text-left leading-tight"
                        style={{ color: pred ? "#f1f5f9" : "#94a3b8" }}>
                        {trunc(loc, 16)}
                      </span>
                      {/* probability badge */}
                      {pred && (
                        <span className="text-[10px] font-bold ml-1 flex-shrink-0" style={{ color }}>
                          {Math.round(pred.prob * 100)}%
                        </span>
                      )}
                      {/* ★ top */}
                      {isTop && (
                        <div className="absolute -top-2 -right-2 w-4 h-4 rounded-full flex items-center justify-center text-[8px] text-slate-900 font-bold"
                          style={{ background: color }}>★</div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── PathwayPuzzle ────────────────────────────────────────────────────────────

// ─── PathwayPuzzle ────────────────────────────────────────────────────────────

function PathwayPuzzle({
  sequence, setSequence, availableLocs,
}: {
  sequence: string[];
  setSequence: (s: string[]) => void;
  availableLocs: string[];
}) {
  const [result, setResult] = useState<PathwayNextResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.pathwayNext({ sequence }).then(res => {
      if (!cancelled) setResult(res);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sequence]); // eslint-disable-line react-hooks/exhaustive-deps

  function addStep(loc: string) { setSequence([...sequence, loc]); }
  function removeStep(i: number) { setSequence(sequence.filter((_, j) => j !== i)); }

  // Build prediction lookup map
  const predMap = new Map<string, PathwayPrediction>(
    (result?.predictions ?? []).map(p => [p.location, p])
  );

  const entropy = result?.entropy_bits ?? 0;
  const { text: eText, color: eColor } = entropyLabel(entropy);

  return (
    <div className="space-y-4">

      {/* ── Sequence ── */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Parcours en construction</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Cliquez sur les blocs ci-dessous pour ajouter des étapes · l'IA met à jour les prédictions à chaque ajout
            </p>
          </div>
          <div className="flex items-center gap-2">
            {loading && <Loader2 size={13} className="text-brand-400 animate-spin" />}
            <button onClick={() => { setSequence([]); setResult(null); }}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-700 text-slate-400 text-xs hover:bg-slate-800/50 transition">
              <RotateCcw size={11} /> Réinitialiser
            </button>
          </div>
        </div>

        {/* Tiles row */}
        <div className="flex items-center gap-2 flex-wrap min-h-[56px] p-2 rounded-xl bg-slate-800/30 border border-slate-800">
          {sequence.length === 0 ? (
            <span className="text-xs text-slate-600 italic flex items-center gap-2">
              <Shuffle size={12} className="text-slate-700" />
              Sélectionnez la première étape dans les blocs ci-dessous
            </span>
          ) : (
            sequence.map((loc, i) => (
              <div key={`${loc}-${i}`} className="flex items-center gap-1">
                <SequenceTile name={loc} step={i + 1} onRemove={() => removeStep(i)} />
                {i < sequence.length - 1 && <ChevronRight size={14} className="text-slate-700 flex-shrink-0" />}
              </div>
            ))
          )}
          {sequence.length > 0 && (
            <>
              <ChevronRight size={14} className="text-slate-700 flex-shrink-0" />
              <div className="px-3 py-1.5 rounded-lg border border-dashed border-slate-600 text-[10px] text-slate-600">
                + prochaine étape
              </div>
            </>
          )}
        </div>

        {/* Stats bar */}
        {result && (
          <div className="flex flex-wrap gap-3 pt-1">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">Patients similaires</span>
              <span className="font-bold text-slate-200">{result.n_matched.toLocaleString()}</span>
            </div>
            <div className="w-px h-4 bg-slate-700" />
            <div className="flex items-center gap-2 text-xs">
              <span className="text-slate-500">LOS restant estimé</span>
              <span className="font-bold text-cyan-300">{fmtMin(result.avg_remaining_los_min)}</span>
            </div>
            <div className="w-px h-4 bg-slate-700" />
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium" style={{ color: eColor }}>{eText}</span>
            </div>
            <div className="flex-1" />
            <EntropyBar bits={entropy} />
          </div>
        )}
      </div>

      {/* ── Block grid — always visible ── */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-100">Ajouter une étape</h3>
          {result && predMap.size > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold bg-brand-500/15 border border-brand-500/30 text-brand-300">
              <Activity size={8} /> {predMap.size} prédites par l'IA
            </span>
          )}
        </div>
        <BlockGrid availableLocs={availableLocs} predMap={predMap} onAdd={addStep} />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function PathwayIntelligence() {
  const [sequence, setSequence]   = useState<string[]>([]);
  const [floorPlan, setFloorPlan] = useState<FloorPlanData | null>(null);
  const [fpLoading, setFpLoading] = useState(true);
  const [variants,  setVariants]  = useState<Variant[]>([]);

  useEffect(() => {
    api.floorPlan()
      .then(setFloorPlan)
      .finally(() => setFpLoading(false));
    api.variants(15).then(setVariants).catch(() => {});
  }, []);

  // All available locations come from the floor plan (real data)
  const availableLocs = floorPlan?.rooms.map(r => r.id) ?? [];

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">Intelligence Parcours Patient</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Prédiction étape par étape · Chaîne de Markov bigramme ·
            Plan 2D avec distance parcourue estimée
          </p>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-brand-500/10 border border-brand-500/20 text-brand-300 text-[10px]">
          <Activity size={11} /> Modèle en temps réel
        </div>
      </div>

      {/* ── Puzzle ── */}
      {fpLoading ? (
        <div className="card p-8 flex items-center justify-center gap-2 text-slate-500">
          <Loader2 size={18} className="animate-spin" /> Chargement des zones…
        </div>
      ) : (
        <PathwayPuzzle
          sequence={sequence}
          setSequence={setSequence}
          availableLocs={availableLocs}
        />
      )}

      {/* ── Floor Plan ── */}
      <div className="card p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Plan 2D du service · disposition par étape de parcours
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Salles ordonnées de gauche (entrée) à droite (sortie) ·
            {sequence.length >= 2
              ? " trajet en surbrillance avec distance estimée"
              : " construisez un parcours pour voir le trajet"}
          </p>
        </div>

        {fpLoading ? (
          <div className="flex items-center justify-center h-64 text-slate-500 gap-2">
            <Loader2 size={18} className="animate-spin" /> Chargement du plan…
          </div>
        ) : floorPlan ? (
          <FloorPlanSVG data={floorPlan} journey={sequence} variants={variants} />
        ) : (
          <p className="text-xs text-rose-400">Erreur de chargement du plan.</p>
        )}
      </div>
    </div>
  );
}
