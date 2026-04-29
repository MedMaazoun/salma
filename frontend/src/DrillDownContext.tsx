import { createContext, useContext, useState, useMemo, type ReactNode } from "react";

export type DrillDownTarget =
  | { kind: "location"; location: string }
  | { kind: "variant"; sequence: string[] };

type Ctx = {
  target: DrillDownTarget | null;
  open: (t: DrillDownTarget) => void;
  close: () => void;
};

const C = createContext<Ctx | null>(null);

export function DrillDownProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<DrillDownTarget | null>(null);
  const value = useMemo<Ctx>(() => ({
    target,
    open: setTarget,
    close: () => setTarget(null),
  }), [target]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useDrillDown(): Ctx {
  const v = useContext(C);
  if (!v) throw new Error("useDrillDown outside <DrillDownProvider>");
  return v;
}
