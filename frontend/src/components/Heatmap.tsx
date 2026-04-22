import type { Heatmap as HM } from "../api";

export function Heatmap({ data }: { data: HM }) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const max = Math.max(1, data.max);
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="grid" style={{ gridTemplateColumns: "50px repeat(24, minmax(18px, 1fr))" }}>
          <div />
          {hours.map((h) => (
            <div key={h} className="text-[10px] text-slate-500 text-center pb-1">
              {h}
            </div>
          ))}
          {data.days.map((d, r) => (
            <>
              <div key={`l-${r}`} className="text-xs text-slate-400 pr-2 flex items-center">
                {d}
              </div>
              {hours.map((h) => {
                const v = data.matrix[r][h];
                const t = v / max;
                const bg = `rgba(34, 211, 238, ${0.08 + t * 0.85})`;
                return (
                  <div
                    key={`${r}-${h}`}
                    title={`${d} ${h}h · ${v} arrivées`}
                    className="aspect-square rounded-[4px] m-[1px] border border-slate-800/60 hover:border-brand-400/60 transition-colors"
                    style={{ background: bg }}
                  />
                );
              })}
            </>
          ))}
        </div>
      </div>
    </div>
  );
}
