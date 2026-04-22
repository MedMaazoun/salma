import type { Variant } from "../api";
import { ArrowRight } from "lucide-react";

export function VariantsList({ data }: { data: Variant[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="space-y-2">
      {data.map((v, i) => (
        <div key={i} className="rounded-xl border border-slate-800/70 bg-slate-900/30 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-slate-400">Variante #{i + 1}</div>
            <div className="text-sm font-medium text-slate-200">
              {v.count.toLocaleString("fr-FR")}{" "}
              <span className="text-slate-500">({v.pct}%)</span>
            </div>
          </div>
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden mb-2">
            <div
              className="h-full bg-gradient-to-r from-brand-500 to-sky-400"
              style={{ width: `${(v.count / max) * 100}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 text-[11px]">
            {v.sequence.map((s, j) => (
              <span key={j} className="flex items-center gap-1">
                <span className="px-2 py-0.5 rounded bg-slate-800/80 border border-slate-700/60 text-slate-300">
                  {s}
                </span>
                {j < v.sequence.length - 1 && (
                  <ArrowRight size={12} className="text-slate-600" />
                )}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
