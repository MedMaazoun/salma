import { useEffect, useMemo, useRef, useState } from "react";
import { Search, ArrowRight, Command as CmdIcon, Sparkles, FileDown, Download, Presentation, MonitorDot, GitBranch, Box, TrendingUp, Filter, X } from "lucide-react";
import clsx from "clsx";

export type Command = {
  id: string;
  label: string;
  hint?: string;
  group: "Navigation" | "Sous-section" | "Filtres" | "Actions" | "Assistant";
  icon?: React.ReactNode;
  keywords?: string;
  run: () => void;
};

export type PaletteApi = {
  setTab: (id: "monitoring" | "replay" | "twin" | "prospectif") => void;
  setReplaySub: (id: string) => void;
  setProspectifSub: (id: string) => void;
  setPresentation: (v: boolean) => void;
  exportPdf: () => void;
  flexsimUrl: () => string;
  setDatePreset: (preset: "today" | "week" | "month" | "all") => void;
  clearFilters: () => void;
  openAssistant: () => void;
};

function score(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return 100 - t.indexOf(q);
  let qi = 0;
  for (const ch of t) {
    if (ch === q[qi]) qi++;
    if (qi === q.length) return 50;
  }
  return 0;
}

export function CommandPalette({ api }: { api: PaletteApi }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Global keyboard shortcut
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const commands: Command[] = useMemo(() => [
    // Navigation
    { id: "nav-monitoring", group: "Navigation", label: "Aller à Monitoring", icon: <MonitorDot size={14} />, keywords: "tableau live", run: () => api.setTab("monitoring") },
    { id: "nav-replay",     group: "Navigation", label: "Aller à Replay & Processus", icon: <GitBranch size={14} />, keywords: "process map sankey variantes", run: () => api.setTab("replay") },
    { id: "nav-twin",       group: "Navigation", label: "Aller au Jumeau Numérique 3D", icon: <Box size={14} />, keywords: "twin 3d", run: () => api.setTab("twin") },
    { id: "nav-prospectif", group: "Navigation", label: "Aller à Prospectif & IA", icon: <TrendingUp size={14} />, keywords: "ia simulation prediction", run: () => api.setTab("prospectif") },

    // Sous-sections
    { id: "sub-replay-carte",    group: "Sous-section", label: "Replay · Carte du flux",    icon: <ArrowRight size={14} />, run: () => { api.setTab("replay"); api.setReplaySub("carte"); } },
    { id: "sub-replay-sankey",   group: "Sous-section", label: "Replay · Sankey",            icon: <ArrowRight size={14} />, run: () => { api.setTab("replay"); api.setReplaySub("sankey"); } },
    { id: "sub-replay-variantes",group: "Sous-section", label: "Replay · Variantes",         icon: <ArrowRight size={14} />, run: () => { api.setTab("replay"); api.setReplaySub("variantes"); } },
    { id: "sub-replay-parcours", group: "Sous-section", label: "Replay · Parcours patients", icon: <ArrowRight size={14} />, run: () => { api.setTab("replay"); api.setReplaySub("parcours"); } },
    { id: "sub-pros-ruptures",   group: "Sous-section", label: "Prospectif · Détection de rupture", icon: <ArrowRight size={14} />, run: () => { api.setTab("prospectif"); api.setProspectifSub("ruptures"); } },
    { id: "sub-pros-avant",      group: "Sous-section", label: "Prospectif · Test avant / après",   icon: <ArrowRight size={14} />, run: () => { api.setTab("prospectif"); api.setProspectifSub("avant_apres"); } },

    // Filtres
    { id: "flt-today",    group: "Filtres", label: "Filtre · aujourd'hui",        icon: <Filter size={14} />, run: () => api.setDatePreset("today") },
    { id: "flt-week",     group: "Filtres", label: "Filtre · 7 derniers jours",   icon: <Filter size={14} />, run: () => api.setDatePreset("week") },
    { id: "flt-month",    group: "Filtres", label: "Filtre · 30 derniers jours",  icon: <Filter size={14} />, run: () => api.setDatePreset("month") },
    { id: "flt-all",      group: "Filtres", label: "Filtre · toute la période",   icon: <Filter size={14} />, run: () => api.setDatePreset("all") },
    { id: "flt-clear",    group: "Filtres", label: "Effacer les filtres",         icon: <X size={14} />, run: () => api.clearFilters() },

    // Actions
    { id: "act-pdf",      group: "Actions", label: "Exporter en PDF",             icon: <FileDown size={14} />, run: () => api.exportPdf() },
    { id: "act-flex",     group: "Actions", label: "Exporter vers FlexSim",       icon: <Download size={14} />, run: () => { window.location.href = api.flexsimUrl(); } },
    { id: "act-pres-on",  group: "Actions", label: "Activer le mode Présentation", icon: <Presentation size={14} />, run: () => api.setPresentation(true) },
    { id: "act-pres-off", group: "Actions", label: "Quitter le mode Présentation", icon: <Presentation size={14} />, run: () => api.setPresentation(false) },

    // Assistant
    { id: "asst-open",    group: "Assistant", label: "Ouvrir l'assistant IA", icon: <Sparkles size={14} />, hint: "→ chat", run: () => api.openAssistant() },
  ], [api]);

  const filtered = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: Math.max(score(query, c.label), score(query, c.keywords ?? "")) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s);
    return scored.map(({ c }) => c);
  }, [commands, query]);

  // Group display
  const grouped = useMemo(() => {
    const g: Record<string, Command[]> = {};
    for (const c of filtered) (g[c.group] ||= []).push(c);
    return g;
  }, [filtered]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered, active]);

  function exec(idx: number) {
    const cmd = filtered[idx];
    if (!cmd) return;
    cmd.run();
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(filtered.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); exec(active); }
  }

  // Scroll active into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  let runningIdx = -1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 animate-fade-in"
      onClick={() => setOpen(false)}>
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-md" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-xl rounded-2xl border border-slate-800/80 bg-slate-950/90 backdrop-blur-2xl shadow-[0_0_0_1px_rgba(34,211,238,0.10),0_50px_120px_-20px_rgba(2,6,23,0.95)] overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800/70">
          <Search size={16} className="text-slate-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder="Rechercher une commande…"
            className="flex-1 bg-transparent text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none"
          />
          <kbd className="text-[10px] font-mono text-slate-500 border border-slate-800 rounded px-1.5 py-0.5">Esc</kbd>
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-500">Aucune commande.</div>
          ) : (
            Object.entries(grouped).map(([group, items]) => (
              <div key={group} className="px-2 py-1.5">
                <div className="px-2 py-1 text-[9px] uppercase tracking-[0.22em] text-slate-600">{group}</div>
                {items.map((cmd) => {
                  runningIdx++;
                  const idx = runningIdx;
                  const isActive = idx === active;
                  return (
                    <button
                      key={cmd.id}
                      data-idx={idx}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => exec(idx)}
                      className={clsx(
                        "w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-sm text-left transition",
                        isActive ? "bg-gradient-to-r from-brand-500/15 to-sky-500/10 text-slate-50" : "text-slate-300 hover:bg-slate-800/40"
                      )}
                    >
                      <span className={clsx("flex-shrink-0", isActive ? "text-brand-300" : "text-slate-500")}>
                        {cmd.icon ?? <CmdIcon size={14} />}
                      </span>
                      <span className="flex-1 truncate">{cmd.label}</span>
                      {cmd.hint && <span className="text-[10px] text-slate-500">{cmd.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-slate-800/70 text-[10px] text-slate-600">
          <div className="flex items-center gap-3">
            <span><kbd className="font-mono">↑↓</kbd> naviguer</span>
            <span><kbd className="font-mono">↵</kbd> exécuter</span>
          </div>
          <span><kbd className="font-mono">⌘K</kbd> ouvrir/fermer</span>
        </div>
      </div>
    </div>
  );
}
