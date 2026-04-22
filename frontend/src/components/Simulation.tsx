import { useState } from "react";
import { api, type MCResponse, type ScenarioInput } from "../api";
import { Play, Loader2, Plus, Trash2 } from "lucide-react";
import { DigitalTwin3D } from "./DigitalTwin3D";

const COLORS = ["#22d3ee", "#818cf8", "#f472b6"];

function emptyScenario(i: number): ScenarioInput {
  return {
    name: `Scénario ${i + 1}`,
    extra_boxes: i + 1,
    arrival_multiplier: 1.0,
    ioa_speedup: 0.2,
    duration_days: 3,
  };
}

function ScenarioCard({
  s,
  color,
  onChange,
  onRemove,
}: {
  s: ScenarioInput;
  color: string;
  onChange: (s: ScenarioInput) => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="card p-4 space-y-3"
      style={{ borderColor: `${color}55` }}
    >
      <div className="flex items-center justify-between gap-2">
        <input
          value={s.name}
          onChange={(e) => onChange({ ...s, name: e.target.value })}
          className="bg-transparent border-b border-slate-700 text-sm font-semibold text-slate-100 flex-1 focus:outline-none focus:border-brand-400"
        />
        <button
          onClick={onRemove}
          className="text-slate-500 hover:text-rose-400"
          aria-label="Supprimer"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="text-xs text-slate-400">
        <div className="flex justify-between">
          <span>Box supplémentaires</span>
          <span className="text-brand-300">+{s.extra_boxes}</span>
        </div>
        <input
          type="range" min={0} max={5} step={1}
          value={s.extra_boxes}
          onChange={(e) => onChange({ ...s, extra_boxes: Number(e.target.value) })}
          className="w-full accent-brand-400"
        />
      </div>

      <div className="text-xs text-slate-400">
        <div className="flex justify-between">
          <span>Multiplicateur arrivées</span>
          <span className="text-brand-300">{s.arrival_multiplier.toFixed(1)}×</span>
        </div>
        <input
          type="range" min={0.5} max={2} step={0.1}
          value={s.arrival_multiplier}
          onChange={(e) => onChange({ ...s, arrival_multiplier: Number(e.target.value) })}
          className="w-full accent-brand-400"
        />
      </div>

      <div className="text-xs text-slate-400">
        <div className="flex justify-between">
          <span>Accélération IOA</span>
          <span className="text-brand-300">{Math.round(s.ioa_speedup * 100)}%</span>
        </div>
        <input
          type="range" min={0} max={0.5} step={0.05}
          value={s.ioa_speedup}
          onChange={(e) => onChange({ ...s, ioa_speedup: Number(e.target.value) })}
          className="w-full accent-brand-400"
        />
      </div>

      <div className="text-xs text-slate-400">
        <div className="flex justify-between">
          <span>Durée</span>
          <span className="text-brand-300">{s.duration_days} j</span>
        </div>
        <input
          type="range" min={1} max={14} step={1}
          value={s.duration_days}
          onChange={(e) => onChange({ ...s, duration_days: Number(e.target.value) })}
          className="w-full accent-brand-400"
        />
      </div>
    </div>
  );
}

