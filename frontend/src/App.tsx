import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Hospital,
  MonitorDot,
  GitBranch,
  Box,
  TrendingUp,
  FileDown,
  Download,
  Presentation,
  ChevronRight,
  Search,
  Sparkles,
} from "lucide-react";
import {
  api,
  type ProcessGraph,
  type Variant,
  type Sankey as SankeyT,
  type Readmissions,
} from "./api";
import { useAssistant } from "./AssistantContext";
import { FiltersProvider, useFilters } from "./FiltersContext";
import { FilterBar } from "./components/FilterBar";
import { VariantsList } from "./components/VariantsList";
import { ProcessMap } from "./components/ProcessMap";
import { CardSkeleton, Skeleton } from "./components/Skeleton";
import { SankeyDiagram } from "./components/Sankey";
import { ReadmissionsCard } from "./components/ReadmissionsCard";
import { PatientJourney } from "./components/PatientJourney";
import { CommandCenter } from "./components/CommandCenter";
import { DigitalTwin3D } from "./components/DigitalTwin3D";
import { ResearchAnalytics } from "./components/ResearchAnalytics";
import { Simulation } from "./components/Simulation";
import { Prediction } from "./components/Prediction";
import { PathwayIntelligence } from "./components/PathwayIntelligence";
import { AssistantProvider } from "./AssistantContext";
import { Assistant } from "./components/Assistant";
import { CommandPalette, type PaletteApi } from "./components/CommandPalette";
import { BriefingBanner } from "./components/BriefingBanner";
import { DrillDownProvider } from "./DrillDownContext";
import { DrillDownModal } from "./components/DrillDownModal";

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = "monitoring" | "replay" | "twin" | "prospectif";

type LucideIcon = React.FC<{ size?: number; className?: string }>;

const TABS: { id: Tab; label: string; icon: LucideIcon; sub?: string }[] = [
  { id: "monitoring",  label: "Monitoring",        icon: MonitorDot   },
  { id: "replay",      label: "Replay & Processus", icon: GitBranch    },
  { id: "twin",        label: "Jumeau Numérique",   icon: Box          },
  { id: "prospectif",  label: "Prospectif & IA",    icon: TrendingUp   },
];

const SUB_TABS: Partial<Record<Tab, { id: string; label: string }[]>> = {
  replay: [
    { id: "carte",     label: "Carte du flux"      },
    { id: "sankey",    label: "Sankey"              },
    { id: "variantes", label: "Variantes"           },
    { id: "parcours",  label: "Parcours patients"   },
  ],
  prospectif: [
    { id: "simulation", label: "Simulation Monte Carlo" },
    { id: "prediction", label: "Prédiction IA LOS"      },
    { id: "parcours",   label: "Parcours IA"            },
    { id: "recherche",  label: "Recherche & SPC"        },
  ],
};

// ─── SubNav ───────────────────────────────────────────────────────────────────

