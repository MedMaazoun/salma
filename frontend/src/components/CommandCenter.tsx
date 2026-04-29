import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Clock, Heart,
  RefreshCw, TrendingDown, TrendingUp, Users, Zap, CalendarRange,
} from "lucide-react";
import { api, type CommandCenterData } from "../api";
import { useFilters } from "../FiltersContext";
import { useDrillDown } from "../DrillDownContext";

// ─── utils ────────────────────────────────────────────────────────────────────

function fmtMin(min: number | null | undefined): string {
  if (min == null || isNaN(min as number)) return "—";
  const m = Math.round(min as number);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}min` : `${h}h`;
}

function useCountUp(target: number, duration = 1400): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    const t0 = performance.now();
    let raf: number;
    const tick = (now: number) => {
      const p = Math.min((now - t0) / duration, 1);
      setVal(Math.round((1 - Math.pow(1 - p, 3)) * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return val;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arc(cx: number, cy: number, r: number, a1: number, a2: number): string {
  const [x1, y1] = polar(cx, cy, r, a1);
  const [x2, y2] = polar(cx, cy, r, a2);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

// ─── SvgTooltip ───────────────────────────────────────────────────────────────

function SvgTooltip({
  x, y, lines, viewW,
}: {
  x: number; y: number;
  lines: { text: string; color?: string }[];
  viewW: number;
}) {
  const TW = 140; const lineH = 14; const pad = 10;
  const TH = lines.length * lineH + pad;
  const tx = Math.min(Math.max(x - TW / 2, 4), viewW - TW - 4);
  const ty = Math.max(y - TH - 10, 4);
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect x={tx} y={ty} width={TW} height={TH} rx={5}
        fill="#0f172a" stroke="#334155" strokeWidth={0.8} opacity={0.97} />
      {lines.map((l, i) => (
        <text key={i} x={tx + 8} y={ty + pad / 2 + (i + 1) * lineH - 2}
          fontSize={9.5} fill={l.color ?? "#e2e8f0"}>{l.text}</text>
      ))}
    </g>
  );
}

// ─── DateRangeSlider ──────────────────────────────────────────────────────────

const DS_START = "2024-12-31";
const DS_DAYS  = 313; // dataset span in days (2024-12-31 → 2025-11-09)

const MONTH_TICKS: { label: string; day: number }[] = [
  { label: "Jan",  day: 1   },
  { label: "Fév",  day: 32  },
  { label: "Mar",  day: 60  },
  { label: "Avr",  day: 91  },
  { label: "Mai",  day: 121 },
  { label: "Jun",  day: 152 },
  { label: "Jul",  day: 182 },
  { label: "Aoû",  day: 213 },
  { label: "Sep",  day: 244 },
  { label: "Oct",  day: 274 },
  { label: "Nov",  day: 305 },
];

function dateToDay(dateStr: string): number {
  return Math.round(
    (new Date(dateStr).getTime() - new Date(DS_START).getTime()) / 86400000
  );
}
function dayToDateStr(day: number): string {
  const d = new Date(DS_START);
  d.setDate(d.getDate() + day);
  return d.toISOString().slice(0, 10);
}
function fmtDateShort(s: string): string {
  return new Date(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
}

const PRESETS: { label: string; days: number | null }[] = [
  { label: "7J",   days: 7   },
  { label: "30J",  days: 30  },
  { label: "90J",  days: 90  },
  { label: "Tout", days: null },
];

function DateRangeSlider() {
  const { filters, setFilters } = useFilters();

  const initFrom = filters.date_from ? dateToDay(filters.date_from) : 0;
  const initTo   = filters.date_to   ? dateToDay(filters.date_to)   : DS_DAYS;

  const [localFrom, setLocalFrom] = useState(initFrom);
  const [localTo,   setLocalTo]   = useState(initTo);

  // Sync when filters change from outside
  useEffect(() => {
    setLocalFrom(filters.date_from ? dateToDay(filters.date_from) : 0);
    setLocalTo(filters.date_to ? dateToDay(filters.date_to) : DS_DAYS);
  }, [filters.date_from, filters.date_to]);

  function commit(from: number, to: number) {
    setFilters({
      ...filters,
      date_from: from === 0 ? null : dayToDateStr(from),
      date_to:   to === DS_DAYS ? null : dayToDateStr(to),
    });
  }

  function applyPreset(days: number | null) {
    if (days === null) {
      setLocalFrom(0); setLocalTo(DS_DAYS);
      commit(0, DS_DAYS);
    } else {
      const to   = DS_DAYS;
      const from = Math.max(0, to - days);
      setLocalFrom(from); setLocalTo(to);
      commit(from, to);
    }
  }

  const pctFrom = (localFrom / DS_DAYS) * 100;
  const pctTo   = (localTo   / DS_DAYS) * 100;

  const isAllData = localFrom === 0 && localTo === DS_DAYS;
  const activePreset =
    isAllData ? null :
    localTo === DS_DAYS && DS_DAYS - localFrom <= 7  ? 7  :
    localTo === DS_DAYS && DS_DAYS - localFrom <= 30 ? 30 :
    localTo === DS_DAYS && DS_DAYS - localFrom <= 90 ? 90 : null;

  return (
    <div className="flex flex-col gap-2.5 w-full">
      {/* Top row: icon + range label + presets */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400 font-mono flex-shrink-0">
          <CalendarRange size={13} className="text-cyan-400" />
          <span className="text-cyan-300 font-semibold">
            {isAllData
              ? "Toutes les données"
              : `${fmtDateShort(dayToDateStr(localFrom))} → ${fmtDateShort(dayToDateStr(localTo))}`
            }
          </span>
          {!isAllData && (
            <span className="text-slate-600">
              ({localTo - localFrom}j)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          {PRESETS.map((p) => {
            const active = p.days === null ? isAllData : activePreset === p.days;
            return (
              <button
                key={p.label}
                onClick={() => applyPreset(p.days)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-mono font-semibold transition border ${
                  active
                    ? "bg-cyan-500/20 border-cyan-500/40 text-cyan-300"
                    : "border-slate-700/60 text-slate-500 hover:text-slate-300 hover:border-slate-600"
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Slider track */}
      <div className="relative h-8 select-none">
        {/* Background track */}
        <div className="absolute top-1/2 -translate-y-1/2 left-0 right-0 h-1.5 rounded-full bg-slate-800" />

        {/* Filled track */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-1.5 rounded-full"
          style={{
            left:  `${pctFrom}%`,
            right: `${100 - pctTo}%`,
            background: "linear-gradient(90deg, #0891b2, #22d3ee)",
            boxShadow: "0 0 6px #22d3ee50",
          }}
        />

        {/* Month ticks */}
        {MONTH_TICKS.map((t) => (
          <div
            key={t.label}
            className="absolute top-1/2 -translate-y-1/2 w-px h-2 bg-slate-700"
            style={{ left: `${(t.day / DS_DAYS) * 100}%` }}
          />
        ))}

        {/* Left thumb (from) */}
        <input
          type="range"
          min={0} max={DS_DAYS} step={1}
          value={localFrom}
          className="range-thumb"
          style={{ zIndex: localFrom >= localTo - 5 ? 5 : 3 }}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), localTo - 1);
            setLocalFrom(v);
          }}
          onMouseUp={() => commit(localFrom, localTo)}
          onTouchEnd={() => commit(localFrom, localTo)}
        />

        {/* Right thumb (to) */}
        <input
          type="range"
          min={0} max={DS_DAYS} step={1}
          value={localTo}
          className="range-thumb"
          style={{ zIndex: 4 }}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), localFrom + 1);
            setLocalTo(v);
          }}
          onMouseUp={() => commit(localFrom, localTo)}
          onTouchEnd={() => commit(localFrom, localTo)}
        />
      </div>

      {/* Month labels */}
      <div className="relative h-4">
        {MONTH_TICKS.map((t) => (
          <span
            key={t.label}
            className="absolute text-[9px] text-slate-600 -translate-x-1/2 select-none"
            style={{ left: `${(t.day / DS_DAYS) * 100}%` }}
          >
            {t.label}
          </span>
        ))}
        <span className="absolute text-[9px] text-slate-600 right-0 select-none">Nov</span>
      </div>
    </div>
  );
}

// ─── LiveClock ────────────────────────────────────────────────────────────────

function LiveClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="font-mono tabular-nums text-cyan-200 text-xl tracking-widest select-none">
      {now.toLocaleTimeString("fr-FR")}
    </span>
  );
}

// ─── KpiCard ──────────────────────────────────────────────────────────────────

function KpiCard({
  title, value, display, sub, accent, icon: Icon, trend,
}: {
  title: string; value: number; display?: string; sub?: string;
  accent: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>; trend?: "up" | "down";
}) {
  const counted = useCountUp(value);
  return (
    <div className="card p-4 relative overflow-hidden" style={{ borderColor: accent + "35" }}>
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: `radial-gradient(ellipse at 20% 40%, ${accent}12, transparent 65%)` }} />
      <div className="relative">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] uppercase tracking-widest text-slate-500 font-bold">{title}</span>
          <Icon size={15} style={{ color: accent }} />
        </div>
        <div className="text-2xl font-bold font-mono tabular-nums leading-none"
          style={{ color: accent, textShadow: `0 0 20px ${accent}60` }}>
          {display ?? counted.toLocaleString("fr-FR")}
        </div>
        {sub && (
          <div className="text-[11px] text-slate-500 mt-1.5 flex items-center gap-1">
            {trend === "up"   && <TrendingUp  size={10} className="text-rose-400" />}
            {trend === "down" && <TrendingDown size={10} className="text-emerald-400" />}
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── HourlyBars ───────────────────────────────────────────────────────────────

function HourlyBars({ data }: { data: { hour: number; count: number; avg_los: number }[] }) {
  const [hov, setHov] = useState<number | null>(null);
  const max  = Math.max(...data.map((d) => d.count), 1);
  const mean = data.reduce((s, d) => s + d.count, 0) / Math.max(data.length, 1);
  const cur  = new Date().getHours();
  const W = 560; const H = 160;
  const PL = 30; const PR = 8; const PT = 20; const PB = 28;
  const cW = W - PL - PR; const cH = H - PT - PB;
  const bw  = cW / 24;
  const yMean = PT + cH - (mean / max) * cH;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <defs>
        <linearGradient id="hBarG" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22d3ee" stopOpacity=".9" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity=".2" />
        </linearGradient>
        <linearGradient id="hBarA" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e879f9" stopOpacity="1" />
          <stop offset="100%" stopColor="#e879f9" stopOpacity=".3" />
        </linearGradient>
        <linearGradient id="hBarH" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0abfc" stopOpacity="1" />
          <stop offset="100%" stopColor="#f0abfc" stopOpacity=".4" />
        </linearGradient>
        <filter id="glow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>

      {/* grid */}
      {[0, .25, .5, .75, 1].map((f, i) => {
        const y = PT + cH * (1 - f);
        return (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={y} y2={y} stroke="#1e293b" strokeWidth={1} />
            <text x={PL - 4} y={y + 3} fontSize={8} fill="#334155" textAnchor="end">
              {Math.round(max * f)}
            </text>
          </g>
        );
      })}

      {/* mean reference line */}
      <line x1={PL} x2={W - PR} y1={yMean} y2={yMean}
        stroke="#22d3ee" strokeWidth={1} strokeDasharray="4,4" opacity={0.45} />
      <text x={W - PR - 2} y={yMean - 3} fontSize={8} fill="#22d3ee" textAnchor="end" opacity={0.7}>
        moy {mean.toFixed(1)}
      </text>

      {/* bars */}
      {data.map((d) => {
        const bh  = Math.max((d.count / max) * cH, 1);
        const x   = PL + d.hour * bw + 2;
        const y   = PT + cH - bh;
        const isC = d.hour === cur;
        const isH = hov === d.hour;
        let fill = "url(#hBarG)";
        if (isC) fill = "url(#hBarA)";
        else if (isH) fill = "url(#hBarH)";
        return (
          <g key={d.hour}
            onMouseEnter={() => setHov(d.hour)}
            onMouseLeave={() => setHov(null)}
            style={{ cursor: "pointer" }}>
            {/* hover bg */}
            {isH && (
              <rect x={x - 1} y={PT} width={Math.max(bw - 2, 1)} height={cH}
                fill="#ffffff" fillOpacity={0.04} rx={2} />
            )}
            <rect x={x} y={y} width={Math.max(bw - 4, 1)} height={bh} rx={2}
              fill={fill} filter={isC || isH ? "url(#glow)" : undefined} />
            {d.hour % 3 === 0 && (
              <text x={x + bw / 2} y={H - 6} fontSize={8}
                fill={isC ? "#e879f9" : isH ? "#f0abfc" : "#334155"} textAnchor="middle">
                {String(d.hour).padStart(2, "0")}h
              </text>
            )}
          </g>
        );
      })}

      {/* current hour dashed line */}
      <line x1={PL + cur * bw + bw / 2} x2={PL + cur * bw + bw / 2}
        y1={PT} y2={H - PB} stroke="#e879f9" strokeWidth={1} strokeDasharray="3,3" opacity={0.6} />

      {/* tooltip */}
      {hov !== null && (() => {
        const d  = data.find((x) => x.hour === hov);
        if (!d) return null;
        const bx = PL + hov * bw + bw / 2;
        const bh = Math.max((d.count / max) * cH, 1);
        const by = PT + cH - bh;
        return (
          <SvgTooltip
            x={bx} y={by} viewW={W}
            lines={[
              { text: `${String(d.hour).padStart(2, "0")}h00 – ${String(d.hour + 1).padStart(2, "0")}h00`, color: "#94a3b8" },
              { text: `Arrivées : ${d.count}`, color: "#22d3ee" },
              { text: `LOS moy : ${fmtMin(d.avg_los)}`, color: "#8b5cf6" },
            ]}
          />
        );
      })()}
    </svg>
  );
}

// ─── LosGauge ────────────────────────────────────────────────────────────────

function LosGauge({ p90, avg }: { p90: number; avg: number }) {
  const MAX = 720; const TARGET = 360;
  const cx = 100; const cy = 95; const r = 68;
  const S = -135; const TOTAL = 270;
  const toAngle = (v: number) => S + (Math.min(v, MAX) / MAX) * TOTAL;
  const color = p90 > TARGET ? "#f43f5e" : p90 > TARGET * 0.75 ? "#f59e0b" : "#10b981";
  const [tx, ty] = polar(cx, cy, r, toAngle(TARGET));
  const [ax, ay] = polar(cx, cy, r, toAngle(avg));

  return (
    <svg viewBox="0 0 200 170" className="w-full h-auto">
      <defs>
        <filter id="gaugeGlow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      {/* track */}
      <path d={arc(cx, cy, r, S, S + TOTAL)} fill="none" stroke="#1e293b" strokeWidth={14} strokeLinecap="round" />
      {/* avg sub-arc */}
      <path d={arc(cx, cy, r, S, toAngle(avg))} fill="none" stroke="#10b981" strokeWidth={14}
        strokeLinecap="round" opacity={0.35} />
      {/* p90 arc */}
      <path d={arc(cx, cy, r, S, toAngle(p90))} fill="none" stroke={color} strokeWidth={10}
        strokeLinecap="round" filter="url(#gaugeGlow)" />
      {/* target marker */}
      <circle cx={tx} cy={ty} r={6} fill="#f59e0b" style={{ filter: "drop-shadow(0 0 4px #f59e0b)" }} />
      {/* avg marker */}
      <circle cx={ax} cy={ay} r={4} fill="#10b981" style={{ filter: "drop-shadow(0 0 4px #10b981)" }} />
      {/* center */}
      <text x={cx} y={cy - 14} textAnchor="middle" fill={color} fontSize={24} fontWeight="bold"
        fontFamily="monospace" style={{ filter: `drop-shadow(0 0 8px ${color})` }}>
        {fmtMin(p90)}
      </text>
      <text x={cx} y={cy + 6}  textAnchor="middle" fill="#64748b" fontSize={10}>LOS P90</text>
      <text x={cx} y={cy + 22} textAnchor="middle" fill="#10b981" fontSize={10}>
        moy : {fmtMin(avg)}
      </text>
      {/* legend */}
      <text x={28}  y={152} textAnchor="middle" fill="#334155" fontSize={8}>0</text>
      <text x={172} y={152} textAnchor="middle" fill="#334155" fontSize={8}>12h</text>
      <text x={cx}  y={163} textAnchor="middle" fill="#f59e0b" fontSize={8}>● cible 6h</text>
      <text x={cx}  y={150} textAnchor="middle" fill="#10b981" fontSize={7.5}>● moyenne</text>
    </svg>
  );
}

// ─── TrendChart ───────────────────────────────────────────────────────────────

type StatePoint = { startDate: string; endDate: string; midDate: string; count: number; avg_los: number };
type PredPoint  = { date: string; count: number; upper: number; lower: number };

/** Group consecutive days with <THRESH relative change into a single "state". */
function aggregateByStateChange(raw: { date: string; count: number; avg_los: number }[]): StatePoint[] {
  if (raw.length === 0) return [];
  const THRESH = 0.18;
  const MIN_LEN = 3;
  const out: StatePoint[] = [];
  let start = 0, sumC = raw[0].count, sumL = raw[0].avg_los * raw[0].count, n = 1;

  function flush(end: number) {
    const mid = Math.floor((start + end) / 2);
    out.push({
      startDate: raw[start].date,
      endDate:   raw[end].date,
      midDate:   raw[mid].date,
      count:     Math.round(sumC / n),
      avg_los:   sumC > 0 ? sumL / sumC : 0,
    });
  }

  for (let i = 1; i < raw.length; i++) {
    const mean = sumC / n;
    const change = Math.abs(raw[i].count - mean) / Math.max(mean, 1);
    if (change > THRESH && n >= MIN_LEN) {
      flush(i - 1);
      start = i; sumC = raw[i].count; sumL = raw[i].avg_los * raw[i].count; n = 1;
    } else {
      sumC += raw[i].count; sumL += raw[i].avg_los * raw[i].count; n++;
    }
  }
  flush(raw.length - 1);
  return out;
}

/**
 * Seasonal + exponentially-weighted trend model.
 *
 * 1. Compute multiplicative day-of-week seasonal factors from the full history.
 * 2. Deseasonalize the series.
 * 3. Fit weighted OLS on the deseasonalized series, with exponential decay
 *    (half-life = 21 days) so recent data drives the slope.
 * 4. Re-apply seasonal factor for each future day.
 * 5. 95 % CI fans out with the square root of the forecast horizon.
 *
 * Returns 28 daily prediction points + trend direction.
 */
function buildPrediction(raw: { date: string; count: number }[]): {
  points: PredPoint[];
  deltaPerWeek: number;
} {
  if (raw.length < 14) return { points: [], deltaPerWeek: 0 };

  // ── 1. Day-of-week seasonal factors (multiplicative) ──────────────────────
  const dowSum = new Array(7).fill(0);
  const dowN   = new Array(7).fill(0);
  for (const d of raw) {
    const dow = new Date(d.date).getDay();
    dowSum[dow] += d.count;
    dowN[dow]++;
  }
  const globalMean = raw.reduce((s, d) => s + d.count, 0) / raw.length;
  const sf = dowSum.map((t, i) =>
    dowN[i] > 0 ? (t / dowN[i]) / Math.max(globalMean, 1) : 1.0
  );

  // ── 2. Deseasonalize ───────────────────────────────────────────────────────
  const adj = raw.map((d, i) => ({
    x: i,
    y: d.count / Math.max(sf[new Date(d.date).getDay()], 0.1),
  }));

  // ── 3. Weighted OLS (exponential weights, half-life = 21 days) ────────────
  const HALF_LIFE = 21;
  const decay = Math.log(2) / HALF_LIFE;
  const n     = adj.length;
  const w     = adj.map((_, i) => Math.exp(-decay * (n - 1 - i)));

  const W    = w.reduce((s, v) => s + v, 0);
  const Wx   = w.reduce((s, v, i) => s + v * adj[i].x, 0);
  const Wy   = w.reduce((s, v, i) => s + v * adj[i].y, 0);
  const Wxx  = w.reduce((s, v, i) => s + v * adj[i].x ** 2, 0);
  const Wxy  = w.reduce((s, v, i) => s + v * adj[i].x * adj[i].y, 0);
  const denom = W * Wxx - Wx * Wx;
  const b    = Math.abs(denom) < 1e-9 ? 0 : (W * Wxy - Wx * Wy) / denom;
  const a    = (Wy - b * Wx) / W;

  // Weighted residual std — used for CI width
  const resStd = Math.sqrt(
    adj.reduce((s, d, i) => s + w[i] * (d.y - (a + b * d.x)) ** 2, 0) /
    Math.max(W - 1, 1)
  );

  // ── 4. Generate 28 daily predictions ──────────────────────────────────────
  const lastDate = new Date(raw[raw.length - 1].date);
  const points: PredPoint[] = [];
  for (let d = 1; d <= 28; d++) {
    const x   = n - 1 + d;
    const dt  = new Date(lastDate);
    dt.setDate(dt.getDate() + d);
    const dow      = dt.getDay();
    const adjPred  = a + b * x;
    const count    = Math.max(0, adjPred * sf[dow]);
    // CI widens as sqrt(horizon/7): full-week uncertainty at d=7, 2× at d=28
    const ciHalf   = 1.96 * resStd * sf[dow] * Math.sqrt(d / 7);
    points.push({
      date:  dt.toISOString().slice(0, 10),
      count: Math.round(count),
      upper: Math.round(count + ciHalf),
      lower: Math.max(0, Math.round(count - ciHalf)),
    });
  }

  // ── 5. Weekly delta for trend badge ───────────────────────────────────────
  const recent7 = raw.slice(-7).reduce((s, d) => s + d.count, 0) / 7;
  const prev7   = raw.length >= 14
    ? raw.slice(-14, -7).reduce((s, d) => s + d.count, 0) / 7
    : recent7;
  const deltaPerWeek = Math.round(recent7 - prev7);

  return { points, deltaPerWeek };
}

function TrendChart({ data }: { data: { date: string; count: number; avg_los: number }[] }) {
  const [hovState, setHovState] = useState<number | null>(null);
  const [hovPred,  setHovPred]  = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) return (
    <div className="h-28 flex items-center justify-center text-slate-600 text-xs">Données insuffisantes</div>
  );

  const states = aggregateByStateChange(data);
  const { points: pred, deltaPerWeek } = buildPrediction(data);
  const maxRaw = Math.max(...data.map((d) => d.count), 1);

  const W = 640; const H = 180;
  const PL = 38; const PR = 12; const PT = 20; const PB = 28;
  const cW = W - PL - PR; const cH = H - PT - PB;

  // Date-based x positioning spans hist + 30 days prediction
  const firstDate = new Date(data[0].date);
  const predEnd   = new Date(data[data.length - 1].date);
  predEnd.setDate(predEnd.getDate() + 30);
  const totalDays = Math.max((predEnd.getTime() - firstDate.getTime()) / 86_400_000, 1);

  function dateToX(ds: string): number {
    return PL + ((new Date(ds).getTime() - firstDate.getTime()) / 86_400_000 / totalDays) * cW;
  }

  const maxY   = Math.max(...states.map((s) => s.count), ...pred.map((p) => p.upper), maxRaw, 1);
  const meanC  = states.reduce((s, p) => s + p.count, 0) / Math.max(states.length, 1);

  function toY(v: number): number { return PT + cH - (v / maxY) * cH; }

  // Historical paths
  const histPath = states.map((s, i) =>
    `${i === 0 ? "M" : "L"}${dateToX(s.midDate).toFixed(1)},${toY(s.count).toFixed(1)}`
  ).join(" ");
  const histArea = `${histPath} L${dateToX(states[states.length - 1].midDate).toFixed(1)},${H - PB} L${dateToX(states[0].midDate).toFixed(1)},${H - PB}Z`;

  // Anchor point: last historical state
  const lx = dateToX(states[states.length - 1].midDate);
  const ly = toY(states[states.length - 1].count);

  // Prediction paths
  const predPath  = pred.length > 0 ? [`M${lx.toFixed(1)},${ly.toFixed(1)}`, ...pred.map((p) => `L${dateToX(p.date).toFixed(1)},${toY(p.count).toFixed(1)}`)].join(" ") : "";
  const upperPath = pred.length > 0 ? [`M${lx.toFixed(1)},${ly.toFixed(1)}`, ...pred.map((p) => `L${dateToX(p.date).toFixed(1)},${toY(p.upper).toFixed(1)}`)].join(" ") : "";
  const lowerPath = pred.length > 0 ? [`M${lx.toFixed(1)},${ly.toFixed(1)}`, ...pred.map((p) => `L${dateToX(p.date).toFixed(1)},${toY(p.lower).toFixed(1)}`)].join(" ") : "";
  const ciArea    = pred.length > 0 ? [
    `M${lx.toFixed(1)},${ly.toFixed(1)}`,
    ...pred.map((p) => `L${dateToX(p.date).toFixed(1)},${toY(p.upper).toFixed(1)}`),
    ...[...pred].reverse().map((p) => `L${dateToX(p.date).toFixed(1)},${toY(p.lower).toFixed(1)}`),
    `L${lx.toFixed(1)},${ly.toFixed(1)}Z`,
  ].join(" ") : "";

  const yMeanC = toY(meanC);
  const yMaxLine = toY(maxRaw);

  const labelStep = Math.max(1, Math.ceil(states.length / 10));

  function onMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const el = svgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;

    if (pred.length > 0 && svgX > lx + 12) {
      setHovState(null);
      let best = 0, bestD = Infinity;
      pred.forEach((p, i) => { const d = Math.abs(dateToX(p.date) - svgX); if (d < bestD) { bestD = d; best = i; } });
      setHovPred(best);
    } else {
      setHovPred(null);
      let best = 0, bestD = Infinity;
      states.forEach((s, i) => { const d = Math.abs(dateToX(s.midDate) - svgX); if (d < bestD) { bestD = d; best = i; } });
      setHovState(best);
    }
  }

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <defs>
        <linearGradient id="trendArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="#22d3ee" stopOpacity=".25" />
          <stop offset="100%" stopColor="#22d3ee" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* grid */}
      {[0, .25, .5, .75, 1].map((f, i) => (
        <line key={i} x1={PL} x2={W - PR} y1={PT + cH * (1 - f)} y2={PT + cH * (1 - f)}
          stroke="#1e293b" strokeWidth={1} />
      ))}

      {/* prediction zone: subtle background + separator + trend badge */}
      {pred.length > 0 && (() => {
        const trendLabel = deltaPerWeek > 1
          ? `↗ +${deltaPerWeek}/sem`
          : deltaPerWeek < -1
          ? `↘ ${deltaPerWeek}/sem`
          : "→ stable";
        const trendColor = deltaPerWeek > 1 ? "#f87171" : deltaPerWeek < -1 ? "#34d399" : "#94a3b8";
        return (
          <>
            <rect x={lx} y={PT} width={W - PR - lx} height={cH} fill="#f59e0b" fillOpacity={0.04} />
            <line x1={lx} x2={lx} y1={PT} y2={H - PB} stroke="#f59e0b" strokeWidth={1} strokeDasharray="3,3" opacity={0.35} />
            <text x={lx + 4} y={PT + 11} fontSize={7.5} fill="#f59e0b" opacity={0.65} fontStyle="italic">prédiction +30j</text>
            <text x={W - PR - 2} y={PT + 11} fontSize={8} fill={trendColor} textAnchor="end" fontWeight={600}>{trendLabel}</text>
          </>
        );
      })()}

      {/* max reference line (historical zone only) */}
      <line x1={PL} x2={lx} y1={yMaxLine} y2={yMaxLine}
        stroke="#f59e0b" strokeWidth={1} strokeDasharray="4,4" opacity={0.55} />
      <text x={PL + 2} y={yMaxLine - 3} fontSize={8} fill="#f59e0b" textAnchor="start" opacity={0.85}>
        max {maxRaw}
      </text>

      {/* mean reference line (historical zone only) */}
      <line x1={PL} x2={lx} y1={yMeanC} y2={yMeanC}
        stroke="#22d3ee" strokeWidth={1} strokeDasharray="5,5" opacity={0.35} />
      <text x={lx - 3} y={yMeanC - 3} fontSize={8} fill="#22d3ee" textAnchor="end" opacity={0.6}>
        moy {meanC.toFixed(0)}
      </text>

      {/* CI fill */}
      {ciArea && <path d={ciArea} fill="#f59e0b" fillOpacity={0.12} />}
      {upperPath && <path d={upperPath} fill="none" stroke="#f59e0b" strokeWidth={1} strokeDasharray="4,3" opacity={0.45} />}
      {lowerPath && <path d={lowerPath} fill="none" stroke="#f59e0b" strokeWidth={1} strokeDasharray="4,3" opacity={0.45} />}

      {/* historical area + line */}
      <path d={histArea} fill="url(#trendArea)" />
      <path d={histPath} fill="none" stroke="#22d3ee" strokeWidth={2}
        style={{ filter: "drop-shadow(0 0 4px #22d3ee)" }} />

      {/* prediction line */}
      {predPath && <path d={predPath} fill="none" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="6,3"
        style={{ filter: "drop-shadow(0 0 3px #f59e0b)" }} />}

      {/* state dots */}
      {states.map((s, i) => (
        <circle key={i} cx={dateToX(s.midDate)} cy={toY(s.count)} r={3}
          fill="#22d3ee" stroke="#0f172a" strokeWidth={1}
          opacity={hovState === i ? 1 : 0.55} />
      ))}

      {/* prediction dots: weekly marks only (d=7,14,21,28 → indices 6,13,20,27) */}
      {pred.filter((_, i) => (i + 1) % 7 === 0).map((p, i) => (
        <circle key={i} cx={dateToX(p.date)} cy={toY(p.count)} r={3.5}
          fill="#f59e0b" stroke="#0f172a" strokeWidth={1}
          opacity={hovPred !== null && Math.floor(hovPred / 7) === i ? 1 : 0.7} />
      ))}

      {/* x-axis labels: state start dates */}
      {states.map((s, i) => {
        if (i % labelStep !== 0 && i !== states.length - 1) return null;
        return (
          <text key={i} x={dateToX(s.startDate)} y={H - 4} fontSize={7.5}
            fill={hovState === i ? "#e2e8f0" : "#334155"} textAnchor="middle">
            {s.startDate.slice(5).replace("-", "/")}
          </text>
        );
      })}
      {pred.length > 0 && (
        <text x={dateToX(pred[pred.length - 1].date)} y={H - 4} fontSize={7.5}
          fill="#f59e0b" textAnchor="middle" opacity={0.7}>
          {pred[pred.length - 1].date.slice(5).replace("-", "/")}
        </text>
      )}

      {/* y-axis bounds */}
      <text x={PL - 4} y={PT + 4}     fontSize={8} fill="#22d3ee" textAnchor="end">{maxY}</text>
      <text x={PL - 4} y={H - PB + 4} fontSize={8} fill="#22d3ee" textAnchor="end">0</text>

      {/* hover: historical state */}
      {hovState !== null && states[hovState] && (() => {
        const s = states[hovState];
        const hx = dateToX(s.midDate);
        const hy = toY(s.count);
        return (
          <>
            <line x1={hx} x2={hx} y1={PT} y2={H - PB} stroke="#fff" strokeWidth={0.8} strokeDasharray="3,3" opacity={0.25} />
            <circle cx={hx} cy={hy} r={5} fill="#22d3ee" stroke="#0f172a" strokeWidth={1.5}
              style={{ filter: "drop-shadow(0 0 6px #22d3ee)" }} />
            <SvgTooltip x={hx} y={hy} viewW={W} lines={[
              { text: `${s.startDate.slice(5).replace("-","/")} → ${s.endDate.slice(5).replace("-","/")}`, color: "#94a3b8" },
              { text: `Patients : ${s.count}`, color: "#22d3ee" },
            ]} />
          </>
        );
      })()}

      {/* hover: prediction */}
      {hovPred !== null && pred[hovPred] && (() => {
        const p  = pred[hovPred];
        const hx = dateToX(p.date);
        const hy = toY(p.count);
        return (
          <>
            <line x1={hx} x2={hx} y1={PT} y2={H - PB} stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="3,3" opacity={0.3} />
            <circle cx={hx} cy={hy} r={5} fill="#f59e0b" stroke="#0f172a" strokeWidth={1.5}
              style={{ filter: "drop-shadow(0 0 6px #f59e0b)" }} />
            <SvgTooltip x={hx} y={hy} viewW={W} lines={[
              { text: `Prédiction ${p.date.slice(5).replace("-","/")}`, color: "#f59e0b" },
              { text: `Patients : ${p.count}`, color: "#f59e0b" },
              { text: `IC 95% : ${p.lower} – ${p.upper}`, color: "#94a3b8" },
            ]} />
          </>
        );
      })()}

      {/* invisible mouse overlay */}
      <rect x={PL} y={PT} width={cW} height={cH} fill="transparent"
        onMouseMove={onMouseMove}
        onMouseLeave={() => { setHovState(null); setHovPred(null); }} />
    </svg>
  );
}

// ─── LosHistogram ─────────────────────────────────────────────────────────────

const HIST_BINS = [0, 30, 60, 120, 180, 240, 360, 480, 720];

function minToHistX(min: number, nBars: number, PL: number, cW: number): number {
  const bw = cW / nBars;
  for (let i = 0; i < HIST_BINS.length - 1; i++) {
    if (min <= HIST_BINS[i + 1]) {
      const frac = (min - HIST_BINS[i]) / (HIST_BINS[i + 1] - HIST_BINS[i]);
      return PL + (i + frac) * bw;
    }
  }
  const frac = Math.min((min - 720) / 240, 1);
  return PL + (HIST_BINS.length - 1 + frac) * bw;
}

function LosHistogram({
  data, avgMin, p90Min,
}: {
  data: { label: string; count: number }[];
  avgMin: number;
  p90Min: number;
}) {
  const [hov, setHov] = useState<number | null>(null);
  const max   = Math.max(...data.map((d) => d.count), 1);
  const total = data.reduce((s, d) => s + d.count, 0);
  const COLORS = ["#10b981","#10b981","#22d3ee","#22d3ee","#8b5cf6","#8b5cf6","#f59e0b","#f59e0b","#f43f5e"];
  const W = 420; const H = 160;
  const PL = 10; const PR = 10; const PT = 22; const PB = 48;
  const cW = W - PL - PR; const cH = H - PT - PB;
  const bw = cW / data.length;

  const xAvg = minToHistX(avgMin, data.length, PL, cW);
  const xP90 = minToHistX(p90Min, data.length, PL, cW);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      {/* bars */}
      {data.map((d, i) => {
        const bh    = Math.max((d.count / max) * cH, 2);
        const x     = PL + i * bw + 2;
        const y     = PT + cH - bh;
        const color = COLORS[Math.min(i, COLORS.length - 1)];
        const isH   = hov === i;
        return (
          <g key={i} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
            style={{ cursor: "pointer" }}>
            {isH && (
              <rect x={x - 1} y={PT} width={Math.max(bw - 2, 2)} height={cH}
                fill="#ffffff" fillOpacity={0.05} rx={2} />
            )}
            <rect x={x} y={y} width={Math.max(bw - 4, 2)} height={bh} rx={3}
              fill={color} fillOpacity={isH ? 1 : 0.75}
              style={{ filter: isH ? `drop-shadow(0 0 5px ${color})` : `drop-shadow(0 0 3px ${color}60)` }} />
            {bh > 22 && (
              <text x={x + bw / 2} y={y + 14} fontSize={9} fill="#fff" textAnchor="middle" fontWeight="bold">
                {d.count}
              </text>
            )}
            <text x={x + bw / 2} y={H - 30} fontSize={7.5} fill={isH ? "#e2e8f0" : "#475569"}
              textAnchor="middle" transform={`rotate(-38,${x + bw / 2},${H - 30})`}>
              {d.label}
            </text>
          </g>
        );
      })}

      {/* avg reference line */}
      <line x1={xAvg} x2={xAvg} y1={PT} y2={PT + cH}
        stroke="#10b981" strokeWidth={1.5} strokeDasharray="4,3"
        style={{ filter: "drop-shadow(0 0 3px #10b981)" }} />
      <text x={xAvg} y={PT - 4} fontSize={8} fill="#10b981" textAnchor="middle">
        moy
      </text>

      {/* p90 reference line */}
      <line x1={xP90} x2={xP90} y1={PT} y2={PT + cH}
        stroke="#f43f5e" strokeWidth={1.5} strokeDasharray="4,3"
        style={{ filter: "drop-shadow(0 0 3px #f43f5e)" }} />
      <text x={xP90} y={PT - 4} fontSize={8} fill="#f43f5e" textAnchor="middle">
        P90
      </text>

      {/* tooltip */}
      {hov !== null && (() => {
        const d = data[hov];
        const x = PL + hov * bw + bw / 2;
        const bh = Math.max((d.count / max) * cH, 2);
        const y = PT + cH - bh;
        const pct = total > 0 ? ((d.count / total) * 100).toFixed(1) : "0";
        return (
          <SvgTooltip
            x={x} y={y} viewW={W}
            lines={[
              { text: d.label, color: "#94a3b8" },
              { text: `Patients : ${d.count}`, color: "#e2e8f0" },
              { text: `Part : ${pct}%`, color: COLORS[Math.min(hov, COLORS.length - 1)] },
            ]}
          />
        );
      })()}
    </svg>
  );
}

// ─── BottleneckList ───────────────────────────────────────────────────────────

function BottleneckList({ data }: { data: { location: string; avg_duration_min: number; n_visits: number }[] }) {
  const [hov, setHov] = useState<number | null>(null);
  const { open: openDrill } = useDrillDown();
  const max = Math.max(...data.map((d) => d.avg_duration_min), 1);
  return (
    <div className="space-y-2.5">
      {data.slice(0, 8).map((d, i) => {
        const pct   = d.avg_duration_min / max;
        const color = pct > .75 ? "#f43f5e" : pct > .5 ? "#f59e0b" : "#10b981";
        const label = pct > .75 ? "CRITIQUE" : pct > .5 ? "ÉLEVÉ" : "NORMAL";
        const isH   = hov === i;
        return (
          <div key={i}
            onClick={() => openDrill({ kind: "location", location: d.location })}
            className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-all duration-150 cursor-pointer hover:bg-slate-800/60 ${isH ? "bg-slate-800/50" : ""}`}
            onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
            title="Cliquer pour voir les dossiers concernés">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${pct > .75 ? "animate-pulse" : ""}`}
              style={{ backgroundColor: color, boxShadow: `0 0 5px ${color}` }} />
            <div className="flex-1 min-w-0">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-200 truncate font-medium">{d.location}</span>
                <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                  {isH && (
                    <span className="text-[10px] text-slate-500 font-mono">
                      {d.n_visits} visites
                    </span>
                  )}
                  <span className="text-slate-400 font-mono tabular-nums">
                    {fmtMin(d.avg_duration_min)}
                  </span>
                </div>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
                <div className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${pct * 100}%`, backgroundColor: color,
                    boxShadow: `0 0 8px ${color}70` }} />
              </div>
              {isH && (
                <div className="mt-1 text-[10px] font-mono text-slate-500">
                  durée moy : {fmtMin(d.avg_duration_min)} · {d.n_visits} passages
                </div>
              )}
            </div>
            <span className="text-[9px] font-mono w-14 text-right flex-shrink-0" style={{ color }}>
              {label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── DonutChart ───────────────────────────────────────────────────────────────

function DonutChart({ data }: { data: { mode: string; count: number; pct: number }[] }) {
  const [hov, setHov] = useState<number | null>(null);
  const COLORS = ["#22d3ee","#8b5cf6","#10b981","#f59e0b","#f43f5e","#64748b"];
  const cx = 78; const cy = 78; const R = 62; const inner = 38;
  let angle = -90;

  const slices = data.map((d, i) => {
    const sweep = d.pct * 3.6; // pct is in 0–100
    const end   = angle + sweep;
    const mid   = angle + sweep / 2;
    const [x1, y1] = polar(cx, cy, R, angle);
    const [x2, y2] = polar(cx, cy, R, end);
    const [i1x, i1y] = polar(cx, cy, inner, angle);
    const [i2x, i2y] = polar(cx, cy, inner, end);
    const lg   = sweep > 180 ? 1 : 0;
    const path = `M${i1x},${i1y} L${x1},${y1} A${R},${R},0,${lg},1,${x2},${y2} L${i2x},${i2y} A${inner},${inner},0,${lg},0,${i1x},${i1y}Z`;
    // tooltip position: midpoint of arc at outer radius
    const [tx, ty] = polar(cx, cy, R + 14, mid);
    const s = { path, color: COLORS[i % COLORS.length], mode: d.mode, pct: d.pct, count: d.count, tx, ty };
    angle = end;
    return s;
  });

  const hovSlice = hov !== null ? slices[hov] : null;

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 156 156" className="w-36 h-36 flex-shrink-0">
        <defs>
          <filter id="sliceGlow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
        </defs>
        {slices.map((s, i) => (
          <path key={i} d={s.path}
            fill={s.color} fillOpacity={hov === null ? 0.82 : hov === i ? 1 : 0.4}
            filter={hov === i ? "url(#sliceGlow)" : undefined}
            style={{ cursor: "pointer", transition: "fill-opacity .15s, transform .15s" }}
            onMouseEnter={() => setHov(i)}
            onMouseLeave={() => setHov(null)} />
        ))}
        <circle cx={cx} cy={cy} r={inner - 3} fill="#020617" />
        {hovSlice ? (
          <>
            <text x={cx} y={cy - 10} textAnchor="middle" fill={hovSlice.color} fontSize={8}>
              {hovSlice.mode.length > 12 ? hovSlice.mode.slice(0, 11) + "…" : hovSlice.mode}
            </text>
            <text x={cx} y={cy + 8} textAnchor="middle" fill={hovSlice.color} fontSize={16} fontWeight="bold">
              {Math.round(hovSlice.pct)}%
            </text>
            <text x={cx} y={cy + 22} textAnchor="middle" fill="#94a3b8" fontSize={8}>
              {hovSlice.count} patients
            </text>
          </>
        ) : (
          <>
            <text x={cx} y={cy - 5} textAnchor="middle" fill="#64748b" fontSize={9}>Sorties</text>
            <text x={cx} y={cy + 10} textAnchor="middle" fill="#f1f5f9" fontSize={16} fontWeight="bold">
              {data.length}
            </text>
            <text x={cx} y={cy + 22} textAnchor="middle" fill="#475569" fontSize={8}>modes</text>
          </>
        )}
      </svg>
      <div className="flex-1 space-y-1.5 min-w-0">
        {slices.map((s, i) => (
          <div key={i}
            className={`flex items-center gap-2 text-xs rounded px-1 py-0.5 transition-colors ${hov === i ? "bg-slate-800/60" : ""}`}
            onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}
            style={{ cursor: "default" }}>
            <div className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-slate-400 truncate flex-1 text-[11px]">{s.mode}</span>
            <span className="font-bold font-mono flex-shrink-0" style={{ color: s.color }}>
              {Math.round(s.pct)}%
            </span>
            {hov === i && (
              <span className="text-slate-500 text-[10px] font-mono flex-shrink-0">
                {s.count}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── ActivityFeed ─────────────────────────────────────────────────────────────

function ActivityFeed({ items }: { items: CommandCenterData["recent_activity"] }) {
  const [shown, setShown] = useState(8);
  useEffect(() => {
    const t = setInterval(() => setShown((v) => Math.min(v + 1, items.length)), 1800);
    return () => clearInterval(t);
  }, [items.length]);

  return (
    <div className="space-y-0.5 max-h-56 overflow-y-auto">
      {items.slice(0, shown).map((item, i) => {
        const long = (item.los_min ?? 0) > 360;
        return (
          <div key={`${item.dossier_id}-${i}`}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-colors hover:bg-slate-800/40 ${i < 2 ? "bg-slate-800/50" : ""}`}>
            <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${i < 2 ? "animate-pulse" : ""}`}
              style={{ backgroundColor: long ? "#f59e0b" : "#10b981",
                boxShadow: `0 0 4px ${long ? "#f59e0b" : "#10b981"}` }} />
            <span className="font-mono text-slate-400 w-20 flex-shrink-0 truncate">{item.dossier_id}</span>
            <span className="text-slate-600 flex-shrink-0 tabular-nums">
              {item.arrivee
                ? new Date(item.arrivee).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })
                : "—"}
            </span>
            <span className={`font-bold font-mono ml-auto flex-shrink-0 tabular-nums ${long ? "text-amber-400" : "text-emerald-400"}`}>
              {fmtMin(item.los_min)}
            </span>
            <span className="text-slate-600 text-[10px] w-20 truncate text-right flex-shrink-0">
              {item.mode_sortie}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export function CommandCenter() {
  const { filters } = useFilters();
  const [data, setData] = useState<CommandCenterData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(new Date());

  const load = useCallback(async () => {
    const d = await api.commandCenter(filters);
    setData(d);
    setLastUpdate(new Date());
  }, [filters]);

  useEffect(() => {
    // Only block UI on very first load (data is null)
    if (!data) setLoading(true);
    else setRefreshing(true);
    load().finally(() => { setLoading(false); setRefreshing(false); });
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function refresh() {
    setRefreshing(true);
    await load().catch(() => {});
    setRefreshing(false);
  }

  // Full-screen loader only on very first render
  if (loading && !data) {
    return (
      <div className="min-h-96 flex flex-col items-center justify-center gap-4">
        <div className="w-10 h-10 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"
          style={{ boxShadow: "0 0 16px #22d3ee50" }} />
        <div className="text-xs font-mono tracking-[.3em] text-cyan-500 uppercase animate-pulse">
          Initialisation command center…
        </div>
      </div>
    );
  }

  if (!data) return null;
  const { kpis, hourly_arrivals, los_distribution, daily_trend, bottlenecks, exit_modes, recent_activity } = data;

  return (
    <div className={`space-y-4 transition-opacity duration-500 ${refreshing ? "opacity-50" : "opacity-100"}`}>

      {/* ── HEADER ── */}
      <div className="card p-4 relative overflow-hidden space-y-3"
        style={{ borderColor: "#22d3ee20" }}>
        <div className="absolute inset-0 pointer-events-none"
          style={{ background: "linear-gradient(90deg,#22d3ee06 0%,transparent 60%)" }} />

        {/* Top row */}
        <div className="relative flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: "#22d3ee12", border: "1px solid #22d3ee30",
                boxShadow: "0 0 16px #22d3ee20" }}>
              <Activity size={20} className="text-cyan-400" />
            </div>
            <div>
              <div className="text-sm font-bold text-slate-100 tracking-widest uppercase font-mono">
                ED Command Center
              </div>
              <div className="text-[10px] text-slate-500 font-mono tracking-wider">
                Urgences pédiatriques · Opérationnel
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 px-2.5 py-1 rounded-lg"
            style={{ background: "#10b98112", border: "1px solid #10b98130" }}>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"
              style={{ boxShadow: "0 0 8px #34d399" }} />
            <span className="text-emerald-400 text-xs font-mono font-bold tracking-widest">LIVE</span>
          </div>

          <div className="flex-1" />
          <div className="text-[11px] text-slate-600 font-mono tabular-nums">
            MAJ {lastUpdate.toLocaleTimeString("fr-FR")}
          </div>
          <LiveClock />
          <button onClick={refresh} disabled={refreshing}
            className="p-2 rounded-lg border border-slate-700/60 text-slate-500 hover:text-cyan-400 hover:border-cyan-500/30 transition disabled:opacity-40">
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          </button>
        </div>

        {/* Date range slider */}
        <div className="relative border-t border-slate-800/60 pt-3">
          <DateRangeSlider />
        </div>
      </div>

      {/* ── KPI ROW ── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <KpiCard title="Total patients"   value={kpis.total_patients}
          accent="#22d3ee" icon={Users} sub={`${kpis.throughput_per_day} / jour`} />
        <KpiCard title="LOS moyen"        value={kpis.avg_los_min}
          display={fmtMin(kpis.avg_los_min)} accent="#10b981" icon={Clock} sub="Durée moyenne" />
        <KpiCard title="LOS P10"          value={kpis.p10_los_min}
          display={fmtMin(kpis.p10_los_min)} accent="#06b6d4" icon={TrendingDown}
          sub="10ème percentile" trend="down" />
        <KpiCard title="LOS P90"          value={kpis.p90_los_min}
          display={fmtMin(kpis.p90_los_min)}
          accent={kpis.p90_los_min > 360 ? "#f43f5e" : "#f59e0b"} icon={TrendingUp}
          sub="90ème percentile" trend={kpis.p90_los_min > 360 ? "up" : undefined} />
        <KpiCard title="Débit / jour"     value={kpis.throughput_per_day}
          display={kpis.throughput_per_day.toFixed(1)} accent="#8b5cf6" icon={Zap}
          sub="Patients traités" />
        <KpiCard title="Hospitalisés"     value={kpis.hospit_pct}
          display={`${kpis.hospit_pct.toFixed(1)}%`} accent="#f59e0b" icon={Heart}
          sub="Taux hospitalisation" />
      </div>

      {/* ── FLUX HORAIRE + GAUGE ── */}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-4 lg:col-span-2">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
              Flux horaire des arrivées
            </h3>
            <span className="text-[10px] text-slate-600 font-mono">survol → détails · heure courante en violet</span>
          </div>
          <HourlyBars data={hourly_arrivals} />
        </div>
        <div className="card p-4 flex flex-col items-center justify-center">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-2 self-start">
            Jauge LOS P90
          </h3>
          <LosGauge p90={kpis.p90_los_min} avg={kpis.avg_los_min} />
        </div>
      </div>

      {/* ── TENDANCE 30 JOURS ── */}
      <div className="card p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
            Tendance — évolution du volume de patients
          </h3>
          <div className="flex items-center gap-5 text-[10px] font-mono text-slate-600">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-0.5 bg-cyan-400" /> Historique · par état
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-5 border-t border-dashed border-amber-400" /> Prédiction
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-4 h-2 rounded bg-amber-400/20 border border-dashed border-amber-400/40" /> IC 95 %
            </span>
          </div>
        </div>
        <TrendChart data={daily_trend} />
      </div>

      {/* ── HISTOGRAMME + GOULOTS ── */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
              Distribution des durées de séjour
            </h3>
            <div className="flex items-center gap-3 text-[10px] font-mono">
              <span className="text-emerald-400">● moy</span>
              <span className="text-rose-400">● P90</span>
            </div>
          </div>
          <LosHistogram data={los_distribution} avgMin={kpis.avg_los_min} p90Min={kpis.p90_los_min} />
        </div>
        <div className="card p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
              Goulots d'étranglement
            </h3>
            <span className="flex items-center gap-1 text-[10px] text-rose-500 font-mono">
              <AlertTriangle size={10} /> survol → visites
            </span>
          </div>
          <BottleneckList data={bottlenecks} />
        </div>
      </div>

      {/* ── ACTIVITÉ + DONUT ── */}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="card p-4 lg:col-span-2">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest">
              Activité récente
            </h3>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
              défilement en direct
            </div>
          </div>
          <ActivityFeed items={recent_activity} />
        </div>
        <div className="card p-4">
          <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-4">
            Modes de sortie · survol → détail
          </h3>
          <DonutChart data={exit_modes} />
        </div>
      </div>

    </div>
  );
}
