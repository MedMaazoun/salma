import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type AssistantKind = "rupture" | "avant_apres" | "general";

export type AssistantContextValue = {
  kind: AssistantKind;
  globalContext: Record<string, unknown>;
  sectionContext: Record<string, unknown>;
  suggestions: string[];
  isOpen: boolean;
  setOpen: (v: boolean) => void;
  /** Set the always-on global snapshot (KPIs, goulots, etc.). Called from App. */
  setGlobalContext: (g: Record<string, unknown>) => void;
  /** Set the per-section overlay (rupture details, before/after, etc.). */
  setAssistant: (next: { kind: AssistantKind; context: Record<string, unknown>; suggestions?: string[] }) => void;
  clearAssistant: () => void;
};

const Ctx = createContext<AssistantContextValue | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [globalContext, setGlobalContext] = useState<Record<string, unknown>>({});
  const [isOpen, setOpen] = useState(false);
  const [section, setSection] = useState<{ kind: AssistantKind; context: Record<string, unknown>; suggestions: string[] }>({
    kind: "general",
    context: {},
    suggestions: [
      "Quels goulots prioriser cette semaine ?",
      "Faut-il ajuster la capacité UHCD ou SAUV ?",
      "Comment réduire le LOS p90 ?",
      "Quels créneaux horaires sont en tension ?",
      "Où concentrer les ressources humaines ?",
      "Quelles dérives qualité corriger en priorité ?",
      "Quel impact d'un box supplémentaire ?",
      "Synthèse opérationnelle de la période",
    ],
  });

  const value = useMemo<AssistantContextValue>(() => ({
    kind: section.kind,
    globalContext,
    sectionContext: section.context,
    suggestions: section.suggestions,
    isOpen,
    setOpen,
    setGlobalContext,
    setAssistant: (next) => setSection({
      kind: next.kind,
      context: next.context,
      suggestions: next.suggestions ?? [],
    }),
    clearAssistant: () => setSection({
      kind: "general",
      context: {},
      suggestions: [
        "Résume la situation du service",
        "Quels sont les principaux goulots ?",
        "Quelles actions prioriser cette semaine ?",
      ],
    }),
  }), [section, globalContext, isOpen]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAssistant must be used inside <AssistantProvider>");
  return v;
}
