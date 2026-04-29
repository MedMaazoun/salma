import { useEffect, useState } from "react";
import { X, Loader2, ArrowRight, MapPin, Route } from "lucide-react";
import { api, type DrilldownResult } from "../api";
import { useFilters } from "../FiltersContext";
import { useDrillDown } from "../DrillDownContext";

function fmtMin(m: number | null | undefined): string {
  if (m == null) return "—";
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return r ? `${h} h ${r}` : `${h} h`;
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "2-digit" });
}

export function DrillDownModal() {
  const { target, close } = useDrillDown();
  const { filters } = useFilters();
  const [data, setData] = useState<DrilldownResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) { setData(null); setError(null); return; }
    setLoading(true); setError(null); setData(null);
    const promise = target.kind === "location"
      ? api.drilldownByLocation(target.location, filters)
      : api.drilldownByVariant(target.sequence, filters);
    promise
      .then((d) => setData(d))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [target, filters]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") close(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  if (!target) return null;

  const isLoc = target.kind === "location";
  const title = isLoc ? `Goulot · ${target.location}` : "Variante de parcours";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4 animate-fade-in" onClick={close}>
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-md" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-slate-800/80 bg-slate-950/90 backdrop-blur-2xl shadow-[0_0_0_1px_rgba(34,211,238,0.10),0_50px_120px_-20px_rgba(2,6,23,0.95)]"
      >
        {/* Header */}
        <div className="relative px-5 py-4 border-b border-slate-800/70 flex items-start gap-3">
          <span className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-brand-500/40 to-transparent" />
          <div className="relative flex-shrink-0">
            <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-500 to-sky-500 blur-md opacity-50" />
            <div className="relative h-9 w-9 rounded-lg bg-gradient-to-br from-brand-400 via-brand-500 to-sky-500 flex items-center justify-center ring-1 ring-white/10">
              {isLoc ? <MapPin size={16} className="text-slate-950" /> : <Route size={16} className="text-slate-950" />}
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-[0.22em] text-brand-300/90">Drill-down</div>
            <h3 className="text-sm font-semibold tracking-tight text-slate-50">{title}</h3>
            {!isLoc && target.kind === "variant" && (
              <div className="flex flex-wrap items-center gap-1 mt-1.5 text-[11px]">
                {target.sequence.map((s, j) => (
                  <span key={j} className="flex items-center gap-1">
                    <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 text-slate-300">{s}</span>
                    {j < target.sequence.length - 1 && <ArrowRight size={11} className="text-slate-600" />}
                  </span>
                ))}
              </div>
            )}
          </div>
          <button onClick={close} className="text-slate-500 hover:text-slate-100 transition" aria-label="Fermer">
            <X size={16} />
          </button>
        </div>

        {/* Stats */}
        {data && (
          <div className="px-5 pt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Dossiers" value={data.n_total.toLocaleString("fr-FR")} accent />
            {isLoc ? <>
              <Stat label="Durée moy." value={fmtMin(data.stats.mean_min)} />
              <Stat label="Médiane"    value={fmtMin(data.stats.median_min)} />
              <Stat label="P90"         value={fmtMin(data.stats.p90_min)} />
            </> : <>
              <Stat label="LOS moy." value={fmtMin(data.stats.mean_los)} />
              <Stat label="Médiane"   value={fmtMin(data.stats.median_los)} />
              <Stat label="P90"        value={fmtMin(data.stats.p90_los)} />
            </>}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center justify-center gap-3 h-40 text-slate-500">
              <Loader2 size={16} className="animate-spin" />
              <span className="text-sm">Chargement…</span>
            </div>
          )}
          {error && <div className="text-sm text-rose-300">Erreur : {error}</div>}
          {data && data.items.length === 0 && (
            <div className="text-sm text-slate-500 text-center py-10">Aucun dossier ne correspond.</div>
          )}
          {data && data.items.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-slate-800/70">
              <table className="w-full text-xs">
                <thead className="bg-slate-900/60 text-slate-500">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Dossier</th>
                    <th className="text-left font-medium px-3 py-2">Arrivée</th>
                    <th className="text-right font-medium px-3 py-2">LOS</th>
                    {isLoc
                      ? <>
                          <th className="text-right font-medium px-3 py-2">Sur le local</th>
                          <th className="text-right font-medium px-3 py-2">Passages</th>
                        </>
                      : <th className="text-right font-medium px-3 py-2">Étapes</th>
                    }
                    <th className="text-left font-medium px-3 py-2">Sortie</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((it, i) => (
                    <tr key={it.dossier_id} className={i % 2 === 0 ? "bg-slate-900/30" : ""}>
                      <td className="px-3 py-1.5 font-mono text-slate-300">{it.dossier_id}</td>
                      <td className="px-3 py-1.5 text-slate-400">{fmtDate(it.arrivee)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-slate-200">{fmtMin(it.los_min)}</td>
                      {isLoc
                        ? <>
                            <td className="px-3 py-1.5 text-right tabular-nums text-brand-300">{fmtMin(it.min_at_loc)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">{it.n_passages ?? 0}</td>
                          </>
                        : <td className="px-3 py-1.5 text-right tabular-nums text-slate-400">{it.n_steps ?? 0}</td>
                      }
                      <td className="px-3 py-1.5 text-slate-400 truncate max-w-[140px]">{it.mode_sortie || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && data.n_total > data.items.length && (
            <div className="mt-3 text-[11px] text-slate-500 text-center">
              Affichage des {data.items.length} sur {data.n_total.toLocaleString("fr-FR")} dossiers.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg border p-2.5 ${accent ? "border-brand-500/30 bg-brand-500/5" : "border-slate-800/70 bg-slate-900/40"}`}>
      <div className="text-[9px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className={`text-lg font-semibold tabular-nums mt-0.5 ${accent ? "gradient-num" : "text-slate-100"}`}>{value}</div>
    </div>
  );
}
