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

export type PeriodStats = { n: number; mean: number; median: number; p10: number; p25: number; p75: number; p90: number };
export type BeforeAfterResult = {
  before: PeriodStats; after: PeriodStats;
  p_value: number; u_stat: number; cohen_d: number; split_date: string;
  error?: string;
};
export type DecompResult = {
  dates: string[]; observed: number[];
  trend: (number|null)[]; seasonal: (number|null)[]; residual: (number|null)[];
};
export type KMPoint = { t: number; s: number; ci_lo: number; ci_hi: number };
export type KMResult = {
  overall: KMPoint[]; weekday: KMPoint[]; weekend: KMPoint[];
  n_total: number; n_weekday: number; n_weekend: number;
  median_overall: number; median_weekday: number; median_weekend: number;
};
export type FeatItem = { name: string; raw: string; importance: number; rank: number; category: "time"|"location"|"exit" };
export type FeatResult = { features: FeatItem[] };

export type ResearchCluster = {
  id: number; name: string; color: string;
  count: number; pct: number;
  avg_hour: number; avg_dow: number;
  avg_los: number; median_los: number; hosp_rate: number;
};
export type ResearchData = {
  clusters: ResearchCluster[];
  scatter:  { hour: number; los: number; cluster: number }[];
  daily:    { date: string; count: number; avg_los: number }[];
};

export type PathwayNextInput = { sequence: string[] };
export type PathwayPrediction = { location: string; prob: number; count: number };
export type PathwayNextResponse = {
  predictions: PathwayPrediction[];
  avg_remaining_los_min: number;
  n_matched: number;
  entropy_bits: number;
};
export type FloorRoom = {
  id: string; label: string;
  x: number; y: number; w: number; h: number;
  count: number; avg_duration_min: number; avg_pos: number; layer: number;
};
export type FloorEdge = { source: string; target: string; count: number; weight: number };
export type FloorPlanData = {
  rooms: FloorRoom[]; edges: FloorEdge[];
  canvas: { w: number; h: number }; scale_m_per_unit: number;
};

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
  commandCenter: (f?: FilterParams) => get<CommandCenterData>(`/api/command-center${qs(f)}`),
  flexsimExportUrl: () => `${BASE}/api/flexsim-export`,
  patients: (search = "", limit = 50, losMinMin?: number, losMaxMin?: number, f?: FilterParams) => {
    const extra: Record<string, string | number> = { search, limit };
    if (losMinMin != null) extra.los_min_min = losMinMin;
    if (losMaxMin != null) extra.los_max_min = losMaxMin;
    return get<PatientSummary[]>(`/api/patients${qs(f, extra)}`);
  },
  advancedAnalytics: (f?: FilterParams) => get<AdvancedAnalytics>(`/api/advanced-analytics${qs(f)}`),
  research: (f?: FilterParams) => get<ResearchData>(`/api/research${qs(f)}`),
  researchBeforeAfter: (splitDate: string, f?: FilterParams) =>
    get<BeforeAfterResult>(`/api/research/before-after${qs(f, { split_date: splitDate })}`),
  researchDecomposition: (f?: FilterParams) => get<DecompResult>(`/api/research/decomposition${qs(f)}`),
  researchKaplanMeier:   (f?: FilterParams) => get<KMResult>(`/api/research/kaplan-meier${qs(f)}`),
  researchFeatureImportance: () => get<FeatResult>(`/api/research/feature-importance`),
  pathwayNext: (body: PathwayNextInput) => post<PathwayNextResponse>("/api/pathway-next", body),
  floorPlan: () => get<FloorPlanData>("/api/floor-plan"),
  patientJourney: (dossierIds: string[]) =>
    get<PatientJourneyData[]>(
      `/api/patient-journey?dossier_ids=${dossierIds.map(encodeURIComponent).join(",")}`
    ),
  drilldownByLocation: (location: string, f?: FilterParams, limit = 50) =>
    get<DrilldownResult>(`/api/drilldown/by-location${qs(f, { location, limit })}`),
  drilldownByVariant: (sequence: string[], f?: FilterParams, limit = 50) =>
    get<DrilldownResult>(`/api/drilldown/by-variant${qs(f, { sequence: sequence.join(","), limit })}`),
  llmStatus: () =>
    get<{ ok: boolean; model?: string; model_available?: boolean; models?: string[]; error?: string }>(
      "/api/llm-status"
    ),
  explainStream: async (
    body: ExplainRequest,
    onToken: (t: string) => void,
    onError: (msg: string) => void,
    signal?: AbortSignal,
  ) => {
    const res = await fetch(`${BASE}/api/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      onError(`HTTP ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const p of parts) {
        const line = p.trim();
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        try {
          const obj = JSON.parse(json) as { token?: string; error?: string; done?: boolean };
          if (obj.error) { onError(obj.error); return; }
          if (obj.token) onToken(obj.token);
          if (obj.done) return;
        } catch { /* ignore parse error */ }
      }
    }
  },
};

