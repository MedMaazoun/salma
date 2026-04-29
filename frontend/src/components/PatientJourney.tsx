import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, ArrowRight, Clock, ChevronDown, User, BarChart2, GitBranch } from "lucide-react";
import clsx from "clsx";
import { api, type PatientSummary, type PatientJourneyData, type JourneyStep } from "../api";
import { useFilters } from "../FiltersContext";

const PALETTE = [
  "#6366f1", "#8b5cf6", "#06b6d4", "#10b981", "#f59e0b",
  "#ef4444", "#ec4899", "#f97316", "#84cc16", "#14b8a6",
  "#0ea5e9", "#a855f7", "#d946ef", "#22c55e", "#eab308",
  "#64748b",
];

function locColor(name: string): string {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
  return PALETTE[Math.abs(h) % PALETTE.length];
}

function fmtMin(min: number | null | undefined): string {
  if (min == null) return "—";
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}min` : `${h}h`;
}

// ---- LOS range options ----

const LOS_RANGES = [
  { value: "all",     label: "Toutes durées", min: undefined, max: undefined },
  { value: "lt60",    label: "< 1h",          min: undefined, max: 60        },
  { value: "60_180",  label: "1h – 3h",       min: 60,        max: 180       },
  { value: "180_360", label: "3h – 6h",       min: 180,       max: 360       },
  { value: "360_720", label: "6h – 12h",      min: 360,       max: 720       },
  { value: "gt720",   label: "> 12h",         min: 720,       max: undefined },
] as const;

type LosRangeValue = (typeof LOS_RANGES)[number]["value"];

const PAGE_SIZE = 20;

// ---- Gantt Chart ----

function GanttChart({ journeys }: { journeys: PatientJourneyData[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const LABEL_W = 190;
  const ROW_H = 54;
  const HEADER_H = 38;
  const PAD = 8;
  const chartW = Math.max(width - LABEL_W - PAD * 2, 200);

  const maxMin = useMemo(() => {
    let mx = 60;
    for (const j of journeys) {
      if (j.los_min && j.los_min > mx) mx = j.los_min;
      for (const s of j.steps) {
        if (s.end_min != null && s.end_min > mx) mx = s.end_min;
      }
    }
    return mx * 1.08;
  }, [journeys]);

  const toX = (min: number) => (min / maxMin) * chartW;

  const svgH = HEADER_H + journeys.length * ROW_H + PAD * 2;

  const tickStep = (() => {
    const raw = maxMin / 6;
    const steps = [5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 360];
    return steps.find((s) => s >= raw) ?? 360;
  })();
  const ticks: number[] = [];
  for (let t = 0; t <= maxMin; t += tickStep) ticks.push(t);

  return (
    <div ref={containerRef} className="relative select-none overflow-x-auto">
      <svg width={Math.max(width, LABEL_W + 200)} height={svgH}>
        {ticks.map((t) => {
          const x = LABEL_W + toX(t);
          return (
            <g key={t}>
              <line x1={x} y1={HEADER_H - 6} x2={x} y2={svgH - PAD} stroke="#1e293b" strokeWidth={1} />
              <text x={x} y={HEADER_H - 10} textAnchor="middle" fill="#475569" fontSize={11} fontFamily="system-ui">
                {fmtMin(t)}
              </text>
            </g>
          );
        })}
        <line x1={LABEL_W} y1={HEADER_H - 1} x2={LABEL_W + chartW} y2={HEADER_H - 1} stroke="#334155" strokeWidth={1} />

        {journeys.map((j, ri) => {
          const y = HEADER_H + ri * ROW_H;
          return (
            <g key={j.dossier_id}>
              <rect x={0} y={y} width={Math.max(width, LABEL_W + 200)} height={ROW_H}
                fill={ri % 2 === 0 ? "#0f172a" : "#0b1120"} />
              <text x={LABEL_W - 10} y={y + ROW_H / 2 + 4}
                textAnchor="end" fill="#94a3b8" fontSize={12} fontWeight="500" fontFamily="system-ui">
                {j.dossier_id.length > 18 ? j.dossier_id.slice(0, 16) + "…" : j.dossier_id}
              </text>
              {j.steps.map((s, si) => {
                const sx = LABEL_W + toX(s.start_min ?? 0);
                const sw = s.end_min != null && s.start_min != null
                  ? Math.max(4, toX(s.end_min - s.start_min)) : 8;
                const sy = y + 10;
                const sh = ROW_H - 20;
                const color = locColor(s.location);
                return (
                  <g key={si} style={{ cursor: "default" }}
                    onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY,
                      lines: [s.location, `Début: +${fmtMin(s.start_min)}`, `Fin: +${fmtMin(s.end_min)}`, `Durée: ${fmtMin(s.duration_min)}`] })}
                    onMouseMove={(e) => setTooltip((prev) => prev && { ...prev, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => setTooltip(null)}
                  >
                    <rect x={sx} y={sy} width={sw} height={sh} rx={3} fill={color} fillOpacity={0.82} />
                    {sw > 44 && (
                      <text x={sx + sw / 2} y={sy + sh / 2 + 4} textAnchor="middle"
                        fill="#fff" fontSize={10} fontWeight="600" fontFamily="system-ui"
                        style={{ pointerEvents: "none" }}>
                        {s.location.length > 14 ? s.location.slice(0, 12) + "…" : s.location}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
        <line x1={LABEL_W} y1={0} x2={LABEL_W} y2={svgH} stroke="#334155" strokeWidth={1} />
      </svg>

      {tooltip && (
        <div className="fixed z-50 bg-slate-800 border border-slate-700 rounded-xl px-3 py-2 text-xs shadow-xl pointer-events-none"
          style={{ left: tooltip.x + 14, top: tooltip.y - 60 }}>
          {tooltip.lines.map((line, i) => (
            <div key={i} className={i === 0 ? "font-semibold text-slate-100 mb-1" : "text-slate-400"}>{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Color Legend ----

function ColorLegend({ journeys }: { journeys: PatientJourneyData[] }) {
  const locs = useMemo(() => {
    const s = new Set<string>();
    journeys.forEach((j) => j.steps.forEach((step) => s.add(step.location)));
    return Array.from(s).sort();
  }, [journeys]);
  if (locs.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4 pt-4 border-t border-slate-800/70">
      {locs.map((loc) => (
        <div key={loc} className="flex items-center gap-1.5 text-xs text-slate-400">
          <div className="w-3 h-3 rounded-sm flex-shrink-0" style={{ backgroundColor: locColor(loc) }} />
          {loc}
        </div>
      ))}
    </div>
  );
}

// ---- Step block ----

function StepBlock({ step }: { step: JourneyStep }) {
  const color = locColor(step.location);
  return (
    <div
      className="flex-shrink-0 rounded-xl px-4 py-3 text-center min-w-[120px]"
      style={{ backgroundColor: color + "18", border: `1px solid ${color}50` }}
    >
      <div className="text-xs font-semibold text-slate-100 truncate" title={step.location}>
        {step.location}
      </div>
      <div className="text-sm font-bold mt-1" style={{ color }}>
        {fmtMin(step.duration_min)}
      </div>
      {step.start_min != null && (
        <div className="text-[10px] text-slate-500 mt-0.5">+{fmtMin(step.start_min)}</div>
      )}
    </div>
  );
}

// ---- Journey block ----

function JourneyBlock({ journey, highlighted }: { journey: PatientJourneyData; highlighted: boolean }) {
  return (
    <div
      id={`block-${journey.dossier_id}`}
      className={`card p-4 transition-all duration-500 ${highlighted ? "ring-2 ring-brand-400 bg-brand-500/5" : ""}`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-4">
        <span className="text-sm font-semibold text-slate-100">{journey.dossier_id}</span>
        {journey.arrivee && (
          <span className="text-xs text-slate-500">
            {new Date(journey.arrivee).toLocaleDateString("fr-FR", {
              day: "2-digit", month: "2-digit", year: "numeric",
              hour: "2-digit", minute: "2-digit",
            })}
          </span>
        )}
        {journey.mode_sortie && (
          <span className="px-2 py-0.5 rounded-full bg-slate-700/60 text-slate-300 text-xs">
            {journey.mode_sortie}
          </span>
        )}
        <span className="ml-auto text-base font-bold text-brand-300">
          {fmtMin(journey.los_min)}
        </span>
      </div>

      {/* Steps flow */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {/* Entrée */}
        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-brand-500/20 border border-brand-500/40 flex items-center justify-center text-brand-300 text-[10px] font-bold">
          IN
        </div>

        {journey.steps.map((step, si) => {
          const gap =
            si > 0 && step.start_min != null && journey.steps[si - 1].end_min != null
              ? step.start_min - (journey.steps[si - 1].end_min ?? 0)
              : null;
          return (
            <div key={si} className="flex items-center gap-1.5 flex-shrink-0">
              <div className="flex flex-col items-center">
                {gap != null && gap > 1 ? (
                  <span className="text-[10px] text-slate-500 mb-0.5">{fmtMin(gap)}</span>
                ) : (
                  <span className="text-[10px] text-transparent mb-0.5">·</span>
                )}
                <ArrowRight size={13} className="text-slate-600" />
              </div>
              <StepBlock step={step} />
            </div>
          );
        })}

        {/* Sortie */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className="flex flex-col items-center">
            <span className="text-[10px] text-transparent mb-0.5">·</span>
            <ArrowRight size={13} className="text-slate-600" />
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <div className="w-9 h-9 rounded-full bg-slate-700/60 border border-slate-600/50 flex items-center justify-center text-slate-300 text-[10px] font-bold">
              OUT
            </div>
            <span className="text-[10px] text-slate-500 max-w-[48px] truncate text-center">
              {journey.mode_sortie ?? "Sortie"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Main Component ----

export function PatientJourney() {
  const { filters } = useFilters();
  const [search, setSearch]       = useState("");
  const [losRange, setLosRange]   = useState<LosRangeValue>("all");
  const [allPatients, setAllPatients] = useState<PatientSummary[]>([]);
  const [journeys, setJourneys]   = useState<PatientJourneyData[]>([]);
  const [page, setPage]           = useState(1);
  const [fetching, setFetching]   = useState(false);
  const [loadingJourneys, setLoadingJourneys] = useState(false);
  const [showList, setShowList]   = useState(false);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [view, setView]           = useState<"flow" | "gantt">("flow");
  const listRef = useRef<HTMLDivElement>(null);
  const listBtnRef = useRef<HTMLButtonElement>(null);
  const listPortalRef = useRef<HTMLDivElement>(null);
  const [listPos, setListPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!showList || !listBtnRef.current) return;
    function update() {
      const r = listBtnRef.current!.getBoundingClientRect();
      setListPos({ top: r.bottom + 6, left: r.left });
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [showList]);

  // Charger les patients au montage / quand losRange ou les filtres globaux changent
  useEffect(() => {
    setFetching(true);
    setJourneys([]);
    setPage(1);
    const range = LOS_RANGES.find((r) => r.value === losRange)!;
    api
      .patients("", 2000, range.min, range.max, filters)
      .then((res) => {
        const sorted = [...res].sort((a, b) => (b.los_min ?? 0) - (a.los_min ?? 0));
        setAllPatients(sorted);
      })
      .finally(() => setFetching(false));
  }, [losRange, filters]);

  // Filtre local par texte
  const filteredPatients = useMemo(() => {
    if (!search.trim()) return allPatients;
    const q = search.trim().toLowerCase();
    return allPatients.filter(
      (p) =>
        p.dossier_id.toLowerCase().includes(q) ||
        (p.patient_id?.toLowerCase().includes(q) ?? false)
    );
  }, [allPatients, search]);

  // Reset page on filter change
  useEffect(() => { setPage(1); setJourneys([]); }, [filteredPatients]);

  // IDs visibles pour la page courante
  const visibleIds = useMemo(
    () => filteredPatients.slice(0, page * PAGE_SIZE).map((p) => p.dossier_id),
    [filteredPatients, page]
  );

  // IDs déjà chargés
  const loadedIds = useMemo(() => journeys.map((j) => j.dossier_id), [journeys]);

  // Charger les parcours manquants quand visibleIds change
  useEffect(() => {
    const missing = visibleIds.filter((id) => !loadedIds.includes(id));
    if (missing.length === 0) return;
    setLoadingJourneys(true);
    api
      .patientJourney(missing)
      .then((res) => {
        setJourneys((prev) => {
          const map = new Map(prev.map((j) => [j.dossier_id, j]));
          res.forEach((j) => map.set(j.dossier_id, j));
          return Array.from(map.values());
        });
      })
      .finally(() => setLoadingJourneys(false));
  }, [visibleIds]);

  // Réordonner les journeys selon filteredPatients
  const orderedJourneys = useMemo(() => {
    const map = new Map(journeys.map((j) => [j.dossier_id, j]));
    return visibleIds.flatMap((id) => {
      const j = map.get(id);
      return j ? [j] : [];
    });
  }, [journeys, visibleIds]);

  const hasMore = filteredPatients.length > page * PAGE_SIZE;

  // Fermer la liste sur clic extérieur (le dropdown est portalisé, on vérifie aussi son ref)
  useEffect(() => {
    function handle(e: MouseEvent) {
      const t = e.target as Node;
      const insideTrigger = listRef.current?.contains(t);
      const insidePortal  = listPortalRef.current?.contains(t);
      if (!insideTrigger && !insidePortal) {
        setShowList(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  // Scroller vers un bloc et le mettre en surbrillance
  function scrollToBlock(id: string) {
    setShowList(false);
    setHighlighted(id);
    setTimeout(() => {
      document.getElementById(`block-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    setTimeout(() => setHighlighted(null), 2000);
  }

  return (
    <div className="space-y-5">
      {/* Barre de filtres */}
      <div className="card p-4 flex flex-wrap items-start gap-3">

        {/* Filtre durée de séjour */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <Clock size={14} className="text-slate-500" />
          <select
            value={losRange}
            onChange={(e) => setLosRange(e.target.value as LosRangeValue)}
            className="bg-slate-800/60 border border-slate-700/70 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-brand-500/50"
          >
            {LOS_RANGES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>

        {/* Recherche textuelle */}
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrer par dossier…"
            className="w-full pl-8 pr-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700/70 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-brand-500/50"
          />
        </div>

        {/* Liste déroulante patients */}
        <div className="relative flex-shrink-0" ref={listRef}>
          <button
            ref={listBtnRef}
            onClick={() => setShowList((v) => !v)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700/70 text-sm text-slate-200 hover:bg-slate-700/60 transition min-w-[200px] justify-between"
          >
            <span className="flex items-center gap-2">
              <User size={13} className="text-slate-500" />
              {fetching
                ? "Chargement…"
                : `${filteredPatients.length} patient${filteredPatients.length > 1 ? "s" : ""}`}
            </span>
            <ChevronDown
              size={14}
              className={`text-slate-500 transition-transform ${showList ? "rotate-180" : ""}`}
            />
          </button>

        </div>

        {/* Liste patients — portalisée pour échapper à tout stacking context parent */}
        {showList && !fetching && listPos && createPortal(
          <div
            ref={listPortalRef}
            style={{ position: "fixed", top: listPos.top, left: listPos.left, zIndex: 60 }}
            className="w-80 rounded-xl border border-slate-700/80 bg-slate-950/95 backdrop-blur-2xl shadow-[0_20px_60px_-10px_rgba(2,6,23,0.95),0_0_0_1px_rgba(34,211,238,0.10)] overflow-hidden animate-fade-in"
          >
            <div className="flex justify-between px-4 py-2 border-b border-slate-700/60 text-[11px] text-slate-500 bg-slate-900/70">
              <span>{filteredPatients.length} patients</span>
              <span>trié par DMS ↓</span>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {filteredPatients.map((p) => (
                <button
                  key={p.dossier_id}
                  onClick={() => scrollToBlock(p.dossier_id)}
                  className="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-slate-700/50 transition border-b border-slate-700/30 last:border-0"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <User size={12} className="text-slate-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm text-slate-200 font-medium truncate">
                        {p.dossier_id}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {p.arrivee
                          ? new Date(p.arrivee).toLocaleDateString("fr-FR")
                          : "—"}
                        {p.mode_sortie ? ` · ${p.mode_sortie}` : ""}
                      </div>
                    </div>
                  </div>
                  <span className="text-sm font-bold text-brand-300 flex-shrink-0">
                    {fmtMin(p.los_min)}
                  </span>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}

        {/* Toggle vue */}
        <div className="flex gap-1 p-1 rounded-lg bg-slate-800/60 border border-slate-700/50 flex-shrink-0">
          <button
            onClick={() => setView("flow")}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition",
              view === "flow"
                ? "bg-brand-500/20 text-brand-200 border border-brand-500/30"
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            <GitBranch size={12} />
            Diagramme
          </button>
          <button
            onClick={() => setView("gantt")}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition",
              view === "gantt"
                ? "bg-brand-500/20 text-brand-200 border border-brand-500/30"
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            <BarChart2 size={12} />
            Chronologie
          </button>
        </div>

        {/* Compteur */}
        <div className="text-xs text-slate-500 self-center ml-auto">
          {!fetching && (
            <>
              <span className="text-slate-300 font-medium">{orderedJourneys.length}</span>
              {" / "}
              <span className="text-slate-300 font-medium">{filteredPatients.length}</span>
              {" affichés"}
            </>
          )}
        </div>
      </div>

      {/* Aucun résultat */}
      {!fetching && filteredPatients.length === 0 && (
        <div className="card p-10 text-center text-slate-500 text-sm">
          Aucun patient dans cette plage de durée.
        </div>
      )}

      {/* Vue Gantt */}
      {view === "gantt" && orderedJourneys.length > 0 && (
        <div className="card p-5">
          <GanttChart journeys={orderedJourneys} />
          <ColorLegend journeys={orderedJourneys} />
        </div>
      )}

      {/* Vue Diagramme — blocs individuels */}
      {view === "flow" && (
        <>
          <div className="space-y-3">
            {orderedJourneys.map((j) => (
              <JourneyBlock key={j.dossier_id} journey={j} highlighted={highlighted === j.dossier_id} />
            ))}
          </div>

          {/* Squelettes pendant le chargement */}
          {loadingJourneys && (
            <div className="space-y-3">
              {Array.from({ length: Math.min(PAGE_SIZE, filteredPatients.length - orderedJourneys.length) }).map((_, i) => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="h-4 bg-slate-700/60 rounded w-48 mb-4" />
                  <div className="flex gap-3">
                    {Array.from({ length: 4 }).map((_, j) => (
                      <div key={j} className="h-16 w-28 bg-slate-700/40 rounded-xl" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Voir plus */}
          {hasMore && !loadingJourneys && (
            <button
              onClick={() => setPage((p) => p + 1)}
              className="w-full py-3 rounded-xl border border-slate-700/70 text-sm text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition flex items-center justify-center gap-2"
            >
              <ChevronDown size={16} />
              Voir plus ({filteredPatients.length - page * PAGE_SIZE} restants)
            </button>
          )}
        </>
      )}

      {/* Gantt : charger plus si besoin */}
      {view === "gantt" && hasMore && !loadingJourneys && (
        <button
          onClick={() => setPage((p) => p + 1)}
          className="w-full py-3 rounded-xl border border-slate-700/70 text-sm text-slate-400 hover:bg-slate-800/60 hover:text-slate-200 transition flex items-center justify-center gap-2"
        >
          <ChevronDown size={16} />
          Charger plus dans le Gantt ({filteredPatients.length - page * PAGE_SIZE} restants)
        </button>
      )}
    </div>
  );
}