function ComparisonChart({ result }: { result: MCResponse }) {
  // bars = p90 LOS with error bars (p05-p95 from MC)
  const series: { name: string; val: number; lo: number; hi: number; color: string }[] = [
    {
      name: "Baseline",
      val: result.baseline_mc.los_p90.mean,
      lo: result.baseline_mc.los_p90.p05,
      hi: result.baseline_mc.los_p90.p95,
      color: "#64748b",
    },
    ...result.scenarios_mc.map((s, i) => ({
      name: s.name,
      val: s.stats.los_p90.mean,
      lo: s.stats.los_p90.p05,
      hi: s.stats.los_p90.p95,
      color: COLORS[i % COLORS.length],
    })),
  ];
  const max = Math.max(...series.map((s) => s.hi), 1);
  const W = 640;
  const H = 260;
  const PAD = 40;
  const bw = (W - PAD * 2) / series.length - 16;

  return (
    <svg width={W} height={H} className="block">
      {[0, 0.25, 0.5, 0.75, 1].map((f, i) => {
        const y = PAD + (H - PAD * 2) * (1 - f);
        return (
          <g key={i}>
            <line x1={PAD} x2={W - PAD} y1={y} y2={y} stroke="#1e293b" strokeDasharray="2,4" />
            <text x={PAD - 6} y={y + 3} fontSize={10} fill="#64748b" textAnchor="end">
              {Math.round(max * f)}
            </text>
          </g>
        );
      })}
      {series.map((s, i) => {
        const x = PAD + i * ((W - PAD * 2) / series.length) + 8;
        const y = PAD + (H - PAD * 2) * (1 - s.val / max);
        const yLo = PAD + (H - PAD * 2) * (1 - s.lo / max);
        const yHi = PAD + (H - PAD * 2) * (1 - s.hi / max);
        return (
          <g key={s.name}>
            <rect
              x={x}
              y={y}
              width={bw}
              height={H - PAD - y}
              fill={s.color}
              opacity={0.7}
              rx={4}
            />
            {/* error bar */}
            <line x1={x + bw / 2} x2={x + bw / 2} y1={yHi} y2={yLo} stroke="#e2e8f0" strokeWidth={2} />
            <line x1={x + bw / 2 - 5} x2={x + bw / 2 + 5} y1={yHi} y2={yHi} stroke="#e2e8f0" strokeWidth={2} />
            <line x1={x + bw / 2 - 5} x2={x + bw / 2 + 5} y1={yLo} y2={yLo} stroke="#e2e8f0" strokeWidth={2} />
            <text x={x + bw / 2} y={H - 14} textAnchor="middle" fontSize={11} fill="#cbd5e1">
              {s.name.length > 12 ? s.name.slice(0, 11) + "…" : s.name}
            </text>
            <text x={x + bw / 2} y={y - 6} textAnchor="middle" fontSize={11} fill={s.color} fontWeight={600}>
              {s.val.toFixed(0)}
            </text>
          </g>
        );
      })}
      <text x={PAD} y={20} fontSize={12} fill="#94a3b8">
        LOS p90 (min) — barres d'erreur: p05 / p95 sur {result.n_runs} réplications
      </text>
    </svg>
  );
}

export function Simulation() {
  const [mode, setMode] = useState<"mc" | "twin">("mc");
  const [scenarios, setScenarios] = useState<ScenarioInput[]>([
    emptyScenario(0),
    { ...emptyScenario(1), extra_boxes: 3, ioa_speedup: 0.3 },
  ]);
  const [nRuns, setNRuns] = useState(10);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<MCResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.simulateMC({ scenarios, n_runs: nRuns });
      setResult(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  function update(i: number, s: ScenarioInput) {
    const copy = [...scenarios];
    copy[i] = s;
    setScenarios(copy);
  }

  function add() {
    if (scenarios.length >= 3) return;
    setScenarios([...scenarios, emptyScenario(scenarios.length)]);
  }

  function remove(i: number) {
    setScenarios(scenarios.filter((_, j) => j !== i));
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setMode("mc")}
          className={`px-3 py-1.5 rounded-lg text-sm border transition ${
            mode === "mc"
              ? "bg-brand-500/20 border-brand-400 text-brand-300"
              : "border-slate-700 text-slate-400 hover:bg-slate-800/60"
          }`}
        >
          📊 Monte Carlo
        </button>
        <button
          onClick={() => setMode("twin")}
          className={`px-3 py-1.5 rounded-lg text-sm border transition ${
            mode === "twin"
              ? "bg-brand-500/20 border-brand-400 text-brand-300"
              : "border-slate-700 text-slate-400 hover:bg-slate-800/60"
          }`}
        >
          🏥 Jumeau Numérique 3D
        </button>
      </div>

      {mode === "twin" ? (
        <DigitalTwin3D />
      ) : (
        <MonteCarloView
          scenarios={scenarios}
          nRuns={nRuns}
          loading={loading}
          result={result}
          err={err}
          setNRuns={setNRuns}
          add={add}
          run={run}
          update={update}
          remove={remove}
        />
      )}
    </div>
  );
}

