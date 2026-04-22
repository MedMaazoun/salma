import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import type { FilterParams } from "./api";

type Ctx = {
  filters: FilterParams;
  setFilters: (f: FilterParams) => void;
  reset: () => void;
};

const FiltersContext = createContext<Ctx | null>(null);

const EMPTY: FilterParams = {
  date_from: null,
  date_to: null,
  exit_mode: null,
  hour_from: null,
  hour_to: null,
};

export function FiltersProvider({ children }: { children: ReactNode }) {
  const [filters, setFilters] = useState<FilterParams>(EMPTY);
  const reset = useCallback(() => setFilters(EMPTY), []);
  return (
    <FiltersContext.Provider value={{ filters, setFilters, reset }}>
      {children}
    </FiltersContext.Provider>
  );
}

export function useFilters() {
  const c = useContext(FiltersContext);
  if (!c) throw new Error("useFilters outside FiltersProvider");
  return c;
}
