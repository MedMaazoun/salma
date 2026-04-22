import { useEffect, useState } from "react";
import { useFilters } from "../FiltersContext";
import { api, type ExitMode } from "../api";
import { RotateCcw, Filter } from "lucide-react";

export function FilterBar() {
  const { filters, setFilters, reset } = useFilters();
  const [modes, setModes] = useState<ExitMode[]>([]);

  useEffect(() => {
    api.exitModes().then(setModes).catch(() => setModes([]));
  }, []);

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex items-center gap-2 text-slate-300">
          <Filter size={16} className="text-brand-300" />
          <span className="text-sm font-medium">Filtres</span>
        </div>

        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-1">Du</label>
          <input
            type="date"
            value={filters.date_from ?? ""}
            onChange={(e) =>
              setFilters({ ...filters, date_from: e.target.value || null })
            }
            className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-2 py-1 text-sm text-slate-200"
          />
        </div>

        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-1">Au</label>
          <input
            type="date"
            value={filters.date_to ?? ""}
            onChange={(e) =>
              setFilters({ ...filters, date_to: e.target.value || null })
            }
            className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-2 py-1 text-sm text-slate-200"
          />
        </div>

        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-1">
            Mode sortie
          </label>
          <select
            value={filters.exit_mode ?? ""}
            onChange={(e) =>
              setFilters({ ...filters, exit_mode: e.target.value || null })
            }
            className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-2 py-1 text-sm text-slate-200 min-w-[160px]"
          >
            <option value="">Tous</option>
            {modes.map((m) => (
              <option key={m.mode} value={m.mode}>
                {m.mode} ({m.count})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-1">
            Heure de (0-23)
          </label>
          <input
            type="number"
            min={0}
            max={23}
            value={filters.hour_from ?? ""}
            onChange={(e) =>
              setFilters({
                ...filters,
                hour_from: e.target.value === "" ? null : Number(e.target.value),
              })
            }
            className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-2 py-1 text-sm text-slate-200 w-20"
          />
        </div>

        <div>
          <label className="block text-[10px] uppercase text-slate-500 mb-1">
            Heure à (0-23)
          </label>
          <input
            type="number"
            min={0}
            max={23}
            value={filters.hour_to ?? ""}
            onChange={(e) =>
              setFilters({
                ...filters,
                hour_to: e.target.value === "" ? null : Number(e.target.value),
              })
            }
            className="bg-slate-900/70 border border-slate-700/70 rounded-lg px-2 py-1 text-sm text-slate-200 w-20"
          />
        </div>

        <button
          onClick={reset}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-slate-300 border border-slate-700/70 hover:bg-slate-800/60 transition"
        >
          <RotateCcw size={14} />
          Réinitialiser
        </button>
      </div>
    </div>
  );
}
