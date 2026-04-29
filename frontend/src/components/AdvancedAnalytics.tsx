import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, Clock, Image, RotateCcw, ShieldAlert, Stethoscope, TrendingUp,
} from "lucide-react";
import { api, type AdvancedAnalytics as AdvData } from "../api";
import { useFilters } from "../FiltersContext";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtMin(min: number | null | undefined): string {
  if (min == null || isNaN(min as number)) return "—";
  const m = Math.round(min as number);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}min` : `${h}h`;
}

// ─── SvgTip ───────────────────────────────────────────────────────────────────

function SvgTip({
  x, y, lines, viewW,
}: {
  x: number; y: number;
  lines: { text: string; color?: string }[];
  viewW: number;
}) {
  const TW = 148; const LH = 14; const PAD = 10;
  const TH = lines.length * LH + PAD;
  const tx = Math.min(Math.max(x - TW / 2, 3), viewW - TW - 3);
  const ty = Math.max(y - TH - 8, 3);
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect x={tx} y={ty} width={TW} height={TH} rx={5}
        fill="#0f172a" stroke="#334155" strokeWidth={0.8} opacity={0.97} />
      {lines.map((l, i) => (
        <text key={i} x={tx + 8} y={ty + PAD / 2 + (i + 1) * LH - 2}
          fontSize={9.5} fill={l.color ?? "#e2e8f0"}>{l.text}</text>
      ))}
    </g>
  );
}

// ─── FlowKpis ─────────────────────────────────────────────────────────────────

function FlowKpi({
  label, value, sub, accent, icon: Icon,
}: {
  label: string; value: string; sub: string; accent: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
}) {
  return (
    <div className="card p-4 relative overflow-hidden" style={{ borderColor: accent + "35" }}>
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: `radial-gradient(ellipse at 20% 40%, ${accent}10, transparent 65%)` }} />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{label}</span>
          <Icon size={14} style={{ color: accent }} />
        </div>
        <div className="text-xl font-bold font-mono tabular-nums" style={{ color: accent, textShadow: `0 0 16px ${accent}50` }}>
          {value}
        </div>
        <div className="text-[11px] text-slate-500 mt-1">{sub}</div>
      </div>
    </div>
  );
}

// ─── LocationHeatmap ──────────────────────────────────────────────────────────

function LocationHeatmap({ data }: { data: AdvData["location_heatmap"] }) {
  const [hov, setHov] = useState<{ r: number; c: number } | null>(null);
  const { locations, matrix, max } = data;
  const nL = locations.length;
  const W = 620; const H = nL * 22 + 42;
  const PL = 148; const PR = 8; const PT = 24; const PB = 18;
  const cW = W - PL - PR; const cH = H - PT - PB;
  const cw = cW / 24; const ch = cH / nL;

  function cellColor(val: number): string {
    const t = val / Math.max(max, 1);
    if (t === 0) return "#0f172a";
    const r = Math.round(34 + t * (6 - 34));
    const g = Math.round(211 + t * (182 - 211));
    const b = Math.round(238 + t * (212 - 238));
    return `rgb(${r},${g},${b})`;
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* hour labels */}
      {[0, 3, 6, 9, 12, 15, 18, 21, 23].map((h) => (
        <text key={h} x={PL + h * cw + cw / 2} y={PT - 6} fontSize={8} fill="#334155" textAnchor="middle">
          {String(h).padStart(2, "0")}
        </text>
      ))}

      {locations.map((loc, r) => (
        <g key={loc}>
          {/* location label */}
          <text x={PL - 5} y={PT + r * ch + ch / 2 + 3} fontSize={8.5}
            fill={hov?.r === r ? "#e2e8f0" : "#64748b"} textAnchor="end">
            {loc.length > 18 ? loc.slice(0, 17) + "…" : loc}
          </text>
          {matrix[r].map((val, c) => {
            const isH = hov?.r === r && hov?.c === c;
            return (
              <rect key={c}
                x={PL + c * cw + 1} y={PT + r * ch + 1}
                width={cw - 2} height={ch - 2} rx={1.5}
                fill={cellColor(val)}
                opacity={isH ? 1 : val === 0 ? 0.6 : 0.85}
                stroke={isH ? "#fff" : "none"} strokeWidth={0.8}
                style={{ cursor: val > 0 ? "pointer" : "default" }}
                onMouseEnter={() => setHov({ r, c })}
                onMouseLeave={() => setHov(null)}
              />
            );
          })}
        </g>
      ))}

      {hov && (() => {
        const val = matrix[hov.r]?.[hov.c] ?? 0;
        const x = PL + hov.c * cw + cw / 2;
        const y = PT + hov.r * ch;
        return (
          <SvgTip x={x} y={y} viewW={W} lines={[
            { text: locations[hov.r], color: "#94a3b8" },
            { text: `${String(hov.c).padStart(2, "0")}h00 – ${String(hov.c + 1).padStart(2, "0")}h00`, color: "#64748b" },
            { text: `Passages : ${val}`, color: "#22d3ee" },
          ]} />
        );
      })()}

      {/* color scale legend */}
      {[0, .25, .5, .75, 1].map((t, i) => {
        const val = Math.round(max * t);
        const x = PL + i * (cW / 4);
        return (
          <g key={i}>
            <rect x={x} y={H - 12} width={cW / 4 - 2} height={8} rx={1}
              fill={cellColor(val)} opacity={0.8} />
          </g>
        );
      })}
      <text x={PL}        y={H} fontSize={7.5} fill="#334155">0</text>
      <text x={W - PR}    y={H} fontSize={7.5} fill="#334155" textAnchor="end">{max}</text>
    </svg>
  );
}

// ─── LocationStatsChart ───────────────────────────────────────────────────────

function LocationStatsChart({ data }: { data: AdvData["location_stats"] }) {
  const [hov, setHov] = useState<number | null>(null);
  const maxVal = Math.max(...data.map((d) => d.p90_min), 1);
  const W = 580; const rowH = 28; const H = data.length * rowH + 48;
  const PL = 150; const PR = 80; const PT = 28; const PB = 20;
  const cW = W - PL - PR;

  const SERIES = [
    { key: "avg_min" as const,    color: "#22d3ee", label: "Moy" },
    { key: "median_min" as const, color: "#10b981", label: "Méd" },
    { key: "p90_min" as const,    color: "#f59e0b", label: "P90" },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* legend */}
      {SERIES.map((s, i) => (
        <g key={s.key}>
          <rect x={PL + i * 70} y={8} width={10} height={10} rx={2} fill={s.color} opacity={0.8} />
          <text x={PL + i * 70 + 14} y={17} fontSize={9} fill="#64748b">{s.label}</text>
        </g>
      ))}

      {/* grid lines */}
      {[0, .25, .5, .75, 1].map((f, i) => {
        const x = PL + f * cW;
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={PT} y2={H - PB} stroke="#1e293b" strokeWidth={0.8} />
            <text x={x} y={PT - 4} fontSize={7.5} fill="#334155" textAnchor="middle">
              {fmtMin(maxVal * f)}
            </text>
          </g>
        );
      })}

      {data.map((d, i) => {
        const y = PT + i * rowH;
        const isH = hov === i;
        return (
          <g key={d.location}
            onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
            style={{ cursor: "default" }}>
            {isH && (
              <rect x={0} y={y} width={W} height={rowH - 2} fill="#ffffff" fillOpacity={0.03} rx={2} />
            )}
            <text x={PL - 5} y={y + rowH / 2 + 3.5} fontSize={8.5}
              fill={isH ? "#e2e8f0" : "#64748b"} textAnchor="end">
              {d.location.length > 18 ? d.location.slice(0, 17) + "…" : d.location}
            </text>
            {SERIES.map((s, si) => {
              const val = d[s.key];
              const bw = (val / maxVal) * cW;
              return (
                <g key={s.key}>
                  <rect x={PL} y={y + si * 7 + 2} width={Math.max(bw, 2)} height={5} rx={2}
                    fill={s.color} fillOpacity={isH ? 1 : 0.7}
                    style={{ filter: isH ? `drop-shadow(0 0 3px ${s.color})` : "none" }} />
                </g>
              );
            })}
            <text x={PL + (d.p90_min / maxVal) * cW + 4} y={y + rowH / 2 + 3} fontSize={8}
              fill="#475569">{fmtMin(d.p90_min)}</text>

            {isH && (
              <SvgTip x={PL + (d.p90_min / maxVal) * cW} y={y} viewW={W} lines={[
                { text: d.location, color: "#94a3b8" },
                { text: `Moy : ${fmtMin(d.avg_min)}`,    color: "#22d3ee" },
                { text: `Méd : ${fmtMin(d.median_min)}`, color: "#10b981" },
                { text: `P90 : ${fmtMin(d.p90_min)}`,    color: "#f59e0b" },
                { text: `${d.n_visits} visites`,          color: "#64748b" },
              ]} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── WeekdayChart ─────────────────────────────────────────────────────────────

function WeekdayChart({ data }: { data: AdvData["weekday_pattern"] }) {
  const [hov, setHov] = useState<number | null>(null);
  const maxC = Math.max(...data.map((d) => d.count), 1);
  const maxL = Math.max(...data.map((d) => d.avg_los), 1);
  const W = 400; const H = 160;
  const PL = 32; const PR = 10; const PT = 16; const PB = 24;
  const cW = W - PL - PR; const cH = H - PT - PB;
  const bw = cW / data.length;

  const toYL = (v: number) => PT + cH - (v / maxL) * cH;
  const pathL = data.map((d, i) => {
    const x = PL + i * bw + bw / 2;
    return `${i === 0 ? "M" : "L"}${x},${toYL(d.avg_los)}`;
  }).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {[0, .5, 1].map((f, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={PT + cH * (1 - f)} y2={PT + cH * (1 - f)}
          stroke="#1e293b" strokeWidth={1} />
      ))}
      <text x={PL - 3} y={PT + 4} fontSize={8} fill="#22d3ee" textAnchor="end">{maxC}</text>
      <text x={PL - 3} y={H - PB + 4} fontSize={8} fill="#22d3ee" textAnchor="end">0</text>

      {data.map((d, i) => {
        const bh = Math.max((d.count / maxC) * cH, 2);
        const x  = PL + i * bw + 3;
        const y  = PT + cH - bh;
        const isH = hov === i;
        const isWe = i >= 5;
        const color = isWe ? "#f472b6" : "#22d3ee";
        return (
          <g key={d.day} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
            style={{ cursor: "pointer" }}>
            {isH && <rect x={x - 2} y={PT} width={bw - 2} height={cH} fill="#fff" fillOpacity={0.04} rx={2} />}
            <rect x={x} y={y} width={Math.max(bw - 6, 4)} height={bh} rx={3}
              fill={color} fillOpacity={isH ? 1 : 0.65}
              style={{ filter: isH ? `drop-shadow(0 0 4px ${color})` : "none" }} />
            <text x={x + (bw - 6) / 2} y={H - 6} fontSize={9} fill={isH ? "#e2e8f0" : "#475569"} textAnchor="middle">
              {d.day}
            </text>
            {isH && (
              <SvgTip x={x + bw / 2} y={y} viewW={W} lines={[
                { text: d.day, color: "#94a3b8" },
                { text: `Passages : ${d.count}`, color },
                { text: `LOS moy : ${fmtMin(d.avg_los)}`, color: "#8b5cf6" },
                { text: `Hospit : ${d.hospit_pct}%`, color: "#f59e0b" },
              ]} />
            )}
          </g>
        );
      })}

      {/* LOS line */}
      <path d={pathL} fill="none" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="4,3"
        style={{ filter: "drop-shadow(0 0 3px #8b5cf6)" }} />
      {data.map((d, i) => {
        const x = PL + i * bw + bw / 2;
        return <circle key={i} cx={x} cy={toYL(d.avg_los)} r={2.5} fill="#8b5cf6" />;
      })}
    </svg>
  );
}

// ─── MonthlyChart ─────────────────────────────────────────────────────────────

function MonthlyChart({ data }: { data: AdvData["monthly_pattern"] }) {
  const [hov, setHov] = useState<number | null>(null);
  const active = data.filter((d) => d.count > 0);
  const maxC = Math.max(...data.map((d) => d.count), 1);
  const maxL = Math.max(...data.map((d) => d.avg_los), 1);
  const W = 580; const H = 160;
  const PL = 32; const PR = 10; const PT = 16; const PB = 24;
  const cW = W - PL - PR; const cH = H - PT - PB;
  const bw = cW / data.length;

  const toYL = (v: number) => PT + cH - (v / maxL) * cH;
  const pathL = active.map((d) => {
    const i = data.indexOf(d);
    const x = PL + i * bw + bw / 2;
    return `${d === active[0] ? "M" : "L"}${x},${toYL(d.avg_los)}`;
  }).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {[0, .5, 1].map((f, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={PT + cH * (1 - f)} y2={PT + cH * (1 - f)}
          stroke="#1e293b" strokeWidth={1} />
      ))}
      <text x={PL - 3} y={PT + 4} fontSize={8} fill="#22d3ee" textAnchor="end">{maxC}</text>

      {data.map((d, i) => {
        const bh = Math.max((d.count / maxC) * cH, d.count > 0 ? 2 : 0);
        const x  = PL + i * bw + 3;
        const y  = PT + cH - bh;
        const isH = hov === i;
        return (
          <g key={d.month} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
            style={{ cursor: "pointer" }}>
            {isH && <rect x={x - 2} y={PT} width={bw - 2} height={cH} fill="#fff" fillOpacity={0.04} rx={2} />}
            <rect x={x} y={y} width={Math.max(bw - 6, 4)} height={bh} rx={3}
              fill="#22d3ee" fillOpacity={isH ? 1 : d.count > 0 ? 0.65 : 0.1}
              style={{ filter: isH ? "drop-shadow(0 0 4px #22d3ee)" : "none" }} />
            <text x={x + (bw - 6) / 2} y={H - 6} fontSize={8} fill={isH ? "#e2e8f0" : "#334155"} textAnchor="middle">
              {d.month}
            </text>
            {isH && d.count > 0 && (
              <SvgTip x={x + bw / 2} y={y} viewW={W} lines={[
                { text: d.month, color: "#94a3b8" },
                { text: `Passages : ${d.count}`, color: "#22d3ee" },
                { text: `LOS moy : ${fmtMin(d.avg_los)}`, color: "#8b5cf6" },
              ]} />
            )}
          </g>
        );
      })}

      {active.length > 1 && (
        <>
          <path d={pathL} fill="none" stroke="#8b5cf6" strokeWidth={1.5} strokeDasharray="4,3"
            style={{ filter: "drop-shadow(0 0 3px #8b5cf6)" }} />
          {active.map((d) => {
            const i = data.indexOf(d);
            const x = PL + i * bw + bw / 2;
            return <circle key={i} cx={x} cy={toYL(d.avg_los)} r={2.5} fill="#8b5cf6" />;
          })}
        </>
      )}
    </svg>
  );
}

// ─── ExitByHourChart ─────────────────────────────────────────────────────────

function ExitByHourChart({ data }: { data: AdvData["exit_by_hour"] }) {
  const [hov, setHov] = useState<number | null>(null);
  const maxT = Math.max(...data.map((d) => d.total), 1);
  const W = 620; const H = 160;
  const PL = 28; const PR = 8; const PT = 16; const PB = 24;
  const cW = W - PL - PR; const cH = H - PT - PB;
  const bw = cW / 24;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <defs>
        <linearGradient id="exitRet" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity=".9" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity=".3" />
        </linearGradient>
        <linearGradient id="exitHos" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#8b5cf6" stopOpacity=".9" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity=".3" />
        </linearGradient>
      </defs>

      {[0, .5, 1].map((f, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={PT + cH * (1 - f)} y2={PT + cH * (1 - f)}
          stroke="#1e293b" strokeWidth={1} />
      ))}

      {data.map((d) => {
        const x    = PL + d.hour * bw + 2;
        const totH = Math.max((d.total / maxT) * cH, d.total > 0 ? 1 : 0);
        const retH = totH > 0 ? (d.retour_domicile / Math.max(d.total, 1)) * totH : 0;
        const hosH = totH - retH;
        const isH  = hov === d.hour;
        return (
          <g key={d.hour}
            onMouseEnter={() => setHov(d.hour)} onMouseLeave={() => setHov(null)}
            style={{ cursor: "pointer" }}>
            {isH && <rect x={x - 1} y={PT} width={bw - 2} height={cH} fill="#fff" fillOpacity={0.04} rx={2} />}
            {/* hospit (bottom) */}
            <rect x={x} y={PT + cH - totH} width={Math.max(bw - 4, 1)} height={Math.max(hosH, 0)}
              fill="url(#exitHos)" rx={d.retour_domicile === 0 ? 2 : 0}
              style={{ filter: isH ? "drop-shadow(0 0 3px #8b5cf6)" : "none" }} />
            {/* retour (top) */}
            <rect x={x} y={PT + cH - totH + hosH} width={Math.max(bw - 4, 1)} height={Math.max(retH, 0)}
              fill="url(#exitRet)" rx={2}
              style={{ filter: isH ? "drop-shadow(0 0 3px #22d3ee)" : "none" }} />
            {d.hour % 3 === 0 && (
              <text x={x + bw / 2} y={H - 6} fontSize={8} fill={isH ? "#e2e8f0" : "#334155"} textAnchor="middle">
                {String(d.hour).padStart(2, "0")}h
              </text>
            )}
            {isH && d.total > 0 && (
              <SvgTip x={x + bw / 2} y={PT + cH - totH} viewW={W} lines={[
                { text: `${String(d.hour).padStart(2, "0")}h00 – ${String(d.hour + 1).padStart(2, "0")}h00`, color: "#94a3b8" },
                { text: `Total sorties : ${d.total}`, color: "#e2e8f0" },
                { text: `Domicile : ${d.retour_domicile}`, color: "#22d3ee" },
                { text: `Hospitalisation : ${d.hospitalisation}`, color: "#8b5cf6" },
              ]} />
            )}
          </g>
        );
      })}
      <text x={PL - 3} y={PT + 4} fontSize={8} fill="#64748b" textAnchor="end">{maxT}</text>
    </svg>
  );
}

// ─── SauvTrendChart ───────────────────────────────────────────────────────────

function SauvTrendChart({ data }: { data: AdvData["sauv_trend"] }) {
  const [hov, setHov] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  if (data.length === 0) return (
    <div className="h-24 flex items-center justify-center text-slate-600 text-xs">Aucune donnée</div>
  );
  const max = Math.max(...data.map((d) => d.n_patients), 1);
  const W = 460; const H = 130;
  const PL = 30; const PR = 10; const PT = 14; const PB = 24;
  const cW = W - PL - PR; const cH = H - PT - PB;

  const toX = (i: number) => PL + (i / Math.max(data.length - 1, 1)) * cW;
  const toY = (v: number) => PT + cH - (v / max) * cH;
  const pathP = data.map((d, i) => `${i === 0 ? "M" : "L"}${toX(i)},${toY(d.n_patients)}`).join(" ");
  const area  = `${pathP} L${toX(data.length - 1)},${H - PB} L${PL},${H - PB}Z`;

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const norm = Math.max(0, Math.min((svgX - PL) / cW, 1));
    setHov(Math.round(norm * (data.length - 1)));
  }

  const hd = hov !== null ? data[hov] : null;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <defs>
        <linearGradient id="sauvArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f43f5e" stopOpacity=".3" />
          <stop offset="100%" stopColor="#f43f5e" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, .5, 1].map((f, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={PT + cH * (1 - f)} y2={PT + cH * (1 - f)}
          stroke="#1e293b" strokeWidth={1} />
      ))}
      <path d={area} fill="url(#sauvArea)" />
      <path d={pathP} fill="none" stroke="#f43f5e" strokeWidth={2}
        style={{ filter: "drop-shadow(0 0 4px #f43f5e)" }} />

      {data.map((d, i) => {
        const short = d.month.slice(0, 7);
        return (i % 2 === 0 || i === data.length - 1) ? (
          <text key={i} x={toX(i)} y={H - 4} fontSize={7.5} fill="#334155" textAnchor="middle">
            {short}
          </text>
        ) : null;
      })}
      <text x={PL - 3} y={PT + 4} fontSize={8} fill="#f43f5e" textAnchor="end">{max}</text>

      {hov !== null && hd && (() => {
        const hx = toX(hov); const hy = toY(hd.n_patients);
        return (
          <>
            <line x1={hx} x2={hx} y1={PT} y2={H - PB} stroke="#fff" strokeWidth={0.8} strokeDasharray="3,3" opacity={0.3} />
            <circle cx={hx} cy={hy} r={4} fill="#f43f5e" stroke="#0f172a" strokeWidth={1.5}
              style={{ filter: "drop-shadow(0 0 4px #f43f5e)" }} />
            <SvgTip x={hx} y={hy} viewW={W} lines={[
              { text: hd.month, color: "#94a3b8" },
              { text: `Patients SAUV : ${hd.n_patients}`, color: "#f43f5e" },
            ]} />
          </>
        );
      })()}
      <rect x={PL} y={PT} width={cW} height={cH} fill="transparent"
        onMouseMove={onMove} onMouseLeave={() => setHov(null)} />
    </svg>
  );
}

// ─── UhcdSummary ──────────────────────────────────────────────────────────────

function UhcdSummary({ data }: { data: AdvData["uhcd_stats"] }) {
  const trend = data.monthly_trend;
  const maxT = Math.max(...trend.map((d) => d.count), 1);
  const W = 260; const H = 60;
  const PL = 4; const PR = 4; const PT = 4; const PB = 4;
  const cW = W - PL - PR; const cH = H - PT - PB;
  const bw = cW / Math.max(trend.length, 1);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {[
          { label: "Dossiers UHCD",   val: `${data.n_dossiers}`,          color: "#8b5cf6" },
          { label: "% du total",       val: `${data.pct_of_total}%`,       color: "#8b5cf6" },
          { label: "Durée moyenne",    val: fmtMin(data.avg_min),          color: "#22d3ee" },
          { label: "Durée médiane",    val: fmtMin(data.median_min),       color: "#10b981" },
        ].map((item) => (
          <div key={item.label} className="bg-slate-900/60 rounded-lg p-2.5">
            <div className="text-[10px] text-slate-500 uppercase">{item.label}</div>
            <div className="text-base font-bold font-mono" style={{ color: item.color }}>
              {item.val}
            </div>
          </div>
        ))}
      </div>
      {trend.length > 1 && (
        <>
          <div className="text-[10px] text-slate-500 uppercase tracking-widest">Tendance mensuelle</div>
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
            {trend.map((d, i) => {
              const bh = Math.max((d.count / maxT) * cH, 1);
              const x  = PL + i * bw + 1;
              const y  = PT + cH - bh;
              return (
                <rect key={i} x={x} y={y} width={Math.max(bw - 2, 1)} height={bh} rx={1.5}
                  fill="#8b5cf6" fillOpacity={0.7} />
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function AdvancedAnalytics() {
  const { filters } = useFilters();
  const [data, setData] = useState<AdvData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const d = await api.advancedAnalytics(filters);
    setData(d);
  }, [filters]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  if (loading) {
    return (
      <div className="min-h-96 flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
        <div className="text-xs font-mono tracking-[.3em] text-brand-500 uppercase animate-pulse">
          Analyse en cours…
        </div>
      </div>
    );
  }

  if (!data) return null;
  const { flow_metrics: fm, location_heatmap, location_stats,
    weekday_pattern, monthly_pattern, exit_by_hour, uhcd_stats, sauv_trend } = data;

  return (
    <div className="space-y-5">

      {/* ── FLOW KPIs ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <FlowKpi
          label="Délai avant 1er soin"
          value={fmtMin(fm.delai_premier_soin.median)}
          sub={`moy ${fmtMin(fm.delai_premier_soin.mean)} · P90 ${fmtMin(fm.delai_premier_soin.p90)}`}
          accent="#22d3ee" icon={Stethoscope}
        />
        <FlowKpi
          label="Attente sortie"
          value={fmtMin(fm.attente_sortie.avg_min)}
          sub={`${fm.attente_sortie.n_visits} passages · P90 ${fmtMin(fm.attente_sortie.p90_min)}`}
          accent="#f59e0b" icon={Clock}
        />
        <FlowKpi
          label="Durée imagerie"
          value={fmtMin(fm.imagerie.avg_min)}
          sub={`${fm.imagerie.n_visits} examens · P90 ${fmtMin(fm.imagerie.p90_min)}`}
          accent="#8b5cf6" icon={Image}
        />
        <FlowKpi
          label="Taux réorientation"
          value={`${fm.reorientation_rate}%`}
          sub={`${fm.reorientation_count} dossiers réorientés`}
          accent="#f43f5e" icon={RotateCcw}
        />
      </div>

      {/* ── LOCATION HEATMAP ── */}
      <div className="card p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
            Heatmap Locaux × Heure
          </h3>
          <span className="text-[10px] text-slate-600 font-mono">survol → détails · intensité = passages</span>
        </div>
        <LocationHeatmap data={location_heatmap} />
      </div>

      {/* ── LOCATION STATS ── */}
      <div className="card p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
            Durées par local — Moyenne / Médiane / P90
          </h3>
          <div className="flex items-center gap-4 text-[10px] font-mono text-slate-600">
            <span><span className="text-cyan-400">■</span> Moy</span>
            <span><span className="text-emerald-400">■</span> Méd</span>
            <span><span className="text-amber-400">■</span> P90</span>
          </div>
        </div>
        <LocationStatsChart data={location_stats} />
      </div>

      {/* ── WEEKDAY + MONTHLY ── */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
              Profil jour de semaine
            </h3>
            <div className="flex items-center gap-3 text-[10px] font-mono text-slate-600">
              <span><span className="text-cyan-400">■</span> Volume</span>
              <span className="text-pink-400">■ Weekend</span>
              <span><span className="text-brand-400">- -</span> LOS moy</span>
            </div>
          </div>
          <WeekdayChart data={weekday_pattern} />
        </div>
        <div className="card p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
              Profil mensuel
            </h3>
            <div className="flex items-center gap-3 text-[10px] font-mono text-slate-600">
              <span><span className="text-cyan-400">■</span> Volume</span>
              <span><span className="text-brand-400">- -</span> LOS moy</span>
            </div>
          </div>
          <MonthlyChart data={monthly_pattern} />
        </div>
      </div>

      {/* ── EXIT BY HOUR ── */}
      <div className="card p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
            Sorties par heure — Retour domicile vs Hospitalisation
          </h3>
          <div className="flex items-center gap-4 text-[10px] font-mono text-slate-600">
            <span><span className="text-cyan-400">■</span> Retour domicile</span>
            <span><span className="text-brand-400">■</span> Hospitalisation</span>
          </div>
        </div>
        <ExitByHourChart data={exit_by_hour} />
      </div>

      {/* ── SAUV + UHCD ── */}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-4 lg:col-span-2">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center gap-2">
              <ShieldAlert size={12} className="text-rose-400" />
              Flux SAUV — Patients critiques par mois
            </h3>
            <span className="text-[10px] text-slate-600 font-mono">survol → détail</span>
          </div>
          <SauvTrendChart data={sauv_trend} />
        </div>
        <div className="card p-4">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-3 flex items-center gap-2">
            <Activity size={12} className="text-brand-400" />
            UHCD — Unité courte durée
          </h3>
          <UhcdSummary data={uhcd_stats} />
        </div>
      </div>

      {/* ── ALERT INSIGHTS ── */}
      <div className="grid md:grid-cols-3 gap-3">
        {fm.delai_premier_soin.median > 45 && (
          <div className="card p-3 border-amber-500/30 bg-amber-500/5">
            <div className="flex items-center gap-2 text-xs text-amber-300 font-semibold mb-1">
              <TrendingUp size={12} /> Délai soin élevé
            </div>
            <div className="text-[11px] text-slate-400">
              Médiane {fmtMin(fm.delai_premier_soin.median)} avant le 1er soin — cible recommandée &lt; 30 min
            </div>
          </div>
        )}
        {fm.attente_sortie.p90_min > 60 && (
          <div className="card p-3 border-rose-500/30 bg-rose-500/5">
            <div className="flex items-center gap-2 text-xs text-rose-300 font-semibold mb-1">
              <Clock size={12} /> Blocage sortie
            </div>
            <div className="text-[11px] text-slate-400">
              P90 ATTENTE SORTIE = {fmtMin(fm.attente_sortie.p90_min)} — risque de blocage de box
            </div>
          </div>
        )}
        {fm.reorientation_rate > 20 && (
          <div className="card p-3 border-cyan-500/30 bg-cyan-500/5">
            <div className="flex items-center gap-2 text-xs text-cyan-300 font-semibold mb-1">
              <RotateCcw size={12} /> Réorientation fréquente
            </div>
            <div className="text-[11px] text-slate-400">
              {fm.reorientation_rate}% des dossiers passent par la réorientation
            </div>
          </div>
        )}
      </div>

    </div>
  );
}
