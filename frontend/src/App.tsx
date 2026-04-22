import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Hospital,
  LayoutDashboard,
  Network,
  Timer,
  FlaskConical,
  Brain,
  AlertTriangle,
  FileDown,
  Download,
  Presentation,
} from "lucide-react";
import {
  api,
  type Kpis,
  type Heatmap as HM,
  type ExitMode,
  type Variant,
  type ProcessGraph,
  type Bottleneck,
  type Sankey as SankeyT,
  type Conformance,
  type Readmissions,
  type Insight,
} from "./api";
import { FiltersProvider, useFilters } from "./FiltersContext";
import { FilterBar } from "./components/FilterBar";
import { KpiBar } from "./components/KpiBar";
import { Heatmap } from "./components/Heatmap";
import { ExitModesPie } from "./components/ExitModesPie";
import { VariantsList } from "./components/VariantsList";
import { ProcessMap } from "./components/ProcessMap";
import { BottlenecksChart } from "./components/BottlenecksChart";
import { Simulation } from "./components/Simulation";
import { CardSkeleton, Skeleton } from "./components/Skeleton";
import { SankeyDiagram } from "./components/Sankey";
import { ConformanceGauge } from "./components/ConformanceGauge";
import { ReadmissionsCard } from "./components/ReadmissionsCard";
import { Insights } from "./components/Insights";
import { Anomalies } from "./components/Anomalies";
import { Prediction } from "./components/Prediction";

type Tab = "overview" | "map" | "bottlenecks" | "predict" | "sim" | "anomalies";

const TABS: { id: Tab; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Vue d'ensemble", icon: LayoutDashboard },
  { id: "map", label: "Carte du parcours", icon: Network },
  { id: "bottlenecks", label: "Goulots", icon: Timer },
  { id: "predict", label: "Prédiction", icon: Brain },
  { id: "sim", label: "Simulation", icon: FlaskConical },
  { id: "anomalies", label: "Anomalies", icon: AlertTriangle },
];

const PRESENTATION_ORDER: Tab[] = ["overview", "map", "bottlenecks", "predict", "sim", "anomalies"];

