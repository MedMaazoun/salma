import type { Conformance } from "../api";

export function ConformanceGauge({ data }: { data: Conformance }) {
  const pct = data.conformance_rate;
  const R = 72;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - pct / 100);
  const color = pct > 75 ? "#22c55e" : pct > 50 ? "#f59e0b" : "#ef4444";
  const max = data.deviations[0]?.count ?? 1;

  return (
    <div className="flex flex-col md:flex-row items-center gap-6">
      <div className="relative">
        <svg width={180} height={180} viewBox="0 0 180 180">
          <circle cx={90} cy={90} r={R} stroke="#1e293b" strokeWidth={14} fill="none" />
          <circle
            cx={90}
            cy={90}
            r={R}
            stroke={color}
            strokeWidth={14}
            fill="none"
            strokeDasharray={C}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 90 90)"
            style={{ transition: "stroke-dashoffset 0.8s" }}
          />
          <text
            x={90}
            y={86}
            textAnchor="middle"
            fill="#e2e8f0"
            fontSize={28}
            fontWeight={700}
          >
            {pct.toFixed(0)}%
          </text>
          <text x={90} y={108} textAnchor="middle" fill="#64748b" fontSize={11}>
            conformité
          </text>
        </svg>
        <div className="text-center text-xs text-slate-500 mt-1">
          {data.conformant} / {data.total} dossiers
        </div>
      </div>
      <div className="flex-1 w-full space-y-2">
        <div className="text-sm text-slate-300 font-medium mb-1">Déviations principales</div>
        {data.deviations.length === 0 ? (
          <div className="text-xs text-slate-500">Aucune déviation.</div>
        ) : (
          data.deviations.map((d) => (
            <div key={d.type}>
              <div className="flex justify-between text-xs text-slate-300 mb-1">
                <span className="truncate">{d.type}</span>
                <span className="text-slate-500">{d.count}</span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-500 to-rose-500"
                  style={{ width: `${(d.count / max) * 100}%` }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
