import { useEffect, useRef, useState } from "react";
import { Sparkles, X, Send, Loader2, Bot, User, AlertCircle, Cpu } from "lucide-react";
import clsx from "clsx";
import { api } from "../api";
import { useAssistant } from "../AssistantContext";

type Message = { role: "user" | "assistant"; content: string };

export function Assistant() {
  const { kind, globalContext, sectionContext, suggestions, isOpen: open, setOpen } = useAssistant();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [llmReady, setLlmReady] = useState<null | boolean>(null);
  const [llmModel, setLlmModel] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    api.llmStatus()
      .then((s) => { setLlmReady(!!s.ok && !!s.model_available); setLlmModel(s.model ?? ""); })
      .catch(() => setLlmReady(false));
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streaming]);

  async function send(question: string) {
    if (!question.trim() || streaming) return;
    setError(null);
    const userMsg: Message = { role: "user", content: question };
    const baseMessages = [...messages, userMsg];
    setMessages([...baseMessages, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await api.explainStream(
        {
          kind,
          context: { service: globalContext, focus: sectionContext },
          question,
          history: messages.slice(-8),
        },
        (token) => {
          setMessages((cur) => {
            const copy = cur.slice();
            const last = copy[copy.length - 1];
            if (last && last.role === "assistant") {
              copy[copy.length - 1] = { role: "assistant", content: last.content + token };
            }
            return copy;
          });
        },
        (msg) => setError(msg),
        ctrl.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  function reset() {
    stop();
    setMessages([]);
    setError(null);
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "fixed bottom-6 right-6 z-30 inline-flex items-center gap-2 px-4 py-3 rounded-full text-sm font-semibold transition-all",
          "bg-gradient-to-r from-brand-500 to-sky-500 text-slate-950",
          "shadow-[0_0_0_1px_rgba(34,211,238,0.25),0_24px_60px_-12px_rgba(34,211,238,0.55)]",
          "hover:scale-[1.03] active:scale-[0.97]",
          open && "rotate-90"
        )}
        aria-label="Assistant IA"
      >
        {open ? <X size={18} /> : <Sparkles size={16} />}
        {!open && <span>Assistant</span>}
      </button>

      {/* Panel */}
      <div
        className={clsx(
          "fixed bottom-24 right-6 z-30 w-[min(420px,calc(100vw-3rem))] h-[min(620px,calc(100vh-8rem))]",
          "rounded-2xl border border-slate-800/80 bg-slate-950/85 backdrop-blur-2xl",
          "shadow-[0_0_0_1px_rgba(34,211,238,0.10),0_40px_120px_-20px_rgba(2,6,23,0.9)]",
          "transition-all duration-300 origin-bottom-right",
          open ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"
        )}
      >
        <div className="flex flex-col h-full">

          {/* Header */}
          <div className="relative px-4 py-3 border-b border-slate-800/70">
            <span className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-brand-500/40 to-transparent" />
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-brand-500 to-sky-500 blur-md opacity-50" />
                <div className="relative h-9 w-9 rounded-lg bg-gradient-to-br from-brand-400 via-brand-500 to-sky-500 flex items-center justify-center ring-1 ring-white/10">
                  <Bot size={16} className="text-slate-950" />
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-50">Assistant analytique</div>
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                  <Cpu size={10} />
                  {llmReady === null ? "vérification…"
                    : llmReady ? `local · ${llmModel || "ollama"}`
                    : "Ollama indisponible"}
                </div>
              </div>
              {messages.length > 0 && (
                <button onClick={reset} className="text-[10px] text-slate-500 hover:text-slate-200 transition">
                  Reset
                </button>
              )}
            </div>
            <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wider bg-slate-900/70 border border-slate-800/80 text-brand-200/80">
              contexte · {kind === "rupture" ? "Détection de rupture" : kind === "avant_apres" ? "Avant / Après" : "Général"}
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
            {messages.length === 0 && (
              <div className="text-xs text-slate-500 leading-relaxed">
                Pose une question sur la vue actuelle. L'assistant utilise les données déjà calculées par le tableau de bord — aucune donnée patient n'est envoyée à un service externe.
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={clsx("flex gap-2.5", m.role === "user" && "flex-row-reverse")}>
                <div className={clsx(
                  "h-7 w-7 rounded-lg flex items-center justify-center flex-shrink-0 ring-1 ring-white/10",
                  m.role === "assistant" ? "bg-gradient-to-br from-brand-500 to-sky-500 text-slate-950" : "bg-slate-800 text-slate-300"
                )}>
                  {m.role === "assistant" ? <Bot size={13} /> : <User size={13} />}
                </div>
                <div className={clsx(
                  "rounded-xl px-3 py-2 text-sm leading-relaxed max-w-[85%] whitespace-pre-wrap",
                  m.role === "assistant"
                    ? "bg-slate-900/70 border border-slate-800/70 text-slate-200"
                    : "bg-gradient-to-br from-brand-500/15 to-sky-500/10 border border-brand-500/25 text-slate-100"
                )}>
                  {m.content || (streaming && i === messages.length - 1 ? <Loader2 size={14} className="animate-spin text-brand-400" /> : "")}
                </div>
              </div>
            ))}
            {error && (
              <div className="flex items-start gap-2 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg p-3">
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* Suggestions */}
          {messages.length === 0 && suggestions.length > 0 && (
            <div className="px-4 pb-3 flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-slate-800/80 bg-slate-900/60 text-slate-300 hover:border-brand-500/40 hover:text-brand-200 transition"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <form
            onSubmit={(e) => { e.preventDefault(); send(input); }}
            className="border-t border-slate-800/70 p-3 flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Pose ta question…"
              disabled={streaming}
              className="flex-1 bg-slate-900/70 border border-slate-800/80 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/30 transition"
            />
            {streaming ? (
              <button type="button" onClick={stop} className="px-3 py-2 rounded-lg text-sm text-rose-200 border border-rose-500/30 hover:bg-rose-500/10 transition">
                Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!input.trim() || llmReady === false}
                className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-gradient-to-br from-brand-500 to-sky-500 text-slate-950 disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
                aria-label="Envoyer"
              >
                <Send size={14} />
              </button>
            )}
          </form>
        </div>
      </div>
    </>
  );
}