function MonteCarloView({
  scenarios,
  nRuns,
  loading,
  result,
  err,
  setNRuns,
  add,
  run,
  update,
  remove,
}: {
  scenarios: ScenarioInput[];
  nRuns: number;
  loading: boolean;
  result: MCResponse | null;
  err: string | null;
  setNRuns: (n: number) => void;
  add: () => void;
  run: () => void;
  update: (i: number, s: ScenarioInput) => void;
  remove: (i: number) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="card p-4 flex flex-wrap items-center gap-4">
        <div>
          <label className="text-xs uppercase text-slate-400">Réplications Monte Carlo</label>
          <input
            type="number"
            min={1}
            max={30}
            value={nRuns}
            onChange={(e) => setNRuns(Number(e.target.value))}
            className="ml-2 bg-slate-900/70 border border-slate-700/70 rounded-lg px-2 py-1 text-sm text-slate-200 w-20"
          />
        </div>
        <button
          onClick={add}
          disabled={scenarios.length >= 3}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-slate-300 border border-slate-700/70 hover:bg-slate-800/60 transition disabled:opacity-40"
        >
          <Plus size={14} /> Ajouter un scénario
        </button>
        <div className="flex-1" />
        <button
          onClick={run}
          disabled={loading || scenarios.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-sky-500 hover:from-brand-400 hover:to-sky-400 text-slate-950 font-semibold px-4 py-2 transition disabled:opacity-60"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
          {loading ? "Simulation…" : "Run Monte Carlo"}
        </button>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {scenarios.map((s, i) => (
          <ScenarioCard
            key={i}
            s={s}
            color={COLORS[i % COLORS.length]}
            onChange={(ns) => update(i, ns)}
            onRemove={() => remove(i)}
          />
        ))}
      </div>

      {err && <div className="card p-3 text-rose-300 text-sm">Erreur : {err}</div>}

      {result && (
        <div className="card p-5 space-y-4">
          <h3 className="text-base font-semibold text-slate-100">
            Comparaison LOS p90
          </h3>
          <div className="overflow-x-auto">
            <ComparisonChart result={result} />
          </div>

          <div className="grid md:grid-cols-4 gap-3 text-sm">
            <div className="card p-3">
              <div className="text-xs uppercase text-slate-500">Baseline · LOS moyen</div>
              <div className="text-xl font-semibold text-slate-200">
                {result.baseline_mc.los.mean.toFixed(1)} min
              </div>
              <div className="text-[10px] text-slate-500">
                p05 {result.baseline_mc.los.p05.toFixed(1)} — p95 {result.baseline_mc.los.p95.toFixed(1)}
              </div>
            </div>
            {result.scenarios_mc.map((s, i) => (
              <div key={s.name} className="card p-3" style={{ borderColor: `${COLORS[i % COLORS.length]}55` }}>
                <div className="text-xs uppercase text-slate-500">{s.name}</div>
                <div className="text-xl font-semibold" style={{ color: COLORS[i % COLORS.length] }}>
                  {s.stats.los.mean.toFixed(1)} min
                </div>
                <div className="text-[10px] text-slate-500">
                  p05 {s.stats.los.p05.toFixed(1)} — p95 {s.stats.los.p95.toFixed(1)}
                </div>
                <div className="text-[10px] text-slate-500 mt-1">
                  Débit: {s.stats.throughput.mean.toFixed(0)}
                </div>
              </div>
            ))}
          </div>

          <div className="text-xs text-slate-500">
            Goulot ciblé: <span className="text-brand-300">{result.config.bottleneck}</span> ·
            Parcours: {result.config.routing.join(" → ")}
          </div>
        </div>
      )}
    </div>
  );
}
