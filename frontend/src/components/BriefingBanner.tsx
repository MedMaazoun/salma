import { useEffect, useRef, useState } from "react";
import { Sparkles, RefreshCw, Loader2, ChevronDown, ChevronUp, Wand2, X } from "lucide-react";
import { api } from "../api";
import { useAssistant } from "../AssistantContext";

const TTL_MS = 60 * 60 * 1000; // 1h cache

function hashCtx(obj: unknown): string {
  return JSON.stringify(obj).slice(0, 80);
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

type Cached = { content: string; ts: number; key: string };

const STORAGE_KEY = "ed-briefing-cache";

function loadCached(): Cached | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Cached;
  } catch { return null; }
}

function saveCached(c: Cached) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
}

export function BriefingBanner({ onClose }: { onClose?: () => void }) {
  const { globalContext } = useAssistant();
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const triggeredRef = useRef<string>("");

  async function generate() {
    if (loading) return;
    const key = hashCtx(globalContext);
    if (!key || Object.keys(globalContext).length === 0) return;

    setLoading(true);
    setError(null);
    setContent("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    let acc = "";
    try {
      await api.explainStream(
        {
          kind: "briefing",
          context: { service: globalContext },
          question: "Rédige le briefing matinal selon le format imposé.",
        },
        (token) => { acc += token; setContent(acc); },
        (msg) => setError(msg),
        ctrl.signal,
      );
      const now = Date.now();
      setGeneratedAt(now);
      saveCached({ content: acc, ts: now, key });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  // On mount / context change : restore from cache only — never auto-generate
  useEffect(() => {
    const key = hashCtx(globalContext);
    if (!key || Object.keys(globalContext).length === 0) return;
    if (triggeredRef.current === key) return;
    triggeredRef.current = key;

    const cached = loadCached();
    if (cached && cached.key === key && Date.now() - cached.ts < TTL_MS) {
      setContent(cached.content);
      setGeneratedAt(cached.ts);
    }
    return () => { abortRef.current?.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalContext]);

  const ctxReady = Object.keys(globalContext).length > 0;
  const hasContent = !!content;

  return (
    <section className="relative overflow-hidden rounded-2xl border border-brand-500/25 bg-gradient-to-br from-slate-900/70 via-slate-950/60 to-brand-500/5 backdrop-blur-md animate-slide-up">
      <span className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-brand-400/60 to-transparent" />
      <span className="pointer-events-none absolute -inset-1 bg-[radial-gradient(800px_circle_at_10%_-30%,rgba(34,211,238,0.10),transparent_60%)]" />

      <div className="relative px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="relative flex-shrink-0 mt-0.5">
            <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-500 to-sky-500 blur-md opacity-50" />
            <div className="relative h-9 w-9 rounded-lg bg-gradient-to-br from-brand-400 via-brand-500 to-sky-500 flex items-center justify-center ring-1 ring-white/10">
              <Sparkles size={16} className="text-slate-950" />
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div>
                <div className="text-[10px] uppercase tracking-[0.22em] text-brand-300/90">Briefing IA</div>
                <h3 className="text-sm font-semibold tracking-tight text-slate-50">Synthèse opérationnelle du jour</h3>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {generatedAt && !loading && hasContent && (
                  <span className="text-[10px] text-slate-500">{timeAgo(generatedAt)}</span>
                )}
                {!hasContent && !loading ? (
                  <button onClick={generate} disabled={!ctxReady}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-950 bg-gradient-to-r from-brand-400 to-sky-400 hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_0_1px_rgba(34,211,238,0.20),0_8px_24px_-10px_rgba(34,211,238,0.5)]"
                    title={ctxReady ? "Générer le briefing avec l'IA locale" : "Données en cours de chargement…"}>
                    <Wand2 size={13} />
                    Générer le briefing
                  </button>
                ) : (
                  <button onClick={generate} disabled={loading}
                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 transition disabled:opacity-50"
                    title="Régénérer">
                    {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  </button>
                )}
                {hasContent && (
                  <button onClick={() => setCollapsed((v) => !v)}
                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 transition"
                    title={collapsed ? "Déplier" : "Replier"}>
                    {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                  </button>
                )}
                {onClose && (
                  <button onClick={onClose}
                    className="inline-flex items-center justify-center h-7 w-7 rounded-md text-slate-500 hover:text-rose-300 hover:bg-rose-500/10 transition"
                    title="Désactiver le briefing">
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>

            {!collapsed && (
              <div className="mt-1">
                {error && (
                  <div className="text-xs text-rose-300">{error}</div>
                )}
                {!error && hasContent && (
                  <div className="text-sm leading-relaxed text-slate-200 whitespace-pre-wrap">
                    {content}
                  </div>
                )}
                {!error && !hasContent && loading && (
                  <div className="text-xs text-slate-500 italic">Génération en cours…</div>
                )}
                {!error && !hasContent && !loading && (
                  <div className="text-xs text-slate-500">
                    Cliquez sur <span className="text-brand-300 font-medium">Générer le briefing</span> pour produire la synthèse opérationnelle du jour à partir des données affichées.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
