import type { Readmissions } from "../api";
import { Repeat } from "lucide-react";

export function ReadmissionsCard({ data }: { data: Readmissions }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Repeat size={16} className="text-brand-300" />
        <h3 className="text-sm font-semibold text-slate-100">Réadmissions</h3>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-slate-400 uppercase">7 jours</div>
          <div className="text-3xl font-bold gradient-num">
            {data.readmission_7d_rate.toFixed(1)}%
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-400 uppercase">30 jours</div>
          <div className="text-3xl font-bold text-sky-300">
            {data.readmission_30d_rate.toFixed(1)}%
          </div>
        </div>
      </div>
      {data.top_patients.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-800/70">
          <div className="text-[10px] uppercase text-slate-500 mb-1">
            Top patients récurrents
          </div>
          <div className="flex flex-wrap gap-1">
            {data.top_patients.slice(0, 5).map((p) => (
              <span key={p.patient_id} className="chip text-[10px] py-0.5 px-2">
                {p.patient_id.slice(0, 8)}… · {p.count}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
