import { useState, useEffect } from "react";
import {
  Printer, RefreshCw, Clock, Users, Activity,
  AlertTriangle, CheckCircle, Info, TrendingUp,
} from "lucide-react";
import { api, type Kpis, type Bottleneck, type ExitMode, type Insight } from "../api";

// ─── Types ────────────────────────────────────────────────────────────────────

type Shift = "matin" | "apresmidi" | "nuit";

const SHIFTS: { id: Shift; label: string; hours: string; from: number; to: number | null }[] = [
  { id: "matin",     label: "Matin",      hours: "06h – 14h", from: 6,  to: 14 },
  { id: "apresmidi", label: "Après-midi", hours: "14h – 22h", from: 14, to: 22 },
  { id: "nuit",      label: "Nuit",       hours: "22h – 06h", from: 22, to: null }, // crosses midnight
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectShift(): Shift {
  const h = new Date().getHours();
  if (h >= 6  && h < 14) return "matin";
  if (h >= 14 && h < 22) return "apresmidi";
  return "nuit";
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function fmtMin(v: number | null) {
  if (v == null) return "—";
  if (v < 60) return `${Math.round(v)} min`;
  return `${Math.floor(v / 60)}h${String(Math.round(v % 60)).padStart(2, "0")}`;
}

function fmtPct(v: number | null) {
  return v == null ? "—" : `${v.toFixed(1)} %`;
}

const SEV_ICON: Record<string, React.ReactNode> = {
  warning: <AlertTriangle size={13} />,
  info:    <Info size={13} />,
  success: <CheckCircle size={13} />,
};
const SEV_COLOR: Record<string, string> = {
  warning: "#f59e0b",
  info:    "#22d3ee",
  success: "#34d399",
};

// ─── Print style (injected once on mount) ────────────────────────────────────

const PRINT_CSS = `
@media print {
  @page { margin: 1.5cm; }
  body { background: #fff !important; color: #111 !important; font-family: system-ui, sans-serif; }
  .no-print { display: none !important; }
  .sr-card {
    background: #fff !important;
    border: 1px solid #cbd5e1 !important;
    color: #111 !important;
    border-radius: 8px;
    page-break-inside: avoid;
  }
  .sr-label  { color: #475569 !important; }
  .sr-value  { color: #0f172a !important; }
  .sr-muted  { color: #94a3b8 !important; }
  .sr-bar-bg { background: #e2e8f0 !important; }
}
`;

// ─── SubComponents ────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, icon, color,
}: { label: string; value: string; sub: string; icon: React.ReactNode; color: string }) {
  return (
    <div className="card sr-card p-4 space-y-1.5">
      <div className="flex items-center gap-2">
        <span style={{ color }}>{icon}</span>
        <span className="text-xs text-slate-500 sr-label">{label}</span>
      </div>
      <div className="text-2xl font-bold text-slate-100 sr-value">{value}</div>
      <div className="text-[10px] text-slate-600 sr-muted">{sub}</div>
    </div>
  );
}