function AppInner() {
  const { filters } = useFilters();
  const [tab, setTab] = useState<Tab>("overview");
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [heat, setHeat] = useState<HM | null>(null);
  const [modes, setModes] = useState<ExitMode[] | null>(null);
  const [variants, setVariants] = useState<Variant[] | null>(null);
  const [graph, setGraph] = useState<ProcessGraph | null>(null);
  const [bottlenecks, setBottlenecks] = useState<Bottleneck[] | null>(null);
  const [sankey, setSankey] = useState<SankeyT | null>(null);
  const [conf, setConf] = useState<Conformance | null>(null);
  const [readm, setReadm] = useState<Readmissions | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [presentation, setPresentation] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const mainRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setKpis(null);
    setHeat(null);
    setModes(null);
    setVariants(null);
    setGraph(null);
    setBottlenecks(null);
    setSankey(null);
    setConf(null);
    setReadm(null);
    setInsights([]);
    (async () => {
      try {
        const [k, h, m, v, g, b, sk, cf, rd, ins] = await Promise.all([
          api.kpis(filters),
          api.heatmap(filters),
          api.exitModes(filters),
          api.variants(10, filters),
          api.graph(filters),
          api.bottlenecks(filters),
          api.sankey(filters),
          api.conformance(filters),
          api.readmissions(filters),
          api.insights(filters),
        ]);
        if (cancelled) return;
        setKpis(k);
        setHeat(h);
        setModes(m);
        setVariants(v);
        setGraph(g);
        setBottlenecks(b);
        setSankey(sk);
        setConf(cf);
        setReadm(rd);
        setInsights(ins);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  // presentation auto-scroll
  useEffect(() => {
    if (!presentation) return;
    const t = setInterval(() => {
      setTab((cur) => {
        const i = PRESENTATION_ORDER.indexOf(cur);
        return PRESENTATION_ORDER[(i + 1) % PRESENTATION_ORDER.length];
      });
    }, 12000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPresentation(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, [presentation]);

  async function exportPdf() {
    if (!mainRef.current) return;
    setPdfLoading(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const { jsPDF } = await import("jspdf");
      const canvas = await html2canvas(mainRef.current, {
        backgroundColor: "#020617",
        scale: 1.4,
        useCORS: true,
      });
      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      let heightLeft = imgH;
      let position = 0;
      const data = canvas.toDataURL("image/png");
      pdf.addImage(data, "PNG", 0, position, imgW, imgH);
      heightLeft -= pageH;
      while (heightLeft > 0) {
        position = heightLeft - imgH;
        pdf.addPage();
        pdf.addImage(data, "PNG", 0, position, imgW, imgH);
        heightLeft -= pageH;
      }
      const today = new Date().toISOString().slice(0, 10);
      pdf.save(`ED_Flow_Report_${today}.pdf`);
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l'export PDF: " + (e as Error).message);
    } finally {
      setPdfLoading(false);
    }
  }

  function exportFlexsim() {
    window.location.href = api.flexsimExportUrl();
  }

  const currentTabLabel = TABS.find((t) => t.id === tab)?.label ?? "";

  return (
    <div className={clsx("min-h-full", presentation && "bg-slate-950")}>
      <header className="sticky top-0 z-20 backdrop-blur-lg bg-slate-950/60 border-b border-slate-800/70">
        <div className="max-w-[1400px] mx-auto px-6 py-4 flex flex-col lg:flex-row lg:items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-brand-500 to-sky-500 flex items-center justify-center shadow-glow">
              <Hospital size={20} className="text-slate-950" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-100 leading-tight">
                ED Flow Intelligence
              </h1>
              <div className="text-[11px] text-slate-400">
                Urgences pédiatriques ·{" "}
                {kpis
                  ? `${kpis.period_start.slice(0, 10)} → ${kpis.period_end.slice(0, 10)}`
                  : "chargement…"}
              </div>
            </div>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <button
              onClick={exportPdf}
              disabled={pdfLoading}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700/70 hover:bg-slate-800/60 transition disabled:opacity-50"
            >
              <FileDown size={14} />
              {pdfLoading ? "Export…" : "Rapport PDF"}
            </button>
            <button
              onClick={exportFlexsim}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-300 border border-slate-700/70 hover:bg-slate-800/60 transition"
            >
              <Download size={14} />
              Export FlexSim
            </button>
            <button
              onClick={() => setPresentation((p) => !p)}
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition",
                presentation
                  ? "bg-brand-500/20 text-brand-200 border-brand-500/40"
                  : "text-slate-300 border-slate-700/70 hover:bg-slate-800/60"
              )}
            >
              <Presentation size={14} />
              {presentation ? "Quitter présentation" : "Mode présentation"}
            </button>
          </div>
          <nav className="flex flex-wrap gap-1 p-1 rounded-xl border border-slate-800/70 bg-slate-900/50 self-start lg:self-auto">
            {TABS.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={clsx(
                    "inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition",
                    tab === t.id
                      ? "bg-gradient-to-r from-brand-500/20 to-sky-500/20 text-brand-200 border border-brand-500/30"
                      : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
                  )}
                >
                  <Icon size={14} />
                  {t.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main
        ref={mainRef}
        className={clsx(
          "max-w-[1400px] mx-auto px-6 py-6 space-y-6",
          presentation && "opacity-95"
        )}
      >
        {presentation && (
          <div className="rounded-2xl border border-brand-500/30 bg-gradient-to-r from-brand-500/10 to-sky-500/10 p-6 text-center">
            <div className="text-xs uppercase tracking-widest text-brand-300">
              Mode présentation · défilement auto 12s · Echap pour quitter
            </div>
            <div className="text-3xl font-bold text-slate-100 mt-1">{currentTabLabel}</div>
          </div>
        )}

        {!presentation && insights.length > 0 && <Insights items={insights} />}

        <KpiBar kpis={kpis} />

        {!presentation && <FilterBar />}

        {err && (
          <div className="card p-4 border-rose-500/40 text-rose-300">
            Erreur de chargement : {err}. Vérifiez que le backend tourne sur{" "}
            <code className="text-rose-200">http://localhost:8000</code>.
          </div>
        )}

        {tab === "overview" && (
          <div className="grid lg:grid-cols-3 gap-5">
            <section className="card p-5 lg:col-span-2">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-base font-semibold text-slate-100">
                  Heatmap des arrivées
                </h2>
                <span className="text-xs text-slate-500">jour × heure</span>
              </div>
              {heat ? <Heatmap data={heat} /> : <Skeleton className="h-56 w-full" />}
            </section>

            <section className="card p-5">
              <h2 className="text-base font-semibold text-slate-100 mb-3">
                Modes de sortie
              </h2>
              {modes ? <ExitModesPie data={modes} /> : <Skeleton className="h-72 w-full" />}
            </section>

            <section className="card p-5 lg:col-span-2">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-base font-semibold text-slate-100">
                  Flux des 3 premières étapes (Sankey)
                </h2>
                <span className="text-xs text-slate-500">top parcours initiaux</span>
              </div>
              {sankey ? (
                <SankeyDiagram data={sankey} />
              ) : (
                <Skeleton className="h-[440px] w-full" />
              )}
            </section>

            <section className="card p-5 space-y-5">
              <div>
                <h2 className="text-base font-semibold text-slate-100 mb-3">
                  Conformité
                </h2>
                {conf ? (
                  <ConformanceGauge data={conf} />
                ) : (
                  <Skeleton className="h-48 w-full" />
                )}
              </div>
              <div className="border-t border-slate-800/70 pt-4">
                {readm ? (
                  <ReadmissionsCard data={readm} />
                ) : (
                  <Skeleton className="h-24 w-full" />
                )}
              </div>
            </section>

            <section className="card p-5 lg:col-span-3">
              <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-base font-semibold text-slate-100">
                  Principales variantes de parcours
                </h2>
                <span className="text-xs text-slate-500">top 10 · par fréquence</span>
              </div>
              {variants ? (
                <VariantsList data={variants} />
              ) : (
                <div className="grid md:grid-cols-2 gap-3">
                  <CardSkeleton />
                  <CardSkeleton />
                </div>
              )}
            </section>
          </div>
        )}

        {tab === "map" && (
          <section className="card p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-100">
                Carte du parcours (Directly-Follows)
              </h2>
              <span className="text-xs text-slate-500">
                épaisseur = volume · libellé = nombre de transitions
              </span>
            </div>
            {graph ? (
              <ProcessMap graph={graph} />
            ) : (
              <Skeleton className="h-[620px] w-full" />
            )}
          </section>
        )}

        {tab === "bottlenecks" && (
          <section className="card p-5">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-100">
                Goulots d'étranglement
              </h2>
              <span className="text-xs text-slate-500">
                locaux triés par durée moyenne (min)
              </span>
            </div>
            {bottlenecks ? (
              <BottlenecksChart data={bottlenecks} />
            ) : (
              <Skeleton className="h-96 w-full" />
            )}
          </section>
        )}

        {tab === "predict" && <Prediction />}

        {tab === "sim" && <Simulation />}

        {tab === "anomalies" && <Anomalies />}

        <footer className="pt-4 pb-8 text-center text-xs text-slate-600">
          {kpis
            ? `${kpis.total_events.toLocaleString("fr-FR")} événements analysés · ${kpis.total_dossiers.toLocaleString("fr-FR")} dossiers`
            : ""}
        </footer>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <FiltersProvider>
      <AppInner />
    </FiltersProvider>
  );
}