export type DrilldownItem = {
  dossier_id: string;
  patient_id: string;
  arrivee: string | null;
  los_min: number | null;
  min_at_loc?: number | null;
  n_passages?: number;
  n_steps?: number;
  mode_sortie: string;
};
export type DrilldownStats = {
  n_total: number;
  mean_min?: number | null;
  median_min?: number | null;
  p90_min?: number | null;
  mean_los?: number | null;
  median_los?: number | null;
  p90_los?: number | null;
};
export type DrilldownResult = {
  location?: string;
  sequence?: string[];
  n_total: number;
  items: DrilldownItem[];
  stats: DrilldownStats;
};

export type ExplainRequest = {
  kind: "rupture" | "avant_apres" | "general" | "briefing";
  context: Record<string, unknown>;
  question?: string;
  history?: { role: "user" | "assistant"; content: string }[];
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
export type CommandCenterData = {
  kpis: {
    total_patients: number;
    avg_los_min: number;
    p90_los_min: number;
    p10_los_min: number;
    throughput_per_day: number;
    hospit_pct: number;
  };
  hourly_arrivals: { hour: number; count: number; avg_los: number }[];
  los_distribution: { label: string; count: number }[];
  daily_trend: { date: string; count: number; avg_los: number }[];
  bottlenecks: { location: string; avg_duration_min: number; n_visits: number }[];
  exit_modes: { mode: string; count: number; pct: number }[];
  recent_activity: {
    dossier_id: string;
    arrivee: string | null;
    los_min: number | null;
    mode_sortie: string;
  }[];
};

export type PatientSummary = {
  dossier_id: string;
  patient_id: string | null;
  arrivee: string | null;
  mode_sortie: string | null;
  los_min: number | null;
  n_steps: number;
};

export type JourneyStep = {
  location: string;
  start: string | null;
  end: string | null;
  start_min: number | null;
  end_min: number | null;
  duration_min: number | null;
};

export type PatientJourneyData = {
  dossier_id: string;
  patient_id: string | null;
  arrivee: string | null;
  sortie: string | null;
  mode_sortie: string | null;
  los_min: number | null;
  steps: JourneyStep[];
};

export type AdvancedAnalytics = {
  flow_metrics: {
    delai_premier_soin: { mean: number; median: number; p90: number; n: number };
    attente_sortie:     { n_visits: number; avg_min: number; p90_min: number };
    imagerie:           { n_visits: number; avg_min: number; p90_min: number };
    reorientation_rate:  number;
    reorientation_count: number;
  };
  location_heatmap: { locations: string[]; matrix: number[][]; max: number };
  location_stats: { location: string; n_visits: number; avg_min: number; median_min: number; p90_min: number }[];
  weekday_pattern: { day: string; count: number; avg_los: number; hospit_pct: number }[];
  monthly_pattern: { month: string; count: number; avg_los: number }[];
  exit_by_hour: { hour: number; retour_domicile: number; hospitalisation: number; total: number }[];
  uhcd_stats: { n_dossiers: number; pct_of_total: number; avg_min: number; median_min: number; monthly_trend: { month: string; count: number }[] };
  sauv_trend: { month: string; n_patients: number }[];
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
