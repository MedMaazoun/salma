import type { Bottleneck } from "../api";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

export function BottlenecksChart({ data }: { data: Bottleneck[] }) {
  const rows = [...data].reverse();
  const max = Math.max(1, ...rows.map((r) => r.mean_min ?? 0));
  return (
    <div style={{ height: Math.max(320, rows.length * 32) }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 10, right: 30 }}>
          <XAxis
            type="number"
            stroke="#64748b"
            tick={{ fill: "#94a3b8", fontSize: 11 }}
            tickFormatter={(v) => `${Math.round(v)}m`}
          />
          <YAxis
            type="category"
            dataKey="location"
            stroke="#64748b"
            tick={{ fill: "#cbd5e1", fontSize: 11 }}
            width={180}
          />
          <Tooltip
            cursor={{ fill: "rgba(34,211,238,0.05)" }}
            contentStyle={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 8,
              color: "#e2e8f0",
              fontSize: 12,
            }}
            formatter={(value, _n, item) => {
              const p = (item as unknown as { payload: Bottleneck }).payload;
              return [
                `${Math.round(Number(value))} min (n=${p.count})`,
                "Durée moyenne",
              ];
            }}
          />
          <Bar dataKey="mean_min" radius={[0, 6, 6, 0]}>
            {rows.map((r, i) => {
              const t = (r.mean_min ?? 0) / max;
              return <Cell key={i} fill={`rgba(34, 211, 238, ${0.35 + t * 0.6})`} />;
            })}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
