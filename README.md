# ED Flow Intelligence

Full-stack analytics for a pediatric emergency department event log:
FastAPI + pandas + SimPy backend, Vite + React + Tailwind + Recharts + React Flow frontend.

## Quickstart

### 1. Backend

```
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

API on http://localhost:8000. CSV is loaded once at startup from `../2025_11_10_TrackingUrg.csv`.

### 2. Frontend

```
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

## Endpoints

- `GET /api/kpis`
- `GET /api/arrivals-heatmap`
- `GET /api/exit-modes`
- `GET /api/top-variants?limit=10`
- `GET /api/process-graph`
- `GET /api/bottlenecks`
- `GET /api/sankey`
- `POST /api/simulate` — body `{extra_boxes, arrival_multiplier, ioa_speedup, duration_days}`

## Tabs

- **Vue d'ensemble** — KPIs, heatmap 7×24, modes de sortie, top variantes
- **Carte du parcours** — directly-follows graph (React Flow + dagre)
- **Goulots** — locaux classés par durée moyenne
- **Simulation** — SimPy (Poisson arrivals par heure, M/M/c par local) avec baseline vs scénario
# salma
