import { useEffect, useMemo, useState } from "react";
import { api, type AnomaliesResponse } from "../api";
import { useFilters } from "../FiltersContext";
import { AlertTriangle, ArrowUpDown } from "lucide-react";
import { Skeleton } from "./Skeleton";

type SortKey = "los_min" | "dossier_id";

export function Anomalies() {
  const { filters } = useFilters();
  const [data, setData] = useState<AnomaliesResponse | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("los_min");
  const [asc, setAsc] = useState(false);

  useEffect(() => {
    setData(null);
    api.anomalies(filters).then(setData).catch(() => setData(null));
  }, [filters]);

  const sorted = useMemo(() => {
    if (!data) return [];
    const arr = [...data.items];
    arr.sort((a, b) => {
      const va = a[sortKey] as number | string;
      const vb = b[sortKey] as number | string;
      if (typeof va === "number" && typeof vb === "number") return asc ? va - vb : vb - va;
      return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
    return arr;
  }, [data, sortKey, asc]);

  if (!data) return <Skeleton className="h-96 w-full" />;

  function toggleSort(k: SortKey) {
    if (sortKey === k) setAsc(!asc);
    else {
      setSortKey(k);
      setAsc(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid md:grid-cols-3 gap-4">
        <div className="card p-4">
          <div className="text-xs uppercase text-slate-400">Anomalies détectées</div>
          <div className="text-3xl font-bold gradient-num">{data.total}</div>
        </div>
        <div className="card p-4">
          <div className="text-xs uppercase text-slate-400">% du total</div>
          <div className="text-3xl font-bold text-amber-300">{data.pct.toFixed(2)}%</div>
        </div>
        <div className="card p-4 flex items-center gap-3">
          <AlertTriangle className="text-rose-400" size={28} />
          <div className="text-sm text-slate-300">
            Dossiers avec LOS &gt; μ+3σ ou variante &lt; 0.5% de fréquence.
          </div>
        </div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-900/70">
            <tr className="text-left text-slate-400 text-xs uppercase">
              <th className="px-4 py-2">
                <button
                  onClick={() => toggleSort("dossier_id")}
                  className="inline-flex items-center gap-1"
                >
                  Dossier <ArrowUpDown size={12} />
                </button>
              </th>
              <th className="px-4 py-2">
                <button
                  onClick={() => toggleSort("los_min")}
                  className="inline-flex items-center gap-1"
                >
                  LOS (min) <ArrowUpDown size={12} />
                </button>
              </th>
              <th className="px-4 py-2">Parcours</th>
              <th className="px-4 py-2">Raison</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((a) => (
              <tr key={a.dossier_id} className="border-t border-slate-800/70 hover:bg-slate-900/40">
                <td className="px-4 py-2 text-slate-300 font-mono text-xs">{a.dossier_id}</td>
                <td className="px-4 py-2 text-amber-300 font-semibold">{a.los_min.toFixed(0)}</td>
                <td className="px-4 py-2 text-slate-400 text-xs">{a.variant}</td>
                <td className="px-4 py-2 text-rose-300 text-xs">{a.reason}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-slate-500">
                  Aucune anomalie avec les filtres actuels.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
