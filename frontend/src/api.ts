const BASE =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";

export type FilterParams = {
  date_from?: string | null;
  date_to?: string | null;
  exit_mode?: string | null;
  hour_from?: number | null;
  hour_to?: number | null;
};

function qs(params?: FilterParams, extra?: Record<string, string | number>): string {
  const usp = new URLSearchParams();
  if (params) {
    if (params.date_from) usp.set("date_from", params.date_from);
    if (params.date_to) usp.set("date_to", params.date_to);
    if (params.exit_mode) usp.set("exit_mode", params.exit_mode);
    if (params.hour_from != null) usp.set("hour_from", String(params.hour_from));
    if (params.hour_to != null) usp.set("hour_to", String(params.hour_to));
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

export type Kpis = {
  total_dossiers: number;
  total_patients: number;
  los_median_min: number | null;
  los_p90_min: number | null;
  hospit_pct: number | null;
  period_start: string;
  period_end: string;
  total_events: number;
};

export type Heatmap = { days: string[]; matrix: number[][]; max: number };
export type ExitMode = { mode: string; count: number };
export type Variant = { sequence: string[]; count: number; pct: number };
export type GraphNode = {
  id: string;
  label: string;
  count: number;
  avg_duration_min: number | null;
};
export type GraphEdge = {
  source: string;
  target: string;
  count: number;
  avg_wait_min: number | null;
};
export type ProcessGraph = { nodes: GraphNode[]; edges: GraphEdge[] };
export type Bottleneck = {
  location: string;
  count: number;
  mean_min: number | null;
  median_min: number | null;
  p90_min: number | null;
};
export type Sankey = {
  labels: string[];
  source: number[];
  target: number[];
  value: number[];
  layer: number[];
};
export type SimResult = {
  avg_los_min: number;
  p90_los_min: number;
  avg_wait_min: number;
  throughput: number;
};
export type SimResponse = {
  baseline: SimResult;
  scenario: SimResult;
  config: {
    routing: string[];
    bottleneck: string;
    baseline_capacity: Record<string, number>;
    scenario_capacity: Record<string, number>;
    duration_min: number;
  };
};

export type ScenarioInput = {
  name: string;
  extra_boxes: number;
  arrival_multiplier: number;
  ioa_speedup: number;
  duration_days: number;
};

export type MCStats = { mean: number; p05: number; p95: number };
export type MCReplStats = { los: MCStats; los_p90: MCStats; wait: MCStats; throughput: MCStats };
export type MCResponse = {
  baseline_mc: MCReplStats;
  scenarios_mc: {
    name: string;
    stats: MCReplStats;
    capacity: Record<string, number>;
    extra_boxes: number;
    arrival_multiplier: number;
    ioa_speedup: number;
    duration_days: number;
  }[];
  n_runs: number;
  config: { routing: string[]; bottleneck: string; baseline_capacity: Record<string, number> };
};

export type PredictInput = {
  hour: number;
  day_of_week: number;
  first_location: string;
  exit_mode: string;
  month: number;
};
export type PredictResponse = {
  predicted_los_min: number;
  p10: number;
  p90: number;
};
export type PredictOptions = { first_locations: string[]; exit_modes: string[] };

export type AnomalyItem = {
  dossier_id: string;
  los_min: number;
  variant: string;
  reason: string;
};
export type AnomaliesResponse = { total: number; pct: number; items: AnomalyItem[] };

export type Conformance = {
  conformance_rate: number;
  total: number;
  conformant: number;
  deviations: { type: string; count: number }[];
};

export type ClusterItem = {
  cluster_id: number;
  size: number;
  avg_los_min: number;
  top_locations: string[];
  top_exit_mode: string;
  label: string;
};

export type Readmissions = {
  readmission_7d_rate: number;
  readmission_30d_rate: number;
  top_patients: { patient_id: string; count: number }[];
};

export type Insight = { icon: string; text: string; severity: "info" | "warning" | "success" };

export const api = {
  kpis: (f?: FilterParams) => get<Kpis>(`/api/kpis${qs(f)}`),
  heatmap: (f?: FilterParams) => get<Heatmap>(`/api/arrivals-heatmap${qs(f)}`),
  exitModes: (f?: FilterParams) => get<ExitMode[]>(`/api/exit-modes${qs(f)}`),
  variants: (limit = 10, f?: FilterParams) =>
    get<Variant[]>(`/api/top-variants${qs(f, { limit })}`),
  graph: (f?: FilterParams) => get<ProcessGraph>(`/api/process-graph${qs(f)}`),
  bottlenecks: (f?: FilterParams) => get<Bottleneck[]>(`/api/bottlenecks${qs(f)}`),
  sankey: (f?: FilterParams) => get<Sankey>(`/api/sankey${qs(f)}`),
  anomalies: (f?: FilterParams) => get<AnomaliesResponse>(`/api/anomalies${qs(f)}`),
  conformance: (f?: FilterParams) => get<Conformance>(`/api/conformance${qs(f)}`),
  clusters: (f?: FilterParams) => get<{ clusters: ClusterItem[] }>(`/api/clusters${qs(f)}`),
  readmissions: (f?: FilterParams) => get<Readmissions>(`/api/readmissions${qs(f)}`),
  insights: (f?: FilterParams) => get<Insight[]>(`/api/insights${qs(f)}`),
  predictOptions: () => get<PredictOptions>("/api/predict-options"),
  predict: (body: PredictInput) => post<PredictResponse>("/api/predict", body),
  simulate: (body: {
    extra_boxes: number;
    arrival_multiplier: number;
    ioa_speedup: number;
    duration_days: number;
  }) => post<SimResponse>("/api/simulate", body),
  simulateMC: (body: { scenarios: ScenarioInput[]; n_runs: number }) =>
    post<MCResponse>("/api/simulate", body),
  simulateTrace: (body: TraceInput) =>
    post<TraceResponse>("/api/simulate-trace", body),
  realTrace: (body: RealTraceInput) =>
    post<TraceResponse>("/api/real-trace", body),
  datasetRange: () => get<{ min: string; max: string }>("/api/dataset-range"),
  flexsimExportUrl: () => `${BASE}/api/flexsim-export`,
};

export type RealTraceInput = {
  date_from: string;
  date_to: string;
  exit_mode?: string | null;
  top_locations?: number;
};

export type TraceInput = {
  extra_boxes: number;
  arrival_multiplier: number;
  ioa_speedup: number;
  duration_hours: number;
};
export type TraceEvent = {
  t: number;
  patient_id: number;
  type: "arrive_queue" | "start_service" | "depart" | "exit";
  location?: string;
  exit_mode?: string;
};
export type TraceLocation = {
  id: string;
  name: string;
  capacity: number;
  x: number;
  y: number;
  group?: string;
  base_name?: string;
  is_extension?: boolean;
};
export type TraceLocationStats = {
  id: string;
  name: string;
  avg_queue_len: number;
  max_queue_len: number;
  avg_wait_min: number;
  p90_wait_min: number;
  max_wait_min: number;
  pct_time_saturated: number;
  served: number;
  still_waiting: number;
};
export type TraceResponse = {
  locations: TraceLocation[];
  events: TraceEvent[];
  duration_min: number;
  stats_per_location: TraceLocationStats[];
  timeseries: {
    t: number[];
    queue_total: number[];
    in_service_total: number[];
  };
  bottleneck_group?: string | null;
  extra_boxes?: number;
};
