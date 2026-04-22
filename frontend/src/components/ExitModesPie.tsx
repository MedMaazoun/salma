import type { ExitMode } from "../api";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts";

const COLORS = ["#22d3ee", "#38bdf8", "#818cf8", "#a78bfa", "#f472b6", "#fb7185", "#facc15"];

export function ExitModesPie({ data }: { data: ExitMode[] }) {
  const shown = data.slice(0, 7);
  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={shown}
            dataKey="count"
            nameKey="mode"
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={95}
            paddingAngle={2}
            stroke="#0f172a"
          >
            {shown.map((_, i) => (
              <Cell key={i} fill={COLORS[i % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "#0f172a",
              border: "1px solid #334155",
              borderRadius: 8,
              color: "#e2e8f0",
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }}
            formatter={(v) => <span className="text-slate-300">{v}</span>}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
