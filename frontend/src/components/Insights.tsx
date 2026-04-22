import { useEffect, useState } from "react";
import type { Insight } from "../api";
import clsx from "clsx";

export function Insights({ items }: { items: Insight[] }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (items.length === 0) return;
    const t = setInterval(() => setActive((i) => (i + 1) % items.length), 4000);
    return () => clearInterval(t);
  }, [items.length]);

  if (items.length === 0) return null;

  return (
    <div className="card p-3 flex items-center gap-3 overflow-hidden">
      <div className="text-xs uppercase tracking-wider text-slate-400 shrink-0 pl-1">
        Insights IA
      </div>
      <div className="relative flex-1 overflow-hidden h-10">
        {items.map((it, i) => (
          <div
            key={i}
            className={clsx(
              "absolute inset-0 flex items-center gap-2 transition-opacity duration-700",
              i === active ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
          >
            <span className="text-xl">{it.icon}</span>
            <span
              className={clsx(
                "text-sm",
                it.severity === "warning" && "text-amber-300",
                it.severity === "success" && "text-emerald-300",
                it.severity === "info" && "text-slate-200"
              )}
            >
              {it.text}
            </span>
          </div>
        ))}
      </div>
      <div className="flex gap-1 shrink-0 pr-1">
        {items.map((_, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            className={clsx(
              "h-1.5 w-5 rounded-full transition",
              i === active ? "bg-brand-400" : "bg-slate-700"
            )}
            aria-label={`Insight ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
}