function BarRow({
  label, right, pct, color,
}: { label: string; right: string; pct: number; color: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-300 sr-value font-medium truncate max-w-[55%]">{label}</span>
        <span className="text-slate-500 sr-muted">{right}</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-800 sr-bar-bg">
        <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ShiftReport() {
  const [shift, setShift]         = useState<Shift>(detectShift());
  const [date, setDate]           = useState(todayStr());
  const [loading, setLoading]     = useState(false);
  const [kpis, setKpis]           = useState<Kpis | null>(null);
  const [bottlenecks, setBottlenecks] = useState<Bottleneck[]>([]);
  const [exits, setExits]         = useState<ExitMode[]>([]);
  const [alerts, setAlerts]       = useState<Insight[]>([]);
  const [genAt, setGenAt]         = useState("");

  // Inject print style once
  useEffect(() => {
    const el = document.createElement("style");
    el.id = "shift-report-print";
    el.textContent = PRINT_CSS;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  const shiftCfg = SHIFTS.find(s => s.id === shift)!;

  async function load() {
    setLoading(true);
    const f = {
      date_from: date,
      date_to:   date,
      hour_from: shiftCfg.from,
      ...(shiftCfg.to != null ? { hour_to: shiftCfg.to } : {}),
    };
    try {
      const [k, b, e, ins] = await Promise.all([
        api.kpis(f),
        api.bottlenecks(f),
        api.exitModes(f),
        api.insights(f),
      ]);
      setKpis(k);
      setBottlenecks(b.slice(0, 5));
      setExits(e.slice(0, 7));
      setAlerts(ins.filter(i => i.severity !== "success").slice(0, 5));
      setGenAt(new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [shift, date]); // eslint-disable-line react-hooks/exhaustive-deps

  const dateLabel = (() => {
    try {
      return new Date(date + "T12:00:00").toLocaleDateString("fr-FR", {
        weekday: "long", year: "numeric", month: "long", day: "numeric",
      });
    } catch { return date; }
  })();

  const totalExits = exits.reduce((s, e) => s + e.count, 0);
  const maxBottleneck = Math.max(...bottlenecks.map(b => b.mean_min ?? 0), 1);

  return (
    <div className="space-y-5">

      {/* ── Controls (hidden on print) ───────────────────────────────────── */}
      <div className="no-print flex flex-wrap items-end gap-3">
        {/* Shift selector */}
        <div>
          <div className="text-[10px] text-slate-500 mb-1.5 uppercase tracking-widest">Quart de travail</div>
          <div className="flex rounded-lg border border-slate-700/60 overflow-hidden">
            {SHIFTS.map((s, i) => (
              <button key={s.id} onClick={() => setShift(s.id)}
                className={`px-4 py-2 text-sm transition border-r border-slate-700/60 last:border-r-0 ${
                  shift === s.id
                    ? "bg-brand-500/20 text-brand-200"
                    : "text-slate-400 hover:bg-slate-800/50"
                }`}
                style={i === 0 ? {} : {}}
              >
                <div className="font-medium">{s.label}</div>
                <div className="text-[10px] text-slate-500">{s.hours}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Date */}
        <div>
          <div className="text-[10px] text-slate-500 mb-1.5 uppercase tracking-widest">Date</div>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="px-3 py-2 h-[56px] rounded-lg border border-slate-700/60 bg-slate-900 text-slate-200 text-sm" />
        </div>

        <button onClick={load} disabled={loading}
          className="h-[56px] inline-flex items-center gap-1.5 px-4 rounded-lg border border-slate-700/60 text-slate-300 text-sm hover:bg-slate-800/50 transition disabled:opacity-50 self-end">
          <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
          Actualiser
        </button>

        <div className="flex-1" />

        <button onClick={() => window.print()}
          className="h-[56px] inline-flex items-center gap-2 px-5 rounded-lg bg-brand-500/15 border border-brand-500/30 text-brand-200 text-sm font-medium hover:bg-brand-500/25 transition self-end">
          <Printer size={15} />
          Imprimer / Exporter PDF
        </button>
      </div>

      {/* ── Report body ──────────────────────────────────────────────────── */}

      {/* Header */}
      <div className="card sr-card p-5 flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 sr-label">
            Rapport de relève · Urgences pédiatriques
          </div>
          <h2 className="text-xl font-bold text-slate-100 sr-value mt-1 capitalize">{dateLabel}</h2>
          <div className="flex flex-wrap items-center gap-3 mt-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-500/10 border border-brand-500/20 text-brand-200 text-xs font-medium">
              <Clock size={11} />
              {shiftCfg.label} · {shiftCfg.hours}
            </span>
            {genAt && (
              <span className="text-xs text-slate-500 sr-muted">Généré à {genAt}</span>
            )}
            {loading && (
              <span className="text-xs text-slate-500 animate-pulse">Chargement…</span>
            )}
          </div>
        </div>
        <div className="text-right text-xs text-slate-500 sr-muted">
          <div className="text-slate-300 sr-value font-semibold">ED Flow Intelligence</div>
          <div>Service des Urgences</div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Patients du quart"
          value={loading ? "…" : String(kpis?.total_dossiers ?? "—")}
          sub="passages enregistrés"
          icon={<Users size={16} />}
          color="#22d3ee"
        />
        <KpiCard
          label="LOS médian"
          value={loading ? "…" : fmtMin(kpis?.los_median_min ?? null)}
          sub="durée de séjour médiane"
          icon={<Clock size={16} />}
          color="#a78bfa"
        />
        <KpiCard
          label="LOS P90"
          value={loading ? "…" : fmtMin(kpis?.los_p90_min ?? null)}
          sub="9 patients sur 10 sortis avant"
          icon={<Activity size={16} />}
          color="#f59e0b"
        />
        <KpiCard
          label="Hospitalisations"
          value={loading ? "…" : fmtPct(kpis?.hospit_pct ?? null)}
          sub="taux d'admission"
          icon={<TrendingUp size={16} />}
          color="#f43f5e"
        />
      </div>

      {/* Bottlenecks + Exits */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card sr-card p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 sr-value">Points de tension</h3>
            <p className="text-[10px] text-slate-500 sr-muted mt-0.5">Zones avec les durées moyennes les plus élevées sur ce quart</p>
          </div>
          {!loading && bottlenecks.length === 0 ? (
            <p className="text-xs text-slate-500">Aucun goulot significatif sur ce quart.</p>
          ) : (
            <div className="space-y-3">
              {bottlenecks.map((b, i) => (
                <BarRow
                  key={b.location}
                  label={b.location}
                  right={`${fmtMin(b.mean_min)} moy · ${fmtMin(b.p90_min)} P90`}
                  pct={((b.mean_min ?? 0) / maxBottleneck) * 100}
                  color={i === 0 ? "#f43f5e" : i === 1 ? "#f59e0b" : "#22d3ee"}
                />
              ))}
            </div>
          )}
        </div>

        <div className="card sr-card p-5 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100 sr-value">Répartition des sorties</h3>
            <p className="text-[10px] text-slate-500 sr-muted mt-0.5">
              {loading ? "…" : `${totalExits} sorties enregistrées`}
            </p>
          </div>
          {!loading && exits.length === 0 ? (
            <p className="text-xs text-slate-500">Aucune sortie enregistrée sur ce quart.</p>
          ) : (
            <div className="space-y-3">
              {exits.map(e => (
                <BarRow
                  key={e.mode}
                  label={e.mode}
                  right={`${e.count} · ${totalExits > 0 ? ((e.count / totalExits) * 100).toFixed(1) : 0} %`}
                  pct={totalExits > 0 ? (e.count / totalExits) * 100 : 0}
                  color="#818cf8"
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Alerts */}
      <div className="card sr-card p-5 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-100 sr-value">Signaux & alertes</h3>
          <p className="text-[10px] text-slate-500 sr-muted mt-0.5">Points d'attention à transmettre à l'équipe entrante</p>
        </div>
        {!loading && alerts.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-emerald-400">
            <CheckCircle size={13} />
            <span>Aucun signal anormal détecté sur cette plage horaire.</span>
          </div>
        ) : (
          <div className="space-y-2">
            {alerts.map((a, i) => (
              <div key={i} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-slate-800/50"
                style={{ borderLeft: `3px solid ${SEV_COLOR[a.severity]}` }}>
                <span style={{ color: SEV_COLOR[a.severity] }} className="mt-0.5 flex-shrink-0">
                  {SEV_ICON[a.severity]}
                </span>
                <span className="text-xs text-slate-300 sr-value">{a.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Handover signature block */}
      <div className="card sr-card p-5">
        <h3 className="text-sm font-semibold text-slate-100 sr-value mb-5">Transmission de consigne</h3>
        <div className="grid sm:grid-cols-3 gap-8">
          {[
            { label: "Responsable sortant",  hint: "Nom, matricule & signature" },
            { label: "Responsable entrant",  hint: "Nom, matricule & signature" },
            { label: "Observations de relève", hint: "Événements particuliers, patients à surveiller…" },
          ].map(f => (
            <div key={f.label} className="space-y-2">
              <div className="text-xs font-semibold text-slate-300 sr-value">{f.label}</div>
              <div className="h-16 border-b border-dashed border-slate-700" />
              <div className="text-[10px] text-slate-600 sr-muted">{f.hint}</div>
            </div>
          ))}
        </div>

        {/* Footer info */}
        <div className="mt-6 pt-4 border-t border-slate-800 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-600 sr-muted">
          <span>ED Flow Intelligence · Urgences pédiatriques</span>
          <span>{dateLabel} · Quart {shiftCfg.label} ({shiftCfg.hours})</span>
          {genAt && <span>Généré à {genAt}</span>}
        </div>
      </div>
    </div>
  );
}
