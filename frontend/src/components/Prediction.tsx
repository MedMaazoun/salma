import { useEffect, useState } from "react";
import { api, type ClusterItem, type PredictOptions, type PredictResponse } from "../api";
import { useFilters } from "../FiltersContext";
import { Brain, Loader2, Play, Sparkles } from "lucide-react";

const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];

export function Prediction() {
  const { filters } = useFilters();
  const [opts, setOpts] = useState<PredictOptions | null>(null);
  const [hour, setHour] = useState(14);
  const [dow, setDow] = useState(1);
  const [month, setMonth] = useState(6);
  const [firstLoc, setFirstLoc] = useState("");
  const [exitMode, setExitMode] = useState("");
  const [res, setRes] = useState<PredictResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [clusters, setClusters] = useState<ClusterItem[]>([]);

  useEffect(() => {
    api.predictOptions().then((o) => {
      setOpts(o);
      if (o.first_locations[0]) setFirstLoc(o.first_locations[0]);
      if (o.exit_modes[0]) setExitMode(o.exit_modes[0]);
    });
  }, []);

  useEffect(() => {
    api.clusters(filters).then((r) => setClusters(r.clusters)).catch(() => setClusters([]));
  }, [filters]);

  async function run() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.predict({
        hour, day_of_week: dow, month,
        first_location: firstLoc, exit_mode: exitMode,
      });
      setRes(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid md:grid-cols-5 gap-5">
        <div className="card p-5 md:col-span-2 space-y-4">
          <div className="flex items-center gap-2">
            <Brain className="text-brand-300" size={20} />
            <h3 className="text-lg font-semibold text-slate-100">Prédire la durée</h3>
          </div>

          <div>
            <label className="text-xs text-slate-400 uppercase">Heure d'arrivée</label>
            <input
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => setHour(Number(e.target.value))}
              className="w-full bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-2 text-sm text-slate-200"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase">Jour</label>
            <select
              value={dow}
              onChange={(e) => setDow(Number(e.target.value))}
              className="w-full bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-2 text-sm text-slate-200"
            >
              {DAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase">Mois</label>
            <input
              type="number"
              min={1}
              max={12}
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="w-full bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-2 text-sm text-slate-200"
            />
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase">Premier local</label>
            <select
              value={firstLoc}
              onChange={(e) => setFirstLoc(e.target.value)}
              className="w-full bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-2 text-sm text-slate-200"
            >
              {opts?.first_locations.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 uppercase">Mode de sortie</label>
            <select
              value={exitMode}
              onChange={(e) => setExitMode(e.target.value)}
              className="w-full bg-slate-900/70 border border-slate-700/70 rounded-lg px-3 py-2 text-sm text-slate-200"
            >
              {opts?.exit_modes.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <button
            onClick={run}
            disabled={loading || !firstLoc || !exitMode}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-sky-500 hover:from-brand-400 hover:to-sky-400 text-slate-950 font-semibold px-4 py-2.5 transition disabled:opacity-60"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            Prédire
          </button>
          {err && <div className="text-sm text-rose-400">{err}</div>}
        </div>

        <div className="md:col-span-3 space-y-4">
          {res ? (
            <div className="card p-6">
              <div className="text-xs uppercase text-slate-400 mb-1">LOS prédit</div>
              <div className="text-6xl font-bold gradient-num">
                {res.predicted_los_min.toFixed(0)}
                <span className="text-2xl text-slate-500 ml-2">min</span>
              </div>
              <div className="mt-6">
                <div className="text-xs text-slate-400 mb-2">
                  Intervalle de confiance (p10 – p90)
                </div>
                <div className="flex items-center gap-3">
                  <div className="text-sm text-slate-300 w-14">{res.p10.toFixed(0)} min</div>
                  <div className="flex-1 h-3 rounded-full bg-slate-800 relative overflow-hidden">
                    <div
                      className="absolute top-0 h-full bg-gradient-to-r from-brand-500/60 to-sky-500/60 rounded-full"
                      style={{
                        left: "0%",
                        width: "100%",
                      }}
                    />
                    <div
                      className="absolute top-[-4px] h-5 w-1 bg-white rounded"
                      style={{
                        left: `${Math.min(100, Math.max(0, ((res.predicted_los_min - res.p10) / Math.max(1, res.p90 - res.p10)) * 100))}%`,
                      }}
                    />
                  </div>
                  <div className="text-sm text-slate-300 w-14 text-right">{res.p90.toFixed(0)} min</div>
                </div>
              </div>
            </div>
          ) : (
            <div className="card p-10 text-center text-slate-400">
              Configurez les paramètres puis cliquez sur "Prédire".
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="text-brand-300" size={18} />
          <h3 className="text-base font-semibold text-slate-100">Archétypes de parcours</h3>
          <span className="text-xs text-slate-500">· clustering TF-IDF + KMeans</span>
        </div>
        <div className="grid md:grid-cols-3 gap-4">
          {clusters.map((cl) => (
            <div key={cl.cluster_id} className="card p-5 space-y-3">
              <div className="flex items-baseline justify-between">
                <div className="text-sm font-semibold text-brand-300">{cl.label}</div>
                <div className="text-xs text-slate-500">{cl.size} dossiers</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">LOS moyen</div>
                <div className="text-2xl font-bold text-slate-100">
                  {cl.avg_los_min.toFixed(0)}
                  <span className="text-xs text-slate-500 ml-1">min</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-400 mb-1">Locaux typiques</div>
                <div className="flex flex-wrap gap-1">
                  {cl.top_locations.map((l) => (
                    <span key={l} className="chip text-[10px] py-0.5 px-2">{l}</span>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-400">Sortie principale</div>
                <div className="text-sm text-slate-200">{cl.top_exit_mode}</div>
              </div>
            </div>
          ))}
          {clusters.length === 0 && (
            <div className="card p-8 text-center text-slate-500 col-span-3">
              Pas assez de données pour les clusters.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