function SubNav({
  tabs, active, onChange,
}: {
  tabs: { id: string; label: string }[];
  active: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="relative flex flex-wrap gap-1 border-b border-slate-800/70 pb-3 mb-5">
      {tabs.map((t, i) => {
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={clsx(
              "relative inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm transition-all duration-200",
              isActive
                ? "text-brand-100 bg-gradient-to-b from-brand-500/15 to-brand-500/5 border border-brand-500/30 shadow-[0_0_0_1px_rgba(34,211,238,0.08),0_8px_24px_-12px_rgba(34,211,238,0.35)]"
                : "text-slate-500 hover:text-slate-200 hover:bg-slate-800/40 border border-transparent"
            )}
          >
            {i > 0 && !isActive && (
              <ChevronRight size={11} className="text-slate-700" />
            )}
            {t.label}
            {isActive && (
              <span className="absolute -bottom-[13px] left-3 right-3 h-[2px] rounded-full bg-gradient-to-r from-brand-400 via-sky-400 to-brand-400 shadow-[0_0_10px_rgba(34,211,238,0.7)]" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── AppInner ─────────────────────────────────────────────────────────────────

function AppInner() {
  const { filters, setFilters, reset: resetFilters } = useFilters();
  const { setGlobalContext, setOpen: setAssistantOpen } = useAssistant();
  const [tab, setTab]         = useState<Tab>("monitoring");
  const [replaySub, setReplaySub]       = useState("carte");
  const [prospectifSub, setProspectifSub] = useState("simulation");
  const [briefingEnabled, setBriefingEnabled] = useState<boolean>(() => {
    try { return localStorage.getItem("ed-briefing-enabled") === "1"; }
    catch { return false; }
  });
  function toggleBriefing(v: boolean) {
    setBriefingEnabled(v);
    try { localStorage.setItem("ed-briefing-enabled", v ? "1" : "0"); } catch { /* ignore */ }
  }

  // Data for Replay & Monitoring sections
  const [graph,    setGraph]    = useState<ProcessGraph | null>(null);
  const [variants, setVariants] = useState<Variant[] | null>(null);
  const [sankey,   setSankey]   = useState<SankeyT | null>(null);
  const [readm,    setReadm]    = useState<Readmissions | null>(null);
  const [err,      setErr]      = useState<string | null>(null);

  const [presentation, setPresentation] = useState(false);
  const [pdfLoading,   setPdfLoading]   = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setGraph(null); setVariants(null); setSankey(null);
    setReadm(null);
    (async () => {
      try {
        const [g, v, sk, rd, kp, bn, em] = await Promise.all([
          api.graph(filters),
          api.variants(10, filters),
          api.sankey(filters),
          api.readmissions(filters),
          api.kpis(filters),
          api.bottlenecks(filters),
          api.exitModes(filters),
        ]);
        if (cancelled) return;
        setGraph(g); setVariants(v); setSankey(sk);
        setReadm(rd);

        // ── Build the always-on global snapshot for the assistant
        const totalExits = em.reduce((s, m) => s + m.count, 0);
        setGlobalContext({
          service: "Urgences pédiatriques",
          period: { from: kp.period_start, to: kp.period_end, n_events: kp.total_events },
          filters: {
            date_from: filters.date_from ?? null,
            date_to: filters.date_to ?? null,
            exit_mode: filters.exit_mode ?? null,
            hour_from: filters.hour_from ?? null,
            hour_to: filters.hour_to ?? null,
          },
          kpis: {
            total_dossiers: kp.total_dossiers,
            total_patients: kp.total_patients,
            los_median_min: kp.los_median_min,
            los_p90_min: kp.los_p90_min,
            hospit_pct: kp.hospit_pct,
          },
          top_bottlenecks: bn.slice(0, 5).map((b) => ({
            location: b.location,
            mean_min: b.mean_min != null ? Math.round(b.mean_min) : null,
            median_min: b.median_min != null ? Math.round(b.median_min) : null,
            p90_min: b.p90_min != null ? Math.round(b.p90_min) : null,
            count: b.count,
          })),
          top_variants: v.slice(0, 3).map((va) => ({
            sequence: va.sequence,
            count: va.count,
            pct: Number((va.pct * 100).toFixed(1)),
          })),
          exit_mix: em.map((m) => ({
            mode: m.mode,
            count: m.count,
            pct: totalExits > 0 ? Number(((m.count / totalExits) * 100).toFixed(1)) : 0,
          })),
          readmissions: rd ? {
            rate_7d_pct: rd.readmission_7d_rate,    // already 0–100
            rate_30d_pct: rd.readmission_30d_rate,  // already 0–100
            top_patients_count: rd.top_patients.length,
          } : null,
        });
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [filters, setGlobalContext]);

  // Presentation auto-scroll
  useEffect(() => {
    if (!presentation) return;
    const order: Tab[] = ["monitoring", "replay", "twin", "prospectif"];
    const t = setInterval(() => {
      setTab((cur) => order[(order.indexOf(cur) + 1) % order.length]);
    }, 14000);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPresentation(false); };
    window.addEventListener("keydown", onKey);
    return () => { clearInterval(t); window.removeEventListener("keydown", onKey); };
  }, [presentation]);

  async function exportPdf() {
    setPdfLoading(true);
    try {
      const [kp, bn, em] = await Promise.all([
        api.kpis(filters),
        api.bottlenecks(filters),
        api.exitModes(filters),
      ]);
      const variantsList = variants ?? await api.variants(10, filters);
      const readmData    = readm    ?? await api.readmissions(filters);

      // Try to recover cached briefing
      let briefing: string | null = null;
      try {
        const raw = localStorage.getItem("ed-briefing-cache");
        if (raw) {
          const c = JSON.parse(raw) as { content?: string; ts?: number };
          if (c.content && c.ts && Date.now() - c.ts < 6 * 60 * 60 * 1000) briefing = c.content;
        }
      } catch { /* ignore */ }

      const { generateReport } = await import("./pdfReport");
      await generateReport({
        generatedAt: new Date(),
        period: { from: kp.period_start, to: kp.period_end },
        service: "Urgences pédiatriques",
        filters,
        kpis: kp,
        bottlenecks: bn,
        variants: variantsList,
        exitModes: em,
        readmissions: readmData,
        briefing,
      });
    } catch (e) {
      alert("Erreur PDF : " + (e as Error).message);
    } finally {
      setPdfLoading(false);
    }
  }

  function setDatePreset(preset: "today" | "week" | "month" | "all") {
    if (preset === "all") { resetFilters(); return; }
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const days = preset === "today" ? 0 : preset === "week" ? 7 : 30;
    const from = new Date(today); from.setDate(from.getDate() - days);
    setFilters({ ...filters, date_from: iso(from), date_to: iso(today) });
  }

  const paletteApi: PaletteApi = {
    setTab,
    setReplaySub,
    setProspectifSub,
    setPresentation,
    exportPdf,
    flexsimUrl: () => api.flexsimExportUrl(),
    setDatePreset,
    clearFilters: resetFilters,
    openAssistant: () => setAssistantOpen(true),
  };

  return (
    <div className={clsx("min-h-full", presentation && "bg-slate-950")}>

      {/* ── HEADER ── */}
      <header className="sticky top-0 z-20 backdrop-blur-xl bg-slate-950/70 border-b border-slate-800/70">
        <span className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-brand-500/40 to-transparent" />
        <div className="max-w-[1400px] mx-auto px-6 py-3 flex flex-col lg:flex-row lg:items-center gap-3">

          {/* Logo */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <div className="relative">
              <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-brand-500 to-sky-500 blur-md opacity-50" />
              <div className="relative h-10 w-10 rounded-xl bg-gradient-to-br from-brand-400 via-brand-500 to-sky-500 flex items-center justify-center ring-1 ring-white/10 shadow-glow">
                <Hospital size={18} className="text-slate-950" />
              </div>
            </div>
            <div>
              <h1 className="text-[15px] font-semibold tracking-tight text-slate-50 leading-tight">
                ED <span className="gradient-num">Flow</span> Intelligence
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="live-dot" />
                <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500">Urgences pédiatriques · Live</span>
              </div>
            </div>
          </div>

          {/* Main nav */}
          <nav className="flex flex-wrap gap-1 p-1 rounded-xl border border-slate-800/80 bg-slate-900/60 backdrop-blur-md shadow-inner1 lg:mx-6">
            {TABS.map((t) => {
              const Icon = t.icon;
              const isActive = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={clsx(
                    "group relative inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm transition-all duration-200",
                    isActive
                      ? "text-brand-100 bg-gradient-to-b from-brand-500/25 to-sky-500/10 border border-brand-500/40 shadow-[0_0_0_1px_rgba(34,211,238,0.12),0_10px_28px_-12px_rgba(34,211,238,0.45)]"
                      : "text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent"
                  )}
                >
                  <Icon size={14} className={clsx("transition-transform duration-200", isActive ? "scale-110" : "group-hover:scale-105")} />
                  {t.label}
                </button>
              );
            })}
          </nav>

          <div className="flex-1" />

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
              className="btn-ghost"
              title="Palette de commandes"
            >
              <Search size={13} />
              <span>Rechercher</span>
              <kbd className="ml-1 font-mono text-[9px] text-slate-500 border border-slate-700/70 rounded px-1 py-[1px]">⌘K</kbd>
            </button>
            <button onClick={exportPdf} disabled={pdfLoading} className="btn-ghost disabled:opacity-50">
              <FileDown size={13} />
              {pdfLoading ? "Export…" : "PDF"}
            </button>
            <button onClick={() => window.location.href = api.flexsimExportUrl()} className="btn-ghost">
              <Download size={13} />
              FlexSim
            </button>
            <button onClick={() => setPresentation((p) => !p)}
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-all",
                presentation
                  ? "bg-gradient-to-r from-brand-500/30 to-sky-500/20 text-brand-100 border-brand-400/50 shadow-[0_0_0_1px_rgba(34,211,238,0.18),0_8px_24px_-10px_rgba(34,211,238,0.5)]"
                  : "text-slate-300 border-slate-700/70 hover:bg-slate-800/60 hover:border-brand-500/40"
              )}>
              <Presentation size={13} />
              {presentation ? "Quitter" : "Présentation"}
            </button>
          </div>
        </div>

        {/* Filter bar — hidden in monitoring (CommandCenter has its own refresh) */}
        {tab !== "monitoring" && tab !== "twin" && (
          <div className="max-w-[1400px] mx-auto px-6 pb-2">
            <FilterBar />
          </div>
        )}
      </header>

      {/* ── MAIN ── */}
      <main ref={mainRef} className="max-w-[1400px] mx-auto px-6 py-6 space-y-5">

        {presentation && (
          <div className="relative overflow-hidden rounded-2xl border border-brand-500/30 bg-gradient-to-r from-brand-500/10 via-slate-900/40 to-sky-500/10 p-6 text-center animate-slide-up">
            <span className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-brand-400 to-transparent" />
            <span className="pointer-events-none absolute -inset-1 bg-[radial-gradient(600px_circle_at_50%_-20%,rgba(34,211,238,0.18),transparent_60%)]" />
            <div className="relative">
              <div className="inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.28em] text-brand-300/90">
                <span className="live-dot" /> Mode présentation · auto 14s · Echap pour quitter
              </div>
              <div className="text-3xl font-bold tracking-tight text-slate-50 mt-2">
                {TABS.find((t) => t.id === tab)?.label}
              </div>
            </div>
          </div>
        )}

        {err && (
          <div className="card p-4 border-rose-500/40 text-rose-300 text-sm">
            Erreur de chargement : {err}. Vérifiez que le backend tourne sur{" "}
            <code className="text-rose-200">http://localhost:8000</code>.
          </div>
        )}

        {/* ══ MONITORING ══════════════════════════════════════════════════════ */}
        {tab === "monitoring" && (
          <div key="monitoring" className="space-y-5 animate-fade-in">
            {briefingEnabled ? (
              <BriefingBanner onClose={() => toggleBriefing(false)} />
            ) : (
              <button
                onClick={() => toggleBriefing(true)}
                className="inline-flex items-center gap-2 text-[11px] text-slate-500 hover:text-brand-300 transition"
              >
                <Sparkles size={12} />
                Activer le briefing IA
              </button>
            )}
            <CommandCenter />
            <section className="card p-5">
              <div className="flex items-center gap-2 mb-4">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.7)]" />
                <h2 className="text-base font-semibold tracking-tight text-slate-50">Ré-admissions</h2>
                <span className="text-[10px] uppercase tracking-[0.18em] text-slate-500 ml-1">qualité &amp; suivi</span>
              </div>
              {readm ? <ReadmissionsCard data={readm} /> : <Skeleton className="h-24 w-full" />}
            </section>
          </div>
        )}

        {/* ══ REPLAY & PROCESSUS ══════════════════════════════════════════════ */}
        {tab === "replay" && (
          <div key="replay" className="animate-fade-in">
            <SubNav
              tabs={SUB_TABS.replay!}
              active={replaySub}
              onChange={setReplaySub}
            />

            {replaySub === "carte" && (
              <section className="card p-5">
                <div className="flex items-baseline justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(34,211,238,0.7)]" />
                    <h2 className="text-base font-semibold tracking-tight text-slate-50">Carte du parcours (Directly-Follows)</h2>
                  </div>
                  <span className="text-xs text-slate-500">épaisseur = volume · libellé = transitions</span>
                </div>
                {graph ? <ProcessMap graph={graph} /> : <Skeleton className="h-[620px] w-full" />}
              </section>
            )}

            {replaySub === "sankey" && (
              <section className="card p-5">
                <div className="flex items-baseline justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.7)]" />
                    <h2 className="text-base font-semibold tracking-tight text-slate-50">Flux des 3 premières étapes (Sankey)</h2>
                  </div>
                  <span className="text-xs text-slate-500">top parcours initiaux</span>
                </div>
                {sankey ? <SankeyDiagram data={sankey} /> : <Skeleton className="h-[440px] w-full" />}
              </section>
            )}

            {replaySub === "variantes" && (
              <section className="card p-5">
                <div className="flex items-baseline justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-400 shadow-[0_0_8px_rgba(167,139,250,0.7)]" />
                    <h2 className="text-base font-semibold tracking-tight text-slate-50">Principales variantes de parcours</h2>
                  </div>
                  <span className="text-xs text-slate-500">top 10 · par fréquence</span>
                </div>
                {variants
                  ? <VariantsList data={variants} />
                  : <div className="grid md:grid-cols-2 gap-3"><CardSkeleton /><CardSkeleton /></div>
                }
              </section>
            )}

            {replaySub === "parcours" && <PatientJourney />}
          </div>
        )}

        {/* ══ JUMEAU NUMÉRIQUE ════════════════════════════════════════════════ */}
        {tab === "twin" && (
          <div key="twin" className="animate-fade-in">
            <div className="mb-5 flex items-center gap-3">
              <div className="relative">
                <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-sky-500 to-brand-500 blur-md opacity-50" />
                <div className="relative h-9 w-9 rounded-lg bg-gradient-to-br from-sky-400 via-brand-500 to-brand-600 flex items-center justify-center ring-1 ring-white/10">
                  <Box size={16} className="text-slate-950" />
                </div>
              </div>
              <div>
                <h2 className="text-base font-semibold tracking-tight text-slate-50">Jumeau Numérique 3D</h2>
                <p className="text-xs text-slate-500">Simulation temps-réel des flux patients dans le service</p>
              </div>
            </div>
            <DigitalTwin3D />
          </div>
        )}

        {/* ══ PROSPECTIF & IA ═════════════════════════════════════════════════ */}
        {tab === "prospectif" && (
          <div key="prospectif" className="animate-fade-in">
            <SubNav
              tabs={SUB_TABS.prospectif!}
              active={prospectifSub}
              onChange={setProspectifSub}
            />

            {prospectifSub === "simulation" && <Simulation hideTwinButton />}
            {prospectifSub === "prediction"  && <Prediction />}
            {prospectifSub === "parcours"    && <PathwayIntelligence />}
            {prospectifSub === "recherche"   && <ResearchAnalytics />}
          </div>
        )}

        <footer className="pt-6 pb-8">
          <div className="divider-soft mb-4" />
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 text-[10px] uppercase tracking-[0.22em] text-slate-600">
            <div className="flex items-center gap-2">
              <span className="live-dot" />
              ED Flow Intelligence · Urgences pédiatriques
            </div>
            <div className="text-slate-700">v1 · process mining · digital twin</div>
          </div>
        </footer>
      </main>

      <CommandPalette api={paletteApi} />
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <FiltersProvider>
      <AssistantProvider>
        <DrillDownProvider>
          <AppInner />
          <Assistant />
          <DrillDownModal />
        </DrillDownProvider>
      </AssistantProvider>
    </FiltersProvider>
  );
}
