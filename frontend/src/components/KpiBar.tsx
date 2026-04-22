import type { Kpis } from "../api";
import { Activity, Users, Clock, TrendingUp, HeartPulse } from "lucide-react";

function fmt(n: number | null | undefined, digits = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function KpiBar({ kpis }: { kpis: Kpis | null }) {
  const items = [
    {
      label: "Dossiers",
      value: kpis ? fmt(kpis.total_dossiers) : "—",
      icon: Activity,
    },
    {
      label: "Patients",
      value: kpis ? fmt(kpis.total_patients) : "—",
      icon: Users,
    },
    {
      label: "Durée médiane",
      value: kpis?.los_median_min != null ? `${fmt(kpis.los_median_min)} min` : "—",
      icon: Clock,
    },
    {
      label: "LOS p90",
      value: kpis?.los_p90_min != null ? `${fmt(kpis.los_p90_min)} min` : "—",
      icon: TrendingUp,
    },
    {
      label: "Hospitalisations",
      value: kpis?.hospit_pct != null ? `${fmt(kpis.hospit_pct, 1)}%` : "—",
      icon: HeartPulse,
    },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
      {items.map((it) => (
        <div
          key={it.label}
          className="card p-4 flex items-center gap-3"
        >
          <div className="h-10 w-10 rounded-xl bg-brand-500/10 text-brand-300 flex items-center justify-center border border-brand-500/20">
            <it.icon size={18} />
          </div>
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wider text-slate-400">
              {it.label}
            </div>
            <div className="text-xl font-semibold gradient-num truncate">
              {it.value}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
