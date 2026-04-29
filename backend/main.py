from __future__ import annotations

import io
import random
import zipfile
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional, List, Dict

import numpy as np
import pandas as pd
import simpy
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.cluster import KMeans

CSV_PATH = Path(__file__).resolve().parent.parent / "2025_11_10_TrackingUrg.csv"

app = FastAPI(title="ED Flow Intelligence API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Cache:
    df: pd.DataFrame | None = None
    cases: pd.DataFrame | None = None
    model: Any = None
    model_p10: Any = None
    model_p90: Any = None
    feature_cols: list[str] | None = None
    top_locations: list[str] | None = None
    exit_mode_values: list[str] | None = None
    residual_std: float = 0.0


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    df = df.loc[:, [c for c in df.columns if not c.startswith("Unnamed")]]
    for c in ["date_arrivée", "date_sortie", "loc_heure_debut", "loc_heure_fin"]:
        df[c] = pd.to_datetime(df[c], errors="coerce")
    df = df.dropna(subset=["DOSSIER_ID", "loc_heure_debut", "loc_local_libelle"]).copy()
    df["loc_local_libelle"] = df["loc_local_libelle"].astype(str).str.strip().str.upper()
    df["duration_min"] = (
        (df["loc_heure_fin"] - df["loc_heure_debut"]).dt.total_seconds() / 60.0
    )
    df.loc[df["duration_min"] < 0, "duration_min"] = np.nan
    df = df.sort_values(["DOSSIER_ID", "loc_heure_debut"]).reset_index(drop=True)
    return df


def _build_cases(df: pd.DataFrame) -> pd.DataFrame:
    agg = df.groupby("DOSSIER_ID").agg(
        patient_id=("PATIENT_ID", "first"),
        arrivee=("date_arrivée", "first"),
        sortie=("date_sortie", "first"),
        mode_sortie=("mode_de_sortie", "first"),
        n_steps=("loc_local_libelle", "size"),
        sequence=("loc_local_libelle", lambda s: tuple(s.tolist())),
        first_location=("loc_local_libelle", "first"),
    )
    agg["los_min"] = (agg["sortie"] - agg["arrivee"]).dt.total_seconds() / 60.0
    agg.loc[agg["los_min"] < 0, "los_min"] = np.nan
    agg["hour"] = agg["arrivee"].dt.hour
    agg["day_of_week"] = agg["arrivee"].dt.dayofweek
    agg["month"] = agg["arrivee"].dt.month
    return agg.reset_index()


def _train_model() -> None:
    c = Cache.cases
    if c is None:
        return
    d = c.dropna(subset=["los_min", "hour", "day_of_week", "month", "first_location"]).copy()
    d = d[d["los_min"] > 0]
    if len(d) < 50:
        return
    top_locs = d["first_location"].value_counts().head(15).index.tolist()
    exit_vals = d["mode_sortie"].fillna("Inconnu").value_counts().head(8).index.tolist()
    Cache.top_locations = top_locs
    Cache.exit_mode_values = exit_vals

    def featurize(df_in: pd.DataFrame) -> np.ndarray:
        rows = []
        for _, r in df_in.iterrows():
            feat = [r["hour"], r["day_of_week"], r["month"]]
            for loc in top_locs:
                feat.append(1 if r["first_location"] == loc else 0)
            em = r.get("mode_sortie") or "Inconnu"
            for v in exit_vals:
                feat.append(1 if em == v else 0)
            rows.append(feat)
        return np.array(rows, dtype=float)

    X = featurize(d)
    y = d["los_min"].clip(upper=d["los_min"].quantile(0.99)).values

    m = GradientBoostingRegressor(n_estimators=80, max_depth=4, random_state=7)
    m.fit(X, y)
    Cache.model = m

    pred = m.predict(X)
    Cache.residual_std = float(np.std(y - pred))

    m10 = GradientBoostingRegressor(loss="quantile", alpha=0.1, n_estimators=60, max_depth=4, random_state=7)
    m90 = GradientBoostingRegressor(loss="quantile", alpha=0.9, n_estimators=60, max_depth=4, random_state=7)
    m10.fit(X, y)
    m90.fit(X, y)
    Cache.model_p10 = m10
    Cache.model_p90 = m90

    Cache.feature_cols = ["hour", "day_of_week", "month"] + [f"loc_{l}" for l in top_locs] + [f"exit_{v}" for v in exit_vals]


@app.on_event("startup")
def _load() -> None:
    if not CSV_PATH.exists():
        raise RuntimeError(f"CSV not found: {CSV_PATH}")
    df = pd.read_csv(CSV_PATH, sep=";", encoding="utf-8-sig", low_memory=False)
    Cache.df = _clean(df)
    Cache.cases = _build_cases(Cache.df)
    try:
        _train_model()
    except Exception as e:
        print(f"[warn] ML model training failed: {e}")


def _df() -> pd.DataFrame:
    if Cache.df is None:
        raise HTTPException(500, "Data not loaded")
    return Cache.df


def _cases() -> pd.DataFrame:
    if Cache.cases is None:
        raise HTTPException(500, "Data not loaded")
    return Cache.cases


def _safe(v: Any) -> Any:
    if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
        return None
    if isinstance(v, (np.floating,)):
        f = float(v)
        return None if (np.isnan(f) or np.isinf(f)) else f
    if isinstance(v, (np.integer,)):
        return int(v)
    return v


# ------------------- FILTERS -------------------

class Filters:
    def __init__(
        self,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        exit_mode: Optional[str] = None,
        hour_from: Optional[int] = None,
        hour_to: Optional[int] = None,
    ):
        self.date_from = pd.to_datetime(date_from) if date_from else None
        self.date_to = pd.to_datetime(date_to) if date_to else None
        self.exit_mode = exit_mode or None
        self.hour_from = hour_from
        self.hour_to = hour_to


def _filters_dep(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> Filters:
    return Filters(date_from, date_to, exit_mode, hour_from, hour_to)


def filter_cases(c: pd.DataFrame, f: Filters) -> pd.DataFrame:
    out = c
    if f.date_from is not None:
        out = out[out["arrivee"] >= f.date_from]
    if f.date_to is not None:
        out = out[out["arrivee"] <= f.date_to]
    if f.exit_mode:
        out = out[out["mode_sortie"].fillna("Inconnu") == f.exit_mode]
    if f.hour_from is not None:
        out = out[out["hour"] >= f.hour_from]
    if f.hour_to is not None:
        out = out[out["hour"] <= f.hour_to]
    return out


def filter_df(df: pd.DataFrame, f: Filters, cases: pd.DataFrame) -> pd.DataFrame:
    """Filter the events df by keeping only events for dossiers passing filters."""
    filtered_cases = filter_cases(cases, f)
    ids = set(filtered_cases["DOSSIER_ID"].tolist())
    return df[df["DOSSIER_ID"].isin(ids)].copy()


# ------------------- ENDPOINTS -------------------


@app.get("/api/kpis")
def kpis(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> dict:
    """Return headline KPIs for the filtered period.

    Units:
        total_dossiers, total_patients, total_events: integer counts (dossiers / patients / location events).
        los_median_min, los_p90_min: minutes (case-level length-of-stay).
        hospit_pct: percentage 0–100 (share of cases whose exit mode contains "Hospitalisation").
        period_start, period_end: ISO datetime strings (naive, dataset-local time).
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f)
    d = filter_df(_df(), f, _cases())
    if len(c) == 0:
        return {
            "total_dossiers": 0, "total_patients": 0,
            "los_median_min": None, "los_p90_min": None, "hospit_pct": None,
            "period_start": "", "period_end": "", "total_events": 0,
        }
    hosp_mask = c["mode_sortie"].fillna("").str.contains("Hospitalisation", case=False)
    return {
        "total_dossiers": int(c["DOSSIER_ID"].nunique()),
        "total_patients": int(c["patient_id"].nunique()),
        "los_median_min": _safe(c["los_min"].median()),
        "los_p90_min": _safe(c["los_min"].quantile(0.90)),
        "hospit_pct": _safe(100.0 * hosp_mask.mean()),
        "period_start": str(d["date_arrivée"].min()) if len(d) else "",
        "period_end": str(d["date_arrivée"].max()) if len(d) else "",
        "total_events": int(len(d)),
    }


@app.get("/api/arrivals-heatmap")
def arrivals_heatmap(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> dict:
    """Arrival counts per (weekday, hour-of-day).

    Units:
        matrix[7][24]: integer counts of dossiers (1 cell per day×hour bin).
        max: peak count across all bins.
        days: French abbreviated weekdays, index 0 = Monday.
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f).dropna(subset=["arrivee"])
    mat = np.zeros((7, 24), dtype=int)
    for ts in c["arrivee"]:
        mat[ts.weekday(), ts.hour] += 1
    days = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]
    return {"days": days, "matrix": mat.tolist(), "max": int(mat.max()) if mat.size else 0}


@app.get("/api/exit-modes")
def exit_modes(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> list[dict]:
    """Exit-mode distribution (sorted by frequency).

    Units:
        mode: free text from CSV `mode_de_sortie`, "Inconnu" for missing.
        count: integer (number of dossiers).
    """
    f = Filters(date_from, date_to, None, hour_from, hour_to)  # don't filter by mode itself
    c = filter_cases(_cases(), f)
    vc = c["mode_sortie"].fillna("Inconnu").value_counts()
    return [{"mode": str(k), "count": int(v)} for k, v in vc.items()]


@app.get("/api/top-variants")
def top_variants(
    limit: int = 10,
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> list[dict]:
    """Top-N most frequent process variants (full case sequences).

    Units:
        sequence: ordered list of location labels (full path).
        count: integer (number of dossiers following exactly this path).
        pct: percentage 0–100 (share of all dossiers).
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f)
    vc = Counter(c["sequence"].tolist())
    total = sum(vc.values()) or 1
    out = []
    for seq, n in vc.most_common(limit):
        out.append({
            "sequence": list(seq),
            "count": int(n),
            "pct": round(100.0 * n / total, 2),
        })
    return out


@app.get("/api/process-graph")
def process_graph(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> dict:
    """Directly-follows process graph over the top 25 locations.

    Units:
        nodes[].count: integer (number of *visits/events* — not dossiers).
        nodes[].avg_duration_min: minutes (mean per-event stay duration at that location).
        edges[].count: integer (number of A→B transitions observed).
        edges[].avg_wait_min: minutes (mean idle time between leaving A and entering B).
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    d = filter_df(_df(), f, _cases())
    if len(d) == 0:
        return {"nodes": [], "edges": []}
    node_counts = d["loc_local_libelle"].value_counts()
    top = node_counts.head(25).index.tolist()
    sub = d[d["loc_local_libelle"].isin(top)]
    avg_dur = sub.groupby("loc_local_libelle")["duration_min"].mean()
    nodes = []
    for loc in top:
        nodes.append({
            "id": loc,
            "label": loc,
            "count": int(node_counts[loc]),
            "avg_duration_min": _safe(avg_dur.get(loc, np.nan)),
        })
    edges_counter: Counter = Counter()
    waits: dict[tuple, list[float]] = defaultdict(list)
    for _, grp in d.groupby("DOSSIER_ID"):
        rows = grp[["loc_local_libelle", "loc_heure_debut", "loc_heure_fin"]].values
        for i in range(len(rows) - 1):
            a, _, end_a = rows[i]
            b, start_b, _ = rows[i + 1]
            if a in top and b in top and a != b:
                edges_counter[(a, b)] += 1
                if pd.notna(end_a) and pd.notna(start_b):
                    waits[(a, b)].append((start_b - end_a).total_seconds() / 60.0)
    edges = []
    for (a, b), n in edges_counter.most_common(80):
        w = waits.get((a, b), [])
        edges.append({
            "source": a,
            "target": b,
            "count": int(n),
            "avg_wait_min": _safe(float(np.mean(w))) if w else None,
        })
    return {"nodes": nodes, "edges": edges}


@app.get("/api/bottlenecks")
def bottlenecks(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> list[dict]:
    """Top 15 bottleneck locations (filter ≥30 events), ranked by mean duration.

    Units:
        location: location label (uppercased).
        count: integer (number of events recorded at this location).
        mean_min, median_min, p90_min: minutes (per-event stay duration).
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    d = filter_df(_df(), f, _cases())
    if len(d) == 0:
        return []
    g = d.groupby("loc_local_libelle").agg(
        count=("duration_min", "size"),
        mean=("duration_min", "mean"),
        median=("duration_min", "median"),
        p90=("duration_min", lambda s: s.quantile(0.9)),
    )
    g = g[g["count"] >= 30].sort_values("mean", ascending=False).head(15)
    return [
        {
            "location": str(idx),
            "count": int(row["count"]),
            "mean_min": _safe(row["mean"]),
            "median_min": _safe(row["median"]),
            "p90_min": _safe(row["p90"]),
        }
        for idx, row in g.iterrows()
    ]


@app.get("/api/sankey")
def sankey(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> dict:
    """First 3-step Sankey flows.

    Units:
        labels[]: location names; same location may appear multiple times (one per layer).
        source[], target[]: integer indices into labels[].
        value[]: integer counts (number of dossiers transitioning A→B at that layer).
        layer[]: 0..steps; index of the column in which each label sits.
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f)
    steps = 3
    layered: list[Counter] = [Counter() for _ in range(steps)]
    flows: dict[tuple[int, str, str], int] = defaultdict(int)
    for seq in c["sequence"]:
        s = list(seq)[:steps + 1]
        for i in range(min(len(s) - 1, steps)):
            a, b = s[i], s[i + 1]
            layered[i][a] += 1
            flows[(i, a, b)] += 1
    label_to_idx: dict[tuple[int, str], int] = {}
    labels: list[str] = []
    for layer_idx, cnt in enumerate(layered):
        for loc in cnt:
            key = (layer_idx, loc)
            label_to_idx[key] = len(labels)
            labels.append(loc)
    last_layer = steps
    last_nodes: set[str] = set()
    for (i, a, b), _n in flows.items():
        if i == steps - 1:
            last_nodes.add(b)
    for loc in last_nodes:
        key = (last_layer, loc)
        label_to_idx[key] = len(labels)
        labels.append(loc)
    sources, targets, values, node_layer = [], [], [], []
    for (i, a, b), n in flows.items():
        src = label_to_idx.get((i, a))
        tgt = label_to_idx.get((i + 1, b))
        if src is None or tgt is None:
            continue
        sources.append(src)
        targets.append(tgt)
        values.append(int(n))
    # assign layer per label index
    layer_by_idx = [0] * len(labels)
    for (l, _loc), idx in label_to_idx.items():
        layer_by_idx[idx] = l
    return {"labels": labels, "source": sources, "target": targets, "value": values, "layer": layer_by_idx}


# ---------------- ML PREDICTION ----------------

class PredictInput(BaseModel):
    hour: int = Field(..., ge=0, le=23)
    day_of_week: int = Field(..., ge=0, le=6)
    first_location: str
    exit_mode: str
    month: int = Field(6, ge=1, le=12)


@app.post("/api/predict")
def predict(inp: PredictInput) -> dict:
    """Predict patient length-of-stay (LOS).

    Returns:
        predicted_los_min: minutes (point prediction).
        p10, p90: minutes (quantile bounds, guaranteed p10 ≤ predicted ≤ p90).
    """
    if Cache.model is None:
        raise HTTPException(503, "Model not trained")
    top_locs = Cache.top_locations or []
    exit_vals = Cache.exit_mode_values or []
    feat = [inp.hour, inp.day_of_week, inp.month]
    for loc in top_locs:
        feat.append(1 if inp.first_location == loc else 0)
    for v in exit_vals:
        feat.append(1 if inp.exit_mode == v else 0)
    X = np.array([feat], dtype=float)
    pred = float(Cache.model.predict(X)[0])
    p10 = float(Cache.model_p10.predict(X)[0]) if Cache.model_p10 is not None else pred - Cache.residual_std
    p90 = float(Cache.model_p90.predict(X)[0]) if Cache.model_p90 is not None else pred + Cache.residual_std

    # Enforce non-negative + monotonic ordering p10 ≤ pred ≤ p90.
    pred = max(0.0, pred)
    p10  = max(0.0, p10)
    p90  = max(0.0, p90)
    p10, pred, p90 = sorted([p10, pred, p90])
    return {
        "predicted_los_min": round(pred, 1),
        "p10": round(p10, 1),
        "p90": round(p90, 1),
    }


@app.get("/api/predict-options")
def predict_options() -> dict:
    """Categorical inputs allowed by the LOS prediction model.

    Units:
        first_locations[]: location labels seen during training (top 15 by frequency).
        exit_modes[]: exit-mode labels seen during training (top 8).
    """
    return {
        "first_locations": Cache.top_locations or [],
        "exit_modes": Cache.exit_mode_values or [],
    }


# ---------------- ANOMALIES ----------------

@app.get("/api/anomalies")
def anomalies(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> dict:
    """Cases flagged as anomalies (LOS > μ+3σ or rare variant <0.5%).

    Units:
        total: integer (number of flagged dossiers).
        pct: percentage 0–100 (share of flagged among filtered cases).
        items[].los_min: minutes (case LOS).
        items[].variant: pretty-printed first 6 steps of the path.
        items[].reason: human-readable explanation.
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f).dropna(subset=["los_min"])
    if len(c) == 0:
        return {"total": 0, "pct": 0.0, "items": []}
    mu = c["los_min"].mean()
    sd = c["los_min"].std()
    threshold = mu + 3 * sd
    vc = Counter(c["sequence"].tolist())
    total = sum(vc.values()) or 1
    rare_variants = {v for v, n in vc.items() if (n / total) < 0.005}

    items = []
    for _, r in c.iterrows():
        reasons = []
        if r["los_min"] > threshold:
            reasons.append(f"LOS {r['los_min']:.0f}min > μ+3σ ({threshold:.0f})")
        if r["sequence"] in rare_variants:
            reasons.append(f"Variante rare ({100.0 * vc[r['sequence']] / total:.2f}%)")
        if reasons:
            items.append({
                "dossier_id": str(r["DOSSIER_ID"]),
                "los_min": round(float(r["los_min"]), 1),
                "variant": " → ".join(list(r["sequence"])[:6]) + ("…" if len(r["sequence"]) > 6 else ""),
                "reason": " · ".join(reasons),
            })
    items.sort(key=lambda x: x["los_min"], reverse=True)
    return {
        "total": len(items),
        "pct": round(100.0 * len(items) / len(c), 2),
        "items": items[:50],
    }


# ---------------- CONFORMANCE ----------------

@app.get("/api/conformance")
def conformance(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> dict:
    """Process conformance against the expected pattern (start with IOA/Tri, contains BOX/SALLE, valid order).

    Units:
        conformance_rate: percentage 0–100 (share of conformant dossiers).
        total, conformant: integer counts.
        deviations[].count: integer count for each deviation reason.
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f)
    total = len(c)
    if total == 0:
        return {"conformance_rate": 0.0, "total": 0, "conformant": 0, "deviations": []}

    def is_conformant(seq: tuple) -> tuple[bool, list[str]]:
        reasons = []
        if not seq:
            return False, ["parcours vide"]
        first = seq[0]
        starts_ioa = "IOA" in first or "TRI" in first or "ACCUEIL" in first
        has_box = any(("BOX" in s or "SALLE" in s) for s in seq)
        ends_ok = len(seq) >= 2
        if not starts_ioa:
            reasons.append("Début sans IOA/Tri")
        if not has_box:
            reasons.append("Aucun BOX/SALLE")
        if not ends_ok:
            reasons.append("Parcours tronqué")
        # unexpected order: BOX/SALLE before IOA
        try:
            ioa_idx = next(i for i, s in enumerate(seq) if "IOA" in s or "TRI" in s)
            box_idx = next((i for i, s in enumerate(seq) if "BOX" in s or "SALLE" in s), None)
            if box_idx is not None and box_idx < ioa_idx:
                reasons.append("Ordre inversé (BOX avant IOA)")
        except StopIteration:
            pass
        return (len(reasons) == 0), reasons

    conformant = 0
    dev_counter: Counter = Counter()
    for seq in c["sequence"]:
        ok, rs = is_conformant(seq)
        if ok:
            conformant += 1
        else:
            for r in rs:
                dev_counter[r] += 1

    return {
        "conformance_rate": round(100.0 * conformant / total, 2),
        "total": total,
        "conformant": conformant,
        "deviations": [{"type": k, "count": int(v)} for k, v in dev_counter.most_common(5)],
    }


# ---------------- CLUSTERING ----------------

@app.get("/api/clusters")
def clusters(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> dict:
    """K-means (k=3) clusters of patient pathways via TF-IDF on location sequences.

    Units:
        clusters[].size: integer (number of dossiers).
        clusters[].avg_los_min: minutes (mean LOS in this cluster).
        clusters[].top_locations: most-weighted locations in the centroid (string list).
        clusters[].top_exit_mode: most frequent exit mode (string).
        clusters[].label: human label assigned by ascending avg_los ("Fast track" / "standard" / "complexe").
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f).dropna(subset=["los_min"])
    if len(c) < 30:
        return {"clusters": []}
    docs = [" ".join(s).replace(" ", "_").replace("_", " ") for s in c["sequence"]]
    # Use a simple location vocab limited to top 30
    d = _df()
    top30 = d["loc_local_libelle"].value_counts().head(30).index.tolist()
    vocab = {loc.replace(" ", "_"): i for i, loc in enumerate(top30)}
    docs2 = [" ".join(s.replace(" ", "_") for s in seq) for seq in c["sequence"]]
    try:
        vec = TfidfVectorizer(vocabulary=vocab, lowercase=False, token_pattern=r"\S+")
        X = vec.fit_transform(docs2)
    except Exception:
        return {"clusters": []}
    k = 3
    km = KMeans(n_clusters=k, n_init=5, random_state=7)
    labels = km.fit_predict(X)
    cases_with_lbl = c.assign(cluster=labels)

    clusters_out = []
    for cid in range(k):
        sub = cases_with_lbl[cases_with_lbl["cluster"] == cid]
        if len(sub) == 0:
            continue
        # top locations in centroid
        centroid = km.cluster_centers_[cid]
        inv_vocab = {i: loc for loc, i in vocab.items()}
        top_idxs = np.argsort(centroid)[::-1][:5]
        top_locs = [inv_vocab[i].replace("_", " ") for i in top_idxs if centroid[i] > 0]
        top_exit = sub["mode_sortie"].fillna("Inconnu").value_counts().head(1).index.tolist()
        clusters_out.append({
            "cluster_id": int(cid),
            "size": int(len(sub)),
            "avg_los_min": round(float(sub["los_min"].mean()), 1),
            "top_locations": top_locs,
            "top_exit_mode": top_exit[0] if top_exit else "—",
        })
    # label by avg_los ranking
    clusters_out.sort(key=lambda x: x["avg_los_min"])
    names = ["Fast track", "Parcours standard", "Parcours complexe"]
    for i, cl in enumerate(clusters_out):
        cl["label"] = names[i] if i < len(names) else f"Cluster {i}"
    return {"clusters": clusters_out}


# ---------------- READMISSIONS ----------------

@app.get("/api/readmissions")
def readmissions(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> dict:
    """Readmission rates within 7 and 30 days after a previous exit, plus most-frequent re-attenders.

    Units:
        readmission_7d_rate, readmission_30d_rate: percentage 0–100 (frontends MUST NOT re-multiply by 100).
        top_patients[].count: integer (number of <7-day readmissions for this patient).
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f).dropna(subset=["arrivee", "sortie"]).sort_values(["patient_id", "arrivee"])
    if len(c) == 0:
        return {"readmission_7d_rate": 0.0, "readmission_30d_rate": 0.0, "top_patients": []}
    r7 = 0
    r30 = 0
    per_patient: dict[Any, int] = defaultdict(int)
    prev_exit_by_patient: dict[Any, Any] = {}
    for _, row in c.iterrows():
        pid = row["patient_id"]
        arr = row["arrivee"]
        if pid in prev_exit_by_patient:
            pe = prev_exit_by_patient[pid]
            if pd.notna(pe) and pd.notna(arr):
                delta = (arr - pe).total_seconds() / 86400.0
                if 0 <= delta <= 7:
                    r7 += 1
                    per_patient[pid] += 1
                if 0 <= delta <= 30:
                    r30 += 1
        prev_exit_by_patient[pid] = row["sortie"]
    total = len(c)
    top = sorted(per_patient.items(), key=lambda x: x[1], reverse=True)[:10]
    return {
        "readmission_7d_rate": round(100.0 * r7 / total, 2),
        "readmission_30d_rate": round(100.0 * r30 / total, 2),
        "top_patients": [{"patient_id": str(p), "count": int(n)} for p, n in top],
    }


# ---------------- INSIGHTS ----------------

@app.get("/api/insights")
def insights(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    exit_mode: Optional[str] = Query(None),
    hour_from: Optional[int] = Query(None),
    hour_to: Optional[int] = Query(None),
) -> list[dict]:
    """Auto-generated narrative insights (rule-based; no LLM).

    Units:
        items[].text: free-text French sentence (chiffres déjà formatés).
        items[].severity: one of "info" | "warning" | "success".
        items[].icon: emoji.
    """
    f = Filters(date_from, date_to, exit_mode, hour_from, hour_to)
    c = filter_cases(_cases(), f)
    d = filter_df(_df(), f, _cases())
    out: list[dict] = []
    if len(c) == 0:
        return out

    # 1 - quick exit pct
    los = c["los_min"].dropna()
    if len(los):
        thr = 120
        pct = 100.0 * (los < thr).mean()
        out.append({
            "icon": "⏱️",
            "text": f"{pct:.0f}% des patients sortent en moins de {thr} min",
            "severity": "info",
        })

    # 2 - main bottleneck
    if len(d):
        g = d.groupby("loc_local_libelle")["duration_min"].agg(["mean", "count"])
        g = g[g["count"] >= 30]
        if len(g):
            top = g.sort_values("mean", ascending=False).head(1)
            loc = top.index[0]
            out.append({
                "icon": "🚧",
                "text": f"Goulot principal: {loc} (durée moy {top['mean'].iloc[0]:.0f} min)",
                "severity": "warning",
            })

    # 3 - peak
    arr = c.dropna(subset=["arrivee"])
    if len(arr):
        by = arr.groupby([arr["arrivee"].dt.dayofweek, arr["arrivee"].dt.hour]).size()
        (dow, hr), n = by.sort_values(ascending=False).index[0], by.max()
        days = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
        out.append({
            "icon": "📈",
            "text": f"Pic d'affluence: {days[dow]} à {hr}h ({int(n)} arrivées)",
            "severity": "info",
        })

    # 4 - hospit rate
    hosp_mask = c["mode_sortie"].fillna("").str.contains("Hospitalisation", case=False)
    hpct = 100.0 * hosp_mask.mean()
    sev = "warning" if hpct > 20 else "success"
    direction = "au-dessus" if hpct > 20 else "en-dessous"
    out.append({
        "icon": "🏥",
        "text": f"Taux d'hospitalisation: {hpct:.1f}% ({direction} de la moyenne 20%)",
        "severity": sev,
    })

    # 5 - conformance (reuse logic)
    def conformant(seq):
        if not seq:
            return False
        first = seq[0]
        if not ("IOA" in first or "TRI" in first or "ACCUEIL" in first):
            return False
        if not any(("BOX" in s or "SALLE" in s) for s in seq):
            return False
        return True
    if len(c):
        cr = 100.0 * sum(1 for s in c["sequence"] if conformant(s)) / len(c)
        out.append({
            "icon": "✅",
            "text": f"{cr:.0f}% de conformité au parcours cible (IOA → Box)",
            "severity": "success" if cr > 70 else "warning",
        })
    return out


# ---------------- SIMULATION (Monte Carlo multi-scenario) ----------------


class Scenario(BaseModel):
    name: str
    extra_boxes: int = Field(0, ge=0, le=10)
    arrival_multiplier: float = Field(1.0, ge=0.1, le=5.0)
    ioa_speedup: float = Field(0.0, ge=0.0, le=0.9)
    duration_days: int = Field(7, ge=1, le=60)


class SimInput(BaseModel):
    # Legacy single-scenario fields (for backward compat)
    extra_boxes: Optional[int] = None
    arrival_multiplier: Optional[float] = None
    ioa_speedup: Optional[float] = None
    duration_days: Optional[int] = None
    # New multi-scenario
    scenarios: Optional[list[Scenario]] = None
    n_runs: int = Field(10, ge=1, le=50)


def _simulate_scenario(
    hourly_rate: np.ndarray,
    services: dict[str, float],
    routing: list[str],
    capacities: dict[str, int],
    ioa_speedup: float,
    arrival_mult: float,
    duration_min: int,
    seed: int = 42,
) -> dict:
    random.seed(seed)
    np.random.seed(seed)
    env = simpy.Environment()
    resources = {loc: simpy.Resource(env, capacity=capacities[loc]) for loc in routing}
    los_list: list[float] = []
    wait_list: list[float] = []
    completed = [0]

    def patient(env: simpy.Environment, arrive_t: float) -> Any:
        start = arrive_t
        for loc in routing:
            req = resources[loc].request()
            t_req = env.now
            yield req
            wait_list.append(env.now - t_req)
            mean_s = services[loc]
            if loc == "ATTENTE PED POST-TRI IOA":
                mean_s *= max(0.1, 1.0 - ioa_speedup)
            yield env.timeout(np.random.exponential(mean_s))
            resources[loc].release(req)
        los_list.append(env.now - start)
        completed[0] += 1

    def arrivals(env: simpy.Environment) -> Any:
        while True:
            h = int(env.now // 60) % 24
            rate_per_min = max(1e-6, hourly_rate[h] * arrival_mult / 60.0)
            yield env.timeout(np.random.exponential(1.0 / rate_per_min))
            env.process(patient(env, env.now))

    env.process(arrivals(env))
    env.run(until=duration_min)
    return {
        "avg_los_min": float(np.mean(los_list)) if los_list else 0.0,
        "p90_los_min": float(np.quantile(los_list, 0.9)) if los_list else 0.0,
        "avg_wait_min": float(np.mean(wait_list)) if wait_list else 0.0,
        "throughput": int(completed[0]),
    }


@lru_cache(maxsize=1)
def _sim_params() -> tuple[np.ndarray, dict, list, dict, str]:
    d = _df()
    c = _cases().dropna(subset=["arrivee"])
    hourly = np.zeros(24)
    for ts in c["arrivee"]:
        hourly[ts.hour] += 1
    span_days = max(1.0, (c["arrivee"].max() - c["arrivee"].min()).total_seconds() / 86400.0)
    hourly = hourly / span_days

    top_locs = (
        d["loc_local_libelle"].value_counts().head(5).index.tolist()
    )
    services = {}
    for loc in top_locs:
        m = d.loc[d["loc_local_libelle"] == loc, "duration_min"].mean()
        services[loc] = float(m) if pd.notna(m) and m > 0 else 30.0

    routing = ["ATTENTE POST-TRI", "ATTENTE PED POST-TRI IOA"]
    routing = [r for r in routing if r in services]
    for loc in top_locs:
        if loc not in routing:
            routing.append(loc)
    routing = routing[:3]

    bottleneck = max(routing, key=lambda k: services[k])
    caps = {loc: 2 for loc in routing}
    return hourly, services, routing, caps, bottleneck


def _mc_replications(
    hourly: np.ndarray, services: dict, routing: list, caps: dict,
    ioa_speedup: float, arrival_mult: float, duration_min: int, n_runs: int,
) -> dict:
    los_means, wait_means, thrs, p90s = [], [], [], []
    for i in range(n_runs):
        r = _simulate_scenario(
            hourly, services, routing, dict(caps),
            ioa_speedup=ioa_speedup, arrival_mult=arrival_mult,
            duration_min=duration_min, seed=7 + i,
        )
        los_means.append(r["avg_los_min"])
        wait_means.append(r["avg_wait_min"])
        thrs.append(r["throughput"])
        p90s.append(r["p90_los_min"])

    def stats(a):
        return {
            "mean": float(np.mean(a)) if a else 0.0,
            "p05": float(np.quantile(a, 0.05)) if a else 0.0,
            "p95": float(np.quantile(a, 0.95)) if a else 0.0,
        }
    return {
        "los": stats(los_means),
        "los_p90": stats(p90s),
        "wait": stats(wait_means),
        "throughput": stats(thrs),
    }


@app.post("/api/simulate")
def simulate(inp: SimInput) -> dict:
    """Run a SimPy DES of the ED. Two modes: single scenario vs Monte-Carlo (multi-scenario).

    Units (single-scenario mode):
        baseline.{avg_los_min, p90_los_min, avg_wait_min}: minutes.
        baseline.throughput: integer count (patients completed during the run).
        config.duration_min: minutes (= duration_days × 24 × 60).
        scenario.*: same units as baseline, after applying user knobs.
        delta_pct.*: percentage 0–100 (relative change scenario vs baseline).
    Units (multi-scenario mode):
        runs[].avg_los_min, p90_los_min, avg_wait_min: minutes (per Monte-Carlo replication).
        scenarios[].mean_*: minutes (Monte-Carlo mean).
    """
    hourly, services, routing, caps, bottleneck = _sim_params()

    # Backward-compat single-scenario
    if inp.scenarios is None:
        extra = inp.extra_boxes or 0
        mult = inp.arrival_multiplier if inp.arrival_multiplier is not None else 1.0
        spd = inp.ioa_speedup or 0.0
        dd = inp.duration_days or 7
        duration_min = dd * 24 * 60
        baseline = _simulate_scenario(
            hourly, services, routing, dict(caps),
            ioa_speedup=0.0, arrival_mult=1.0,
            duration_min=duration_min, seed=7,
        )
        scen_caps = dict(caps)
        scen_caps[bottleneck] = caps[bottleneck] + extra
        scenario = _simulate_scenario(
            hourly, services, routing, scen_caps,
            ioa_speedup=spd, arrival_mult=mult,
            duration_min=duration_min, seed=7,
        )
        return {
            "baseline": baseline,
            "scenario": scenario,
            "config": {
                "routing": routing,
                "bottleneck": bottleneck,
                "baseline_capacity": caps,
                "scenario_capacity": scen_caps,
                "duration_min": duration_min,
            },
        }

    # Multi-scenario Monte Carlo
    n_runs = inp.n_runs
    # Use longest duration across scenarios for baseline
    max_duration = max((s.duration_days for s in inp.scenarios), default=7) * 24 * 60
    baseline = _mc_replications(hourly, services, routing, caps, 0.0, 1.0, max_duration, n_runs)

    out_scenarios = []
    for s in inp.scenarios:
        scen_caps = dict(caps)
        scen_caps[bottleneck] = caps[bottleneck] + s.extra_boxes
        st = _mc_replications(
            hourly, services, routing, scen_caps,
            s.ioa_speedup, s.arrival_multiplier, s.duration_days * 24 * 60, n_runs,
        )
        out_scenarios.append({
            "name": s.name,
            "stats": st,
            "capacity": scen_caps,
            "extra_boxes": s.extra_boxes,
            "arrival_multiplier": s.arrival_multiplier,
            "ioa_speedup": s.ioa_speedup,
            "duration_days": s.duration_days,
        })

    return {
        "baseline_mc": baseline,
        "scenarios_mc": out_scenarios,
        "n_runs": n_runs,
        "config": {
            "routing": routing,
            "bottleneck": bottleneck,
            "baseline_capacity": caps,
        },
    }


# ---------------- DIGITAL TWIN TRACE ----------------


class TraceInput(BaseModel):
    extra_boxes: int = Field(0, ge=0, le=10)
    arrival_multiplier: float = Field(1.0, ge=0.1, le=5.0)
    ioa_speedup: float = Field(0.0, ge=0.0, le=0.9)
    duration_hours: int = Field(24, ge=1, le=72)


@lru_cache(maxsize=1)
def _trace_params() -> tuple:
    d = _df()
    c = _cases().dropna(subset=["arrivee"])
    hourly = np.zeros(24)
    for ts in c["arrivee"]:
        hourly[ts.hour] += 1
    span_days = max(1.0, (c["arrivee"].max() - c["arrivee"].min()).total_seconds() / 86400.0)
    hourly = hourly / span_days

    top_locs = d["loc_local_libelle"].value_counts().head(8).index.tolist()

    services = {}
    for loc in top_locs:
        m = d.loc[d["loc_local_libelle"] == loc, "duration_min"].mean()
        services[loc] = float(m) if pd.notna(m) and 0 < m < 600 else 30.0

    # first-location distribution within top8
    first_counts = Counter()
    for seq in _cases()["sequence"]:
        if seq and seq[0] in top_locs:
            first_counts[seq[0]] += 1
    total_first = sum(first_counts.values()) or 1
    first_probs = {loc: first_counts.get(loc, 0) / total_first for loc in top_locs}
    # fallback if empty
    if sum(first_probs.values()) <= 0:
        first_probs = {loc: 1.0 / len(top_locs) for loc in top_locs}

    # transition matrix restricted to top8, plus implicit exit
    trans_counts: dict[str, Counter] = {loc: Counter() for loc in top_locs}
    for _, grp in d.groupby("DOSSIER_ID"):
        locs = grp["loc_local_libelle"].tolist()
        for i in range(len(locs) - 1):
            a, b = locs[i], locs[i + 1]
            if a in top_locs:
                if b in top_locs:
                    trans_counts[a][b] += 1
                else:
                    trans_counts[a]["__EXIT__"] += 1
        if locs and locs[-1] in top_locs:
            trans_counts[locs[-1]]["__EXIT__"] += 1
    trans_probs: dict[str, list[tuple[str, float]]] = {}
    for a, ctr in trans_counts.items():
        tot = sum(ctr.values()) or 1
        items = [(b, n / tot) for b, n in ctr.items()]
        if not any(b == "__EXIT__" for b, _ in items):
            items.append(("__EXIT__", 0.1))
        trans_probs[a] = items

    # capacities: observed max concurrent occupants (approximation) else heuristic
    caps: dict[str, int] = {}
    for loc in top_locs:
        sub = d[d["loc_local_libelle"] == loc].dropna(subset=["loc_heure_debut", "loc_heure_fin"])
        if len(sub) > 0:
            starts = sub["loc_heure_debut"].values
            ends = sub["loc_heure_fin"].values
            events = [(t, 1) for t in starts] + [(t, -1) for t in ends]
            events.sort()
            cur = 0
            mx = 0
            for _, v in events:
                cur += v
                if cur > mx:
                    mx = cur
            caps[loc] = max(2, min(mx, 20))
        else:
            caps[loc] = 3
        if "IOA" in loc or "TRI" in loc:
            caps[loc] = max(2, min(caps[loc], 4))
        elif "BOX" in loc:
            caps[loc] = max(caps[loc], 5)
        elif "SUTURE" in loc:
            caps[loc] = min(caps[loc], 3)

    # grid positions (3 cols)
    positions: dict[str, tuple[float, float]] = {}
    for i, loc in enumerate(top_locs):
        r = i // 3
        col = i % 3
        positions[loc] = ((col - 1) * 8.0, (r - 1) * 8.0)

    # bottleneck: prefer a BOX-type location (adding boxes is intuitive), else
    # fall back to the highest avg service time among top_locs.
    box_candidates = [l for l in top_locs if "BOX" in l]
    if box_candidates:
        bottleneck = max(box_candidates, key=lambda k: services[k])
    else:
        bottleneck = max(top_locs, key=lambda k: services[k])

    return hourly, top_locs, services, first_probs, trans_probs, caps, positions, bottleneck


@app.post("/api/simulate-trace")
def simulate_trace(inp: TraceInput) -> dict:
    """Detailed SimPy trace simulation that returns per-location queue/wait stats and time-series.

    Units:
        duration_min: minutes (= duration_hours × 60).
        stats_per_location[].avg_queue_len, max_queue_len: real / integer counts of queued patients.
        stats_per_location[].avg_wait_min, p90_wait_min, max_wait_min: minutes.
        stats_per_location[].pct_time_saturated: percentage 0–100 (share of run time at or above capacity).
        stats_per_location[].served, still_waiting: integer counts.
        timeseries.queue_total, in_service_total: integer counts (sampled every 5 min).
        timeseries.t_min: minutes since simulation start.
        events[].time_min: minutes since simulation start.
    """
    hourly, top_locs, services, first_probs, trans_probs, caps, positions, bottleneck = _trace_params()

    caps = dict(caps)
    raw_base_cap = caps[bottleneck]
    extra = int(inp.extra_boxes or 0)
    # Cap the number of visible base siblings for readability. Each visible
    # sibling then holds ceil(raw_base_cap / n_base_display) patients.
    n_base_display = min(raw_base_cap, 6)
    base_per_room = int(np.ceil(raw_base_cap / n_base_display))
    # Recompute the logical base capacity so totals stay consistent with
    # n_base_display rooms of size base_per_room.
    base_bottleneck_cap = base_per_room * n_base_display
    caps[bottleneck] = base_bottleneck_cap + extra

    n_siblings = n_base_display + extra
    sibling_ids: list[str] = []
    for i in range(n_siblings):
        if i == 0:
            sibling_ids.append(bottleneck)
        elif i < n_base_display:
            sibling_ids.append(f"{bottleneck} #{i + 1}")
        else:
            sibling_ids.append(f"{bottleneck} (ext {i - n_base_display + 1})")
    sibling_is_ext = [i >= n_base_display for i in range(n_siblings)]
    sibling_caps = [base_per_room] * n_base_display + [1] * extra

    duration_min = int(inp.duration_hours * 60)
    rng = np.random.default_rng(7)
    random.seed(7)

    env = simpy.Environment()
    # For the bottleneck, create one Resource per sibling (capacity=1 each).
    # For other locations, keep a single Resource.
    resources: dict[str, simpy.Resource] = {}
    for loc in top_locs:
        if loc == bottleneck:
            continue
        resources[loc] = simpy.Resource(env, capacity=caps[loc])
    sibling_resources = [simpy.Resource(env, capacity=sibling_caps[i]) for i in range(n_siblings)]
    events: list[dict] = []
    next_pid = [1]
    sibling_rr = [0]

    first_locs_arr = list(first_probs.keys())
    first_probs_arr = np.array([first_probs[l] for l in first_locs_arr], dtype=float)
    first_probs_arr = first_probs_arr / first_probs_arr.sum()

    def sample_next(loc: str) -> str:
        items = trans_probs.get(loc, [("__EXIT__", 1.0)])
        locs = [b for b, _ in items]
        probs = np.array([p for _, p in items], dtype=float)
        probs = probs / probs.sum()
        return str(rng.choice(locs, p=probs))

    def patient_proc(env, pid: int, start_loc: str):
        cur = start_loc
        hops = 0
        while True:
            if cur == bottleneck:
                # pick sibling with fewest queued (len_users + len_queue) and
                # rotate ties for visual distribution
                def sibling_load(i: int) -> tuple[int, int]:
                    r = sibling_resources[i]
                    return (len(r.users) + len(r.queue), (i - sibling_rr[0]) % n_siblings)
                best = min(range(n_siblings), key=sibling_load)
                sibling_rr[0] = (best + 1) % n_siblings
                display_loc = sibling_ids[best]
                res = sibling_resources[best]
            else:
                display_loc = cur
                res = resources[cur]
            events.append({"t": round(env.now, 2), "patient_id": pid, "type": "arrive_queue", "location": display_loc})
            req = res.request()
            yield req
            events.append({"t": round(env.now, 2), "patient_id": pid, "type": "start_service", "location": display_loc})
            mean_s = services[cur]
            if "IOA" in cur:
                mean_s *= max(0.1, 1.0 - inp.ioa_speedup)
            dur = float(np.clip(rng.exponential(mean_s), 1.0, 600.0))
            yield env.timeout(dur)
            events.append({"t": round(env.now, 2), "patient_id": pid, "type": "depart", "location": display_loc})
            res.release(req)
            hops += 1
            nxt = sample_next(cur)
            if nxt == "__EXIT__" or hops >= 6:
                mode = rng.choice(
                    ["Retour à domicile", "Hospitalisation sur site", "Inconnu"],
                    p=[0.65, 0.25, 0.10],
                )
                events.append({"t": round(env.now, 2), "patient_id": pid, "type": "exit", "exit_mode": str(mode)})
                return
            cur = nxt

    def arrivals(env):
        while True:
            h = int(env.now // 60) % 24
            rate_per_min = max(1e-6, hourly[h] * inp.arrival_multiplier / 60.0)
            yield env.timeout(rng.exponential(1.0 / rate_per_min))
            if env.now >= duration_min:
                return
            start_loc = str(rng.choice(first_locs_arr, p=first_probs_arr))
            pid = next_pid[0]
            next_pid[0] += 1
            env.process(patient_proc(env, pid, start_loc))

    env.process(arrivals(env))
    env.run(until=duration_min)

    events.sort(key=lambda e: (e["t"], 0 if e["type"] == "arrive_queue" else 1 if e["type"] == "start_service" else 2))

    # Build the effective list of display location ids: non-bottleneck locs +
    # sibling ids (each sibling is a visible room of capacity 1).
    other_locs = [loc for loc in top_locs if loc != bottleneck]
    display_ids: list[str] = other_locs + sibling_ids
    display_caps: dict[str, int] = {loc: caps[loc] for loc in other_locs}
    for i, sid in enumerate(sibling_ids):
        display_caps[sid] = sibling_caps[i]

    # ---- post-run stats from event stream ----
    top_locs_stats = display_ids
    caps_stats = display_caps
    per_loc_waits: dict[str, list[float]] = {loc: [] for loc in top_locs_stats}
    per_loc_served: dict[str, int] = {loc: 0 for loc in top_locs_stats}
    per_loc_still_waiting: dict[str, int] = {loc: 0 for loc in top_locs_stats}
    # track arrive_queue time per (pid, loc)
    pending_arrive: dict[tuple[int, str], float] = {}
    # occupancy timelines: queue len & in_service per location
    # use step changes
    timeline_changes: dict[str, list[tuple[float, int, int]]] = {loc: [(0.0, 0, 0)] for loc in top_locs_stats}
    q_cur: dict[str, int] = {loc: 0 for loc in top_locs_stats}
    s_cur: dict[str, int] = {loc: 0 for loc in top_locs_stats}

    def push_change(loc: str, t: float) -> None:
        timeline_changes[loc].append((t, q_cur[loc], s_cur[loc]))

    stats_set = set(top_locs_stats)
    for e in events:
        t = float(e["t"])
        loc = e.get("location")
        if e["type"] == "arrive_queue" and loc in stats_set:
            pending_arrive[(e["patient_id"], loc)] = t
            q_cur[loc] += 1
            push_change(loc, t)
        elif e["type"] == "start_service" and loc in stats_set:
            k = (e["patient_id"], loc)
            if k in pending_arrive:
                per_loc_waits[loc].append(max(0.0, t - pending_arrive.pop(k)))
            q_cur[loc] = max(0, q_cur[loc] - 1)
            s_cur[loc] += 1
            push_change(loc, t)
        elif e["type"] == "depart" and loc in stats_set:
            s_cur[loc] = max(0, s_cur[loc] - 1)
            per_loc_served[loc] += 1
            push_change(loc, t)

    for (_pid, loc), _ in pending_arrive.items():
        if loc in stats_set:
            per_loc_still_waiting[loc] += 1

    # sampled timeseries every 5 min
    sample_dt = 5
    ts_t = list(range(0, duration_min + 1, sample_dt))
    # iterate changes per location to get step values at sample times
    def step_values(changes: list[tuple[float, int, int]]) -> tuple[list[int], list[int]]:
        qs: list[int] = []
        ss: list[int] = []
        idx = 0
        cq = 0
        cs = 0
        for t in ts_t:
            while idx < len(changes) and changes[idx][0] <= t:
                _, cq, cs = changes[idx]
                idx += 1
            qs.append(cq)
            ss.append(cs)
        return qs, ss

    loc_series: dict[str, tuple[list[int], list[int]]] = {
        loc: step_values(timeline_changes[loc]) for loc in top_locs_stats
    }
    queue_total = [sum(loc_series[loc][0][i] for loc in top_locs_stats) for i in range(len(ts_t))]
    in_service_total = [sum(loc_series[loc][1][i] for loc in top_locs_stats) for i in range(len(ts_t))]

    def pct_time_saturated(loc: str) -> float:
        cap = caps_stats[loc]
        changes = timeline_changes[loc]
        if len(changes) < 2:
            return 0.0
        total = 0.0
        sat = 0.0
        prev_t = changes[0][0]
        prev_s = changes[0][2]
        for t, _q, s in changes[1:]:
            dt = t - prev_t
            total += dt
            if prev_s >= cap:
                sat += dt
            prev_t, prev_s = t, s
        # trailing to duration
        dt_tail = max(0.0, duration_min - prev_t)
        total += dt_tail
        if prev_s >= cap:
            sat += dt_tail
        return 100.0 * sat / total if total > 0 else 0.0

    def avg_queue_len(loc: str) -> tuple[float, int]:
        changes = timeline_changes[loc]
        if len(changes) < 2:
            return 0.0, 0
        total = 0.0
        area = 0.0
        mx = 0
        prev_t = changes[0][0]
        prev_q = changes[0][1]
        for t, q, _s in changes[1:]:
            dt = t - prev_t
            total += dt
            area += prev_q * dt
            if prev_q > mx:
                mx = prev_q
            prev_t, prev_q = t, q
        dt_tail = max(0.0, duration_min - prev_t)
        total += dt_tail
        area += prev_q * dt_tail
        if prev_q > mx:
            mx = prev_q
        return (area / total if total > 0 else 0.0), mx

    stats_per_location: list[dict] = []
    for loc in top_locs_stats:
        waits = per_loc_waits[loc]
        avg_q, max_q = avg_queue_len(loc)
        stats_per_location.append({
            "id": loc,
            "name": loc,
            "avg_queue_len": round(avg_q, 2),
            "max_queue_len": int(max_q),
            "avg_wait_min": round(float(np.mean(waits)), 2) if waits else 0.0,
            "p90_wait_min": round(float(np.quantile(waits, 0.9)), 2) if waits else 0.0,
            "max_wait_min": round(float(np.max(waits)), 2) if waits else 0.0,
            "pct_time_saturated": round(pct_time_saturated(loc), 2),
            "served": int(per_loc_served[loc]),
            "still_waiting": int(per_loc_still_waiting[loc]),
        })

    # cap events at 20000
    max_events = 20000
    if len(events) > max_events:
        step = len(events) / max_events
        idxs = sorted({int(i * step) for i in range(max_events)})
        events = [events[i] for i in idxs]

    # Re-layout: place the non-bottleneck rooms on a grid, and the bottleneck
    # sibling cluster on its own dedicated row so siblings don't overlap.
    locations_out: list[dict] = []
    cluster_y = -14.0
    # non-bottleneck locations on two rows (at y = 0 and y = +8)
    for i, loc in enumerate(other_locs):
        col = i % 3
        row = i // 3
        x = (col - 1) * 8.0
        y = row * 8.0 + 2.0
        locations_out.append({
            "id": loc,
            "name": loc,
            "group": loc,
            "base_name": loc,
            "is_extension": False,
            "capacity": int(caps[loc]),
            "x": float(x),
            "y": float(y),
        })
    # siblings of the bottleneck — lay them out on their own strip
    for i, sid in enumerate(sibling_ids):
        offset = (i - (n_siblings - 1) / 2.0) * 6.5
        locations_out.append({
            "id": sid,
            "name": sid,
            "group": bottleneck,
            "base_name": bottleneck,
            "is_extension": bool(sibling_is_ext[i]),
            "capacity": int(sibling_caps[i]),
            "x": float(offset),
            "y": float(cluster_y),
        })

    return {
        "locations": locations_out,
        "events": events,
        "duration_min": duration_min,
        "stats_per_location": stats_per_location,
        "timeseries": {
            "t": ts_t,
            "queue_total": queue_total,
            "in_service_total": in_service_total,
        },
        "bottleneck_group": bottleneck,
        "extra_boxes": extra,
    }


# ---------------- REAL-DATA TRACE REPLAY ----------------


class RealTraceInput(BaseModel):
    date_from: str
    date_to: str
    exit_mode: Optional[str] = None
    top_locations: int = Field(8, ge=2, le=20)


def _grid_positions(locs: list[str]) -> dict[str, tuple[float, float]]:
    positions: dict[str, tuple[float, float]] = {}
    for i, loc in enumerate(locs):
        r = i // 3
        col = i % 3
        positions[loc] = ((col - 1) * 8.0, (r - 1) * 8.0)
    return positions


def _observed_max_concurrent(sub: pd.DataFrame) -> int:
    s = sub.dropna(subset=["loc_heure_debut", "loc_heure_fin"])
    if len(s) == 0:
        return 1
    evs = [(t, 1) for t in s["loc_heure_debut"].values] + [
        (t, -1) for t in s["loc_heure_fin"].values
    ]
    evs.sort()
    cur = 0
    mx = 0
    for _, v in evs:
        cur += v
        if cur > mx:
            mx = cur
    return max(1, mx)


def _ts_stats_from_events(
    events: list[dict],
    top_locs: list[str],
    caps: dict[str, int],
    duration_min: int,
) -> tuple[list[dict], dict]:
    per_loc_waits: dict[str, list[float]] = {loc: [] for loc in top_locs}
    per_loc_served: dict[str, int] = {loc: 0 for loc in top_locs}
    per_loc_still_waiting: dict[str, int] = {loc: 0 for loc in top_locs}
    pending_arrive: dict[tuple[int, str], float] = {}
    timeline_changes: dict[str, list[tuple[float, int, int]]] = {
        loc: [(0.0, 0, 0)] for loc in top_locs
    }
    q_cur: dict[str, int] = {loc: 0 for loc in top_locs}
    s_cur: dict[str, int] = {loc: 0 for loc in top_locs}

    def push_change(loc: str, t: float) -> None:
        timeline_changes[loc].append((t, q_cur[loc], s_cur[loc]))

    for e in events:
        t = float(e["t"])
        loc = e.get("location")
        if e["type"] == "arrive_queue" and loc in top_locs:
            pending_arrive[(e["patient_id"], loc)] = t
            q_cur[loc] += 1
            push_change(loc, t)
        elif e["type"] == "start_service" and loc in top_locs:
            k = (e["patient_id"], loc)
            if k in pending_arrive:
                per_loc_waits[loc].append(max(0.0, t - pending_arrive.pop(k)))
            q_cur[loc] = max(0, q_cur[loc] - 1)
            s_cur[loc] += 1
            push_change(loc, t)
        elif e["type"] == "depart" and loc in top_locs:
            s_cur[loc] = max(0, s_cur[loc] - 1)
            per_loc_served[loc] += 1
            push_change(loc, t)

    for (_pid, loc), _ in pending_arrive.items():
        if loc in top_locs:
            per_loc_still_waiting[loc] += 1

    sample_dt = 5
    ts_t = list(range(0, duration_min + 1, sample_dt))

    def step_values(changes: list[tuple[float, int, int]]) -> tuple[list[int], list[int]]:
        qs: list[int] = []
        ss: list[int] = []
        idx = 0
        cq = 0
        cs = 0
        for t in ts_t:
            while idx < len(changes) and changes[idx][0] <= t:
                _, cq, cs = changes[idx]
                idx += 1
            qs.append(cq)
            ss.append(cs)
        return qs, ss

    loc_series = {loc: step_values(timeline_changes[loc]) for loc in top_locs}
    queue_total = [sum(loc_series[loc][0][i] for loc in top_locs) for i in range(len(ts_t))]
    in_service_total = [sum(loc_series[loc][1][i] for loc in top_locs) for i in range(len(ts_t))]

    def pct_time_saturated(loc: str) -> float:
        cap = caps[loc]
        changes = timeline_changes[loc]
        if len(changes) < 2:
            return 0.0
        total = 0.0
        sat = 0.0
        prev_t = changes[0][0]
        prev_s = changes[0][2]
        for t, _q, s in changes[1:]:
            dt = t - prev_t
            total += dt
            if prev_s >= cap:
                sat += dt
            prev_t, prev_s = t, s
        dt_tail = max(0.0, duration_min - prev_t)
        total += dt_tail
        if prev_s >= cap:
            sat += dt_tail
        return 100.0 * sat / total if total > 0 else 0.0

    def avg_queue_len(loc: str) -> tuple[float, int]:
        changes = timeline_changes[loc]
        if len(changes) < 2:
            return 0.0, 0
        total = 0.0
        area = 0.0
        mx = 0
        prev_t = changes[0][0]
        prev_q = changes[0][1]
        for t, q, _s in changes[1:]:
            dt = t - prev_t
            total += dt
            area += prev_q * dt
            if prev_q > mx:
                mx = prev_q
            prev_t, prev_q = t, q
        dt_tail = max(0.0, duration_min - prev_t)
        total += dt_tail
        area += prev_q * dt_tail
        if prev_q > mx:
            mx = prev_q
        return (area / total if total > 0 else 0.0), mx

    stats_per_location: list[dict] = []
    for loc in top_locs:
        waits = per_loc_waits[loc]
        avg_q, max_q = avg_queue_len(loc)
        stats_per_location.append({
            "id": loc,
            "name": loc,
            "avg_queue_len": round(avg_q, 2),
            "max_queue_len": int(max_q),
            "avg_wait_min": round(float(np.mean(waits)), 2) if waits else 0.0,
            "p90_wait_min": round(float(np.quantile(waits, 0.9)), 2) if waits else 0.0,
            "max_wait_min": round(float(np.max(waits)), 2) if waits else 0.0,
            "pct_time_saturated": round(pct_time_saturated(loc), 2),
            "served": int(per_loc_served[loc]),
            "still_waiting": int(per_loc_still_waiting[loc]),
        })

    return stats_per_location, {
        "t": ts_t,
        "queue_total": queue_total,
        "in_service_total": in_service_total,
    }


@app.get("/api/dataset-range")
def dataset_range() -> dict:
    """Min/max dates available in the loaded dataset.

    Units:
        min, max: ISO date strings (YYYY-MM-DD), naive (dataset-local time).
    """
    d = _df()
    mn = d["loc_heure_debut"].min()
    mx = d["loc_heure_debut"].max()
    return {
        "min": mn.strftime("%Y-%m-%d") if pd.notna(mn) else "",
        "max": mx.strftime("%Y-%m-%d") if pd.notna(mx) else "",
    }


@app.post("/api/real-trace")
def real_trace(inp: RealTraceInput) -> dict:
    """Replay observed events and emit the same shape as /api/simulate-trace (queues, waits, time-series).

    Same units as /api/simulate-trace. Built directly from CSV events: arrival ≈ first event time,
    service start ≈ loc_heure_debut, service end ≈ loc_heure_fin (or +1 min fallback if missing).
    """
    d = _df()
    c = _cases()
    try:
        dt_from = pd.to_datetime(inp.date_from)
        dt_to = pd.to_datetime(inp.date_to)
    except Exception:
        raise HTTPException(400, "Invalid date_from/date_to")
    if dt_to <= dt_from:
        raise HTTPException(400, "date_to must be after date_from")

    sub = d[(d["loc_heure_debut"] >= dt_from) & (d["loc_heure_debut"] < dt_to)].copy()
    if inp.exit_mode:
        ids = set(
            c[c["mode_sortie"].fillna("Inconnu") == inp.exit_mode]["DOSSIER_ID"].tolist()
        )
        sub = sub[sub["DOSSIER_ID"].isin(ids)]

    if len(sub) == 0:
        return {
            "locations": [],
            "events": [],
            "duration_min": int((dt_to - dt_from).total_seconds() / 60.0),
            "stats_per_location": [],
            "timeseries": {"t": [0], "queue_total": [0], "in_service_total": [0]},
        }

    top_locs = (
        sub["loc_local_libelle"].value_counts().head(inp.top_locations).index.tolist()
    )
    sub = sub[sub["loc_local_libelle"].isin(top_locs)].copy()

    positions = _grid_positions(top_locs)

    caps: dict[str, int] = {}
    for loc in top_locs:
        caps[loc] = _observed_max_concurrent(sub[sub["loc_local_libelle"] == loc])

    t0 = sub["loc_heure_debut"].min()
    duration_min = int(np.ceil((dt_to - t0).total_seconds() / 60.0))
    duration_min = max(duration_min, 1)

    sub = sub.sort_values(["DOSSIER_ID", "loc_heure_debut"]).reset_index(drop=True)

    dossier_to_pid: dict = {}
    next_pid = 1
    events: list[dict] = []

    exit_mode_by_dossier = dict(
        zip(c["DOSSIER_ID"].tolist(), c["mode_sortie"].fillna("Inconnu").tolist())
    )
    date_sortie_by_dossier = dict(zip(c["DOSSIER_ID"].tolist(), c["sortie"].tolist()))

    for dossier_id, grp in sub.groupby("DOSSIER_ID", sort=False):
        if dossier_id not in dossier_to_pid:
            dossier_to_pid[dossier_id] = next_pid
            next_pid += 1
        pid = dossier_to_pid[dossier_id]
        last_depart_t = 0.0
        last_loc = None
        for _, row in grp.iterrows():
            loc = row["loc_local_libelle"]
            t_arrive = (row["loc_heure_debut"] - t0).total_seconds() / 60.0
            end_ts = row["loc_heure_fin"]
            if pd.isna(end_ts):
                t_depart = t_arrive + 1.0
            else:
                t_depart = (end_ts - t0).total_seconds() / 60.0
            if t_depart < t_arrive:
                t_depart = t_arrive + 0.5
            t_arrive = max(0.0, t_arrive)
            t_depart = max(t_arrive + 0.1, t_depart)
            events.append({"t": round(t_arrive, 2), "patient_id": pid, "type": "arrive_queue", "location": loc})
            events.append({"t": round(t_arrive, 2), "patient_id": pid, "type": "start_service", "location": loc})
            events.append({"t": round(t_depart, 2), "patient_id": pid, "type": "depart", "location": loc})
            last_depart_t = max(last_depart_t, t_depart)
            last_loc = loc
        if last_loc is not None:
            exit_mode = exit_mode_by_dossier.get(dossier_id, "Inconnu") or "Inconnu"
            ds = date_sortie_by_dossier.get(dossier_id)
            if ds is not None and pd.notna(ds):
                t_exit = (ds - t0).total_seconds() / 60.0
                if t_exit < last_depart_t:
                    t_exit = last_depart_t
            else:
                t_exit = last_depart_t
            events.append({
                "t": round(t_exit, 2),
                "patient_id": pid,
                "type": "exit",
                "exit_mode": str(exit_mode),
            })

    events.sort(key=lambda e: (e["t"], 0 if e["type"] == "arrive_queue" else 1 if e["type"] == "start_service" else 2 if e["type"] == "depart" else 3))

    stats_per_location, timeseries = _ts_stats_from_events(events, top_locs, caps, duration_min)

    max_events = 20000
    if len(events) > max_events:
        step = len(events) / max_events
        idxs = sorted({int(i * step) for i in range(max_events)})
        events = [events[i] for i in idxs]

    locations_out = []
    for loc in top_locs:
        x, y = positions[loc]
        locations_out.append({
            "id": loc,
            "name": loc,
            "group": loc,
            "base_name": loc,
            "is_extension": False,
            "capacity": int(caps[loc]),
            "x": float(x),
            "y": float(y),
        })

    return {
        "locations": locations_out,
        "events": events,
        "duration_min": duration_min,
        "stats_per_location": stats_per_location,
        "timeseries": timeseries,
        "bottleneck_group": None,
        "extra_boxes": 0,
    }


# ---------------- COMMAND CENTER ----------------

@app.get("/api/command-center")
def command_center(f: Filters = Depends(_filters_dep)) -> dict:
    """Aggregated payload for the live Monitoring screen.

    Units:
        kpis.total_patients, total_dossiers: integer counts.
        kpis.avg_los_min, p10_los_min, p90_los_min: minutes.
        kpis.throughput_per_day: real (cases ÷ calendar days).
        kpis.hospit_pct: percentage 0–100.
        hourly_arrivals[].hour: 0..23. count: integer. avg_los: minutes.
        los_distribution[].count: integer (cases falling in that minute bin).
        bottlenecks[].avg_duration_min: minutes. n_visits: integer (events).
        exit_modes[].pct: percentage 0–100. count: integer.
        recent_activity[]: most recent dossiers (limited list).
    """
    c = filter_cases(_cases(), f)
    df = _df()
    total = len(c)

    los = c["los_min"].dropna()
    avg_los = float(los.mean()) if len(los) > 0 else 0.0
    p90_los = float(los.quantile(0.90)) if len(los) > 0 else 0.0
    p10_los = float(los.quantile(0.10)) if len(los) > 0 else 0.0

    c_dated = c.dropna(subset=["arrivee"])
    span_days = max(
        1.0,
        (c_dated["arrivee"].max() - c_dated["arrivee"].min()).total_seconds() / 86400,
    ) if len(c_dated) > 0 else 1.0
    throughput = total / span_days

    hospit_mask = c["mode_sortie"].fillna("").str.lower().str.contains(
        "hospit|transfert", na=False
    )
    hospit_pct = float(hospit_mask.mean() * 100) if total > 0 else 0.0

    # Hourly arrivals (raw counts per hour across full dataset)
    hourly = []
    for h in range(24):
        mask = c_dated["arrivee"].dt.hour == h
        sub = c[mask]
        hourly.append({
            "hour": h,
            "count": int(mask.sum()),
            "avg_los": round(_safe(float(sub["los_min"].mean())) or 0.0, 1) if len(sub) > 0 else 0.0,
        })

    # LOS distribution
    bins = [0, 30, 60, 120, 180, 240, 360, 480, 720, float("inf")]
    bin_labels = ["<30m", "30m–1h", "1h–2h", "2h–3h", "3h–4h", "4h–6h", "6h–8h", "8h–12h", ">12h"]
    los_dist = []
    for i in range(len(bins) - 1):
        lo, hi = bins[i], bins[i + 1]
        cnt = int(((los >= lo) & (los < hi)).sum())
        los_dist.append({"label": bin_labels[i], "count": cnt})

    # Daily trend — full range, no artificial cap
    daily_trend: list = []
    if len(c_dated) > 0:
        tmp = c_dated.copy()
        tmp["date"] = tmp["arrivee"].dt.date
        by_day = (
            tmp.groupby("date")
            .agg(count=("DOSSIER_ID", "size"), avg_los=("los_min", "mean"))
            .reset_index()
            .sort_values("date")
        )
        for _, row in by_day.iterrows():
            daily_trend.append({
                "date": str(row["date"]),
                "count": int(row["count"]),
                "avg_los": round(_safe(row["avg_los"]) or 0.0, 1),
            })

    # Bottlenecks (top locations by avg duration)
    top_locs = df["loc_local_libelle"].value_counts().head(10).index.tolist()
    bottlenecks = []
    for loc in top_locs:
        sub = df[df["loc_local_libelle"] == loc]
        avg_dur = float(sub["duration_min"].mean()) if len(sub) > 0 else 0.0
        bottlenecks.append({
            "location": loc,
            "avg_duration_min": round(_safe(avg_dur) or 0.0, 1),
            "n_visits": int(len(sub)),
        })
    bottlenecks.sort(key=lambda x: x["avg_duration_min"], reverse=True)

    # Exit modes — pct is in 0–100 to match all other "*_pct" fields
    modes = c["mode_sortie"].fillna("Inconnu").value_counts().head(6)
    exit_modes = [
        {"mode": m, "count": int(cnt), "pct": round(100.0 * cnt / max(1, total), 1)}
        for m, cnt in modes.items()
    ]

    # Recent activity (last 40 cases)
    recent = c_dated.sort_values("arrivee", ascending=False).head(40)
    activity = []
    for _, row in recent.iterrows():
        activity.append({
            "dossier_id": str(row["DOSSIER_ID"]),
            "arrivee": row["arrivee"].isoformat() if pd.notna(row["arrivee"]) else None,
            "los_min": _safe(row["los_min"]),
            "mode_sortie": str(row["mode_sortie"]) if pd.notna(row.get("mode_sortie")) else "—",
        })

    return {
        "kpis": {
            "total_patients": total,
            "avg_los_min": round(_safe(avg_los) or 0.0, 1),
            "p90_los_min": round(_safe(p90_los) or 0.0, 1),
            "p10_los_min": round(_safe(p10_los) or 0.0, 1),
            "throughput_per_day": round(throughput, 1),
            "hospit_pct": round(hospit_pct, 1),
        },
        "hourly_arrivals": hourly,
        "los_distribution": los_dist,
        "daily_trend": daily_trend,
        "bottlenecks": bottlenecks,
        "exit_modes": exit_modes,
        "recent_activity": activity,
    }


# ──────────────── ADVANCED ANALYTICS ──────────────────────────────────────────

@app.get("/api/advanced-analytics")
def advanced_analytics(f: Filters = Depends(_filters_dep)) -> dict:
    """Deep analytical view (flow metrics, heatmap, weekday/monthly patterns, UHCD/SAUV trends).

    Units:
        flow_metrics.delai_premier_soin.{avg, p25, p75, p90}: minutes (time from arrival to first care event).
        flow_metrics.attente_sortie.{avg_min, p90_min}: minutes (post-care idle before exit).
        flow_metrics.imagerie.{rate_pct, avg_min}: rate_pct percentage 0–100; avg_min minutes.
        flow_metrics.reorientation_rate: percentage 0–100.
        location_heatmap.matrix[24][N_locs]: integer counts.
        location_stats[].{avg_min, median_min, p90_min}: minutes.
        weekday_pattern[].{count, avg_los, hospit_pct}: count integer, avg_los minutes, hospit_pct 0–100.
        monthly_pattern[].{count, avg_los}: count integer, avg_los minutes.
        exit_by_hour[]: integer counts per hour.
        uhcd_stats.{n_dossiers, pct_of_total, avg_min, median_min}: counts / 0–100 / minutes.
        sauv_trend[].n_patients: integer.
    """
    c = filter_cases(_cases(), f)
    df = filter_df(_df(), f, _cases())
    total = len(c)

    c_dated = c.dropna(subset=["arrivee"]).copy()
    c_dated["hospit"] = (
        c_dated["mode_sortie"].fillna("").str.lower().str.contains("hospit", na=False)
    )

    # ── 1. Flow metrics ──────────────────────────────────────────────────────
    WAIT_LOCS = {
        "ATTENTE POST-TRI", "ATTENTE EXAMEN", "ATTENTE SORTIE",
        "ATTENTE PED POST-TRI IOA", "ATTENTE PED", "ATTENTE TRI-IOA",
        "REORIENTATION",
    }
    first_soin = (
        df[~df["loc_local_libelle"].isin(WAIT_LOCS)]
        .groupby("DOSSIER_ID")["loc_heure_debut"]
        .min()
        .reset_index(name="first_soin_time")
    )
    c_soin = c_dated.merge(first_soin, on="DOSSIER_ID", how="left")
    c_soin["delai_min"] = (
        c_soin["first_soin_time"] - c_soin["arrivee"]
    ).dt.total_seconds() / 60.0
    delai = c_soin["delai_min"].dropna()
    delai = delai[(delai >= 0) & (delai < 1440)]

    att_sortie_dur = df[df["loc_local_libelle"] == "ATTENTE SORTIE"]["duration_min"].dropna()
    imagerie_dur = df[df["loc_local_libelle"] == "IMAGERIE"]["duration_min"].dropna()
    reorio_count = int(c["sequence"].apply(lambda s: "REORIENTATION" in s).sum())

    def _stat(s: pd.Series) -> dict:
        if len(s) == 0:
            return {"mean": 0, "median": 0, "p90": 0, "n": 0}
        return {
            "mean":   round(float(s.mean()), 1),
            "median": round(float(s.median()), 1),
            "p90":    round(float(s.quantile(0.9)), 1),
            "n":      int(len(s)),
        }

    flow_metrics = {
        "delai_premier_soin": _stat(delai),
        "attente_sortie": {
            **_stat(att_sortie_dur),
            "n_visits": int(len(att_sortie_dur)),
            "avg_min":  round(float(att_sortie_dur.mean()), 1) if len(att_sortie_dur) > 0 else 0,
            "p90_min":  round(float(att_sortie_dur.quantile(0.9)), 1) if len(att_sortie_dur) > 0 else 0,
        },
        "imagerie": {
            **_stat(imagerie_dur),
            "n_visits": int(len(imagerie_dur)),
            "avg_min":  round(float(imagerie_dur.mean()), 1) if len(imagerie_dur) > 0 else 0,
            "p90_min":  round(float(imagerie_dur.quantile(0.9)), 1) if len(imagerie_dur) > 0 else 0,
        },
        "reorientation_rate":  round(reorio_count / max(1, total) * 100, 1),
        "reorientation_count": reorio_count,
    }

    # ── 2. Location heatmap (top 10 locs × 24h) ──────────────────────────────
    top_locs = df["loc_local_libelle"].value_counts().head(10).index.tolist()
    df_top = df[df["loc_local_libelle"].isin(top_locs)].copy()
    df_top["hour"] = df_top["loc_heure_debut"].dt.hour

    matrix: list[list[int]] = []
    for loc in top_locs:
        row_df = df_top[df_top["loc_local_libelle"] == loc]
        matrix.append([int((row_df["hour"] == h).sum()) for h in range(24)])

    hmax = max((max(r) for r in matrix if r), default=1)
    location_heatmap = {"locations": top_locs, "matrix": matrix, "max": hmax}

    # ── 3. Location stats (top 12 by visit count) ────────────────────────────
    location_stats: list[dict] = []
    for loc in df["loc_local_libelle"].value_counts().head(12).index.tolist():
        sub = df[df["loc_local_libelle"] == loc]["duration_min"].dropna()
        if len(sub) < 5:
            continue
        location_stats.append({
            "location":   loc,
            "n_visits":   int(len(sub)),
            "avg_min":    round(float(sub.mean()), 1),
            "median_min": round(float(sub.median()), 1),
            "p90_min":    round(float(sub.quantile(0.9)), 1),
        })
    location_stats.sort(key=lambda x: x["median_min"], reverse=True)

    # ── 4. Weekday pattern ───────────────────────────────────────────────────
    DOW = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"]
    weekday_pattern: list[dict] = []
    for d in range(7):
        mask = c_dated["arrivee"].dt.dayofweek == d
        sub = c_dated[mask]
        weekday_pattern.append({
            "day":        DOW[d],
            "count":      int(len(sub)),
            "avg_los":    round(float(sub["los_min"].mean()), 1) if len(sub) > 0 else 0.0,
            "hospit_pct": round(float(sub["hospit"].mean() * 100), 1) if len(sub) > 0 else 0.0,
        })

    # ── 5. Monthly pattern ───────────────────────────────────────────────────
    MONTHS = ["Jan","Fév","Mar","Avr","Mai","Jun","Jul","Aoû","Sep","Oct","Nov","Déc"]
    monthly_pattern: list[dict] = []
    for m in range(1, 13):
        mask = c_dated["arrivee"].dt.month == m
        sub = c_dated[mask]
        monthly_pattern.append({
            "month":   MONTHS[m - 1],
            "count":   int(len(sub)),
            "avg_los": round(float(sub["los_min"].mean()), 1) if len(sub) > 0 else 0.0,
        })

    # ── 6. Exit by hour (sortie time) ────────────────────────────────────────
    c_sortie = c.dropna(subset=["sortie"])
    exit_by_hour: list[dict] = []
    for h in range(24):
        mask = c_sortie["sortie"].dt.hour == h
        sub = c_sortie[mask]
        ret = int(sub["mode_sortie"].fillna("").str.lower().str.contains("domicile", na=False).sum())
        hos = int(sub["mode_sortie"].fillna("").str.lower().str.contains("hospit", na=False).sum())
        exit_by_hour.append({
            "hour": h,
            "retour_domicile": ret,
            "hospitalisation":  hos,
            "total": int(len(sub)),
        })

    # ── 7. UHCD stats ────────────────────────────────────────────────────────
    uhcd_df = df[df["loc_local_libelle"].str.contains("UHCD", na=False)].copy()
    uhcd_dossiers = int(uhcd_df["DOSSIER_ID"].nunique())
    uhcd_dur = uhcd_df["duration_min"].dropna()
    uhcd_df["month_key"] = uhcd_df["loc_heure_debut"].dt.to_period("M")
    uhcd_monthly: list[dict] = []
    if len(uhcd_df) > 0:
        for _, row in (
            uhcd_df.groupby("month_key")["DOSSIER_ID"].nunique().reset_index()
        ).iterrows():
            uhcd_monthly.append({"month": str(row["month_key"]), "count": int(row["DOSSIER_ID"])})

    uhcd_stats = {
        "n_dossiers":   uhcd_dossiers,
        "pct_of_total": round(uhcd_dossiers / max(1, total) * 100, 1),
        "avg_min":      round(float(uhcd_dur.mean()), 1) if len(uhcd_dur) > 0 else 0,
        "median_min":   round(float(uhcd_dur.median()), 1) if len(uhcd_dur) > 0 else 0,
        "monthly_trend": uhcd_monthly,
    }

    # ── 8. SAUV trend (monthly) ──────────────────────────────────────────────
    sauv_df = df[df["loc_local_libelle"].str.contains("SAUV", na=False)].copy()
    sauv_df["month_key"] = sauv_df["loc_heure_debut"].dt.to_period("M")
    sauv_trend: list[dict] = []
    if len(sauv_df) > 0:
        for _, row in (
            sauv_df.groupby("month_key")["DOSSIER_ID"].nunique().reset_index()
        ).iterrows():
            sauv_trend.append({"month": str(row["month_key"]), "n_patients": int(row["DOSSIER_ID"])})

    return {
        "flow_metrics":    flow_metrics,
        "location_heatmap": location_heatmap,
        "location_stats":  location_stats,
        "weekday_pattern": weekday_pattern,
        "monthly_pattern": monthly_pattern,
        "exit_by_hour":    exit_by_hour,
        "uhcd_stats":      uhcd_stats,
        "sauv_trend":      sauv_trend,
    }


# ---------------- PATIENT JOURNEY ----------------

@app.get("/api/patients")
def list_patients(
    search: str = Query("", max_length=100),
    limit: int = Query(2000, ge=1, le=5000),
    los_min_min: Optional[float] = Query(None),
    los_max_min: Optional[float] = Query(None),
    f: Filters = Depends(_filters_dep),
):
    """Search dossiers by ID/patient text and/or LOS range, with global filters applied.

    Inputs:
        search: free-text substring matched on DOSSIER_ID and patient_id.
        limit: integer (max items).
        los_min_min, los_max_min: minutes (lower / upper LOS bound, optional).
        date_from / date_to / exit_mode / hour_from / hour_to: same global filters as other endpoints.
    Output items[]:
        dossier_id, patient_id: strings.
        arrivee, sortie: ISO datetime strings.
        los_min: minutes (LOS).
        n_steps: integer (number of location events for the dossier).
        mode_sortie: free text.
    """
    c = filter_cases(_cases(), f)
    if search.strip():
        s = search.strip()
        mask = (
            c["DOSSIER_ID"].astype(str).str.contains(s, case=False, na=False)
            | c["patient_id"].astype(str).str.contains(s, case=False, na=False)
        )
        c = c[mask]
    if los_min_min is not None:
        c = c[c["los_min"] >= los_min_min]
    if los_max_min is not None:
        c = c[c["los_min"] < los_max_min]
    c = c.sort_values("arrivee", ascending=False).head(limit)
    out = []
    for _, r in c.iterrows():
        out.append({
            "dossier_id": str(r["DOSSIER_ID"]),
            "patient_id": str(r["patient_id"]) if pd.notna(r["patient_id"]) else None,
            "arrivee": r["arrivee"].isoformat() if pd.notna(r["arrivee"]) else None,
            "mode_sortie": str(r["mode_sortie"]) if pd.notna(r["mode_sortie"]) else None,
            "los_min": _safe(r["los_min"]),
            "n_steps": int(r["n_steps"]),
        })
    return out


@app.get("/api/patient-journey")
def patient_journey(dossier_ids: str = Query(...)):
    """Reconstruct per-dossier timeline (relative to arrival).

    Inputs:
        dossier_ids: comma-separated DOSSIER_ID values (max 20).
    Output (one entry per id):
        dossier_id, patient_id, mode_sortie: strings.
        arrivee, sortie: ISO datetime strings.
        los_min: minutes (case LOS).
        n_steps: integer.
        steps[].location: location label.
        steps[].start, end: ISO datetime strings (absolute time).
        steps[].start_min, end_min: minutes RELATIVE TO ARRIVAL.
        steps[].duration_min: minutes (per-step duration).
    """
    ids = [x.strip() for x in dossier_ids.split(",") if x.strip()][:20]
    df = _df()
    c = _cases()
    df_id = df["DOSSIER_ID"].astype(str)
    c_id = c["DOSSIER_ID"].astype(str)
    out = []
    for did in ids:
        sub = df[df_id == did].sort_values("loc_heure_debut")
        case_rows = c[c_id == did]
        if sub.empty:
            continue
        arrivee = None
        if not case_rows.empty and pd.notna(case_rows.iloc[0]["arrivee"]):
            arrivee = case_rows.iloc[0]["arrivee"]
        if arrivee is None:
            arrivee = sub["loc_heure_debut"].dropna().min()
        if arrivee is None or (isinstance(arrivee, float) and np.isnan(arrivee)):
            continue
        steps = []
        for _, row in sub.iterrows():
            sd = row["loc_heure_debut"]
            ed = row["loc_heure_fin"]
            sm = float((sd - arrivee).total_seconds() / 60) if pd.notna(sd) else None
            em = float((ed - arrivee).total_seconds() / 60) if pd.notna(ed) else None
            steps.append({
                "location": row["loc_local_libelle"],
                "start": sd.isoformat() if pd.notna(sd) else None,
                "end": ed.isoformat() if pd.notna(ed) else None,
                "start_min": _safe(sm),
                "end_min": _safe(em),
                "duration_min": _safe(row["duration_min"]),
            })
        r0 = case_rows.iloc[0] if not case_rows.empty else None
        out.append({
            "dossier_id": did,
            "patient_id": str(r0["patient_id"]) if r0 is not None and pd.notna(r0["patient_id"]) else None,
            "arrivee": arrivee.isoformat() if pd.notna(arrivee) else None,
            "sortie": r0["sortie"].isoformat() if r0 is not None and pd.notna(r0["sortie"]) else None,
            "mode_sortie": str(r0["mode_sortie"]) if r0 is not None and pd.notna(r0["mode_sortie"]) else None,
            "los_min": _safe(r0["los_min"]) if r0 is not None else None,
            "steps": steps,
        })
    return out


# ---------------- FLEXSIM EXPORT ----------------

@app.get("/api/flexsim-export")
def flexsim_export() -> StreamingResponse:
    """ZIP of three CSVs ready for FlexSim import.

    Files & units:
        arrivals_by_hour.csv: hour (0..23), lambda_per_min (real, arrivals per minute).
        service_times.csv: location, mean_min, std_min (minutes), n (integer count).
        transitions.csv: source, target (location strings), probability (0–1 ratio).
    """
    d = _df()
    c = _cases().dropna(subset=["arrivee"])

    # arrivals per hour
    hourly_counts = np.zeros(24)
    for ts in c["arrivee"]:
        hourly_counts[ts.hour] += 1
    span_days = max(1.0, (c["arrivee"].max() - c["arrivee"].min()).total_seconds() / 86400.0)
    lambda_per_min = hourly_counts / span_days / 60.0
    arrivals_df = pd.DataFrame({
        "hour": np.arange(24, dtype=int),
        "lambda_per_min": np.round(lambda_per_min, 6),
    })

    # service times per location
    g = d.groupby("loc_local_libelle")["duration_min"].agg(["mean", "std", "count"]).fillna(0)
    g = g[g["count"] >= 20].reset_index()
    g.columns = ["location", "mean_min", "std_min", "n"]

    # transitions
    edges_counter: Counter = Counter()
    out_counter: Counter = Counter()
    for _, grp in d.groupby("DOSSIER_ID"):
        locs = grp["loc_local_libelle"].tolist()
        for i in range(len(locs) - 1):
            if locs[i] != locs[i + 1]:
                edges_counter[(locs[i], locs[i + 1])] += 1
                out_counter[locs[i]] += 1
    trans_rows = []
    for (a, b), n in edges_counter.items():
        total_out = out_counter[a] or 1
        trans_rows.append({"from": a, "to": b, "probability": round(n / total_out, 4)})
    trans_df = pd.DataFrame(trans_rows)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("arrivals_by_hour.csv", arrivals_df.to_csv(index=False))
        zf.writestr("service_times.csv", g.to_csv(index=False))
        zf.writestr("transitions.csv", trans_df.to_csv(index=False))
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="flexsim_export.zip"'},
    )


# ─── Research helpers ────────────────────────────────────────────────────────

def _mann_whitney(x: np.ndarray, y: np.ndarray):
    """Two-sided Mann-Whitney U with normal approximation (tie-corrected, no scipy)."""
    n1, n2 = len(x), len(y)
    combined = np.concatenate([x, y])
    N = n1 + n2
    order = np.argsort(combined, kind="stable")
    ranks = np.empty(N)
    i = 0
    while i < N:
        j = i
        while j < N - 1 and combined[order[j + 1]] == combined[order[j]]:
            j += 1
        avg = (i + j) / 2 + 1
        ranks[order[i : j + 1]] = avg
        i = j + 1
    R1 = ranks[:n1].sum()
    U1 = R1 - n1 * (n1 + 1) / 2
    U = min(U1, n1 * n2 - U1)
    ties = np.unique(combined, return_counts=True)[1]
    tie_corr = (ties ** 3 - ties).sum() / max(N * (N - 1), 1)
    var_U = n1 * n2 / 12 * max(N + 1 - tie_corr, 0)
    if var_U < 1e-10:
        return float(U), 1.0
    z = abs(U - n1 * n2 / 2) / np.sqrt(var_U)
    def Phi(z: float) -> float:
        t = 1 / (1 + 0.2316419 * z)
        return 1 - 0.3989422820 * np.exp(-0.5 * z ** 2) * t * (
            0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
        )
    return float(U), float(np.clip(2 * (1 - Phi(z)), 0, 1))


@app.get("/api/research/before-after")
def research_before_after(
    split_date: str = Query(...),
    date_from:  Optional[str] = Query(None),
    date_to:    Optional[str] = Query(None),
) -> dict:
    """Mann-Whitney U + Cohen's d on LOS, before vs after `split_date`.

    Inputs:
        split_date: ISO date string (YYYY-MM-DD).
    Outputs:
        before/after: { n: int, mean, median, p10, p25, p75, p90 } — all in MINUTES.
        u_stat: Mann-Whitney U statistic (raw, unbounded — depends on n).
        p_value: probability 0–1 (two-sided).
        cohen_d: standardized effect size (unitless; |d| ~ 0.2 small / 0.5 medium / 0.8 large).
    """
    c = _cases().copy()
    if date_from: c = c[c["arrivee"] >= pd.Timestamp(date_from)]
    if date_to:   c = c[c["arrivee"] <= pd.Timestamp(date_to) + pd.Timedelta(days=1)]
    c = c.dropna(subset=["arrivee", "los_min"]).copy()
    c = c[c["los_min"] > 0]

    split  = pd.Timestamp(split_date)
    before = c[c["arrivee"] < split]["los_min"].values
    after  = c[c["arrivee"] >= split]["los_min"].values

    if len(before) < 10 or len(after) < 10:
        return {"error": "Pas assez de données dans une des deux périodes"}

    u_stat, p_value = _mann_whitney(before, after)

    pooled_var = (np.var(before, ddof=1) * (len(before) - 1) + np.var(after, ddof=1) * (len(after) - 1))
    pooled_std = np.sqrt(pooled_var / max(len(before) + len(after) - 2, 1))
    cohen_d    = float((np.mean(after) - np.mean(before)) / max(pooled_std, 0.001))

    def pcts(arr: np.ndarray) -> dict:
        return {
            "n":      int(len(arr)),
            "mean":   round(float(arr.mean()), 1),
            "median": round(float(np.median(arr)), 1),
            "p10":    round(float(np.percentile(arr, 10)), 1),
            "p25":    round(float(np.percentile(arr, 25)), 1),
            "p75":    round(float(np.percentile(arr, 75)), 1),
            "p90":    round(float(np.percentile(arr, 90)), 1),
        }

    return {
        "before":   pcts(before),
        "after":    pcts(after),
        "p_value":  round(p_value, 4),
        "u_stat":   round(u_stat, 1),
        "cohen_d":  round(cohen_d, 3),
        "split_date": split_date,
    }


@app.get("/api/research/decomposition")
def research_decomposition(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
) -> dict:
    """STL-style additive decomposition (trend / seasonal / residual) of daily arrival counts.

    Outputs:
        daily[]: { date: ISO date, count: integer arrivals }.
        trend[], seasonal[], residual[]: real numbers (same units as count).
        period: integer (seasonal period in days, here = 7).
    """
    c = _cases().copy()
    if date_from: c = c[c["arrivee"] >= pd.Timestamp(date_from)]
    if date_to:   c = c[c["arrivee"] <= pd.Timestamp(date_to) + pd.Timedelta(days=1)]
    c = c.dropna(subset=["arrivee"]).copy()

    c["_date"] = c["arrivee"].dt.date
    daily = (
        c.groupby("_date").size()
        .reset_index(name="count")
        .rename(columns={"_date": "date"})
    )
    daily["date"] = pd.to_datetime(daily["date"])
    daily = daily.sort_values("date").reset_index(drop=True)

    if len(daily) < 14:
        return {"dates": [], "observed": [], "trend": [], "seasonal": [], "residual": []}

    vals  = daily["count"].values.astype(float)
    n     = len(vals)
    half  = 3   # half-window for centered MA of length 7

    # Trend: centered moving average (window=7)
    trend = np.full(n, np.nan)
    for i in range(half, n - half):
        trend[i] = vals[i - half : i + half + 1].mean()

    # Seasonal: mean detrended by actual day-of-week, then centred
    detrended = vals - trend
    dow_sum, dow_cnt = np.zeros(7), np.zeros(7)
    for i, row in daily.iterrows():
        d = row["date"].dayofweek
        if not np.isnan(detrended[i]):
            dow_sum[d] += detrended[i]
            dow_cnt[d] += 1
    dow_mean = np.where(dow_cnt > 0, dow_sum / dow_cnt, 0.0)
    dow_mean -= dow_mean.mean()
    seasonal = np.array([dow_mean[daily.loc[i, "date"].dayofweek] for i in range(n)])

    residual = vals - trend - seasonal

    def to_list(arr: np.ndarray) -> list:
        return [None if np.isnan(v) else round(float(v), 2) for v in arr]

    return {
        "dates":    [str(d.date()) for d in daily["date"]],
        "observed": [int(v) for v in vals],
        "trend":    to_list(trend),
        "seasonal": to_list(seasonal),
        "residual": to_list(residual),
    }


@app.get("/api/research/kaplan-meier")
def research_kaplan_meier(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
) -> dict:
    """Empirical survival function S(t) of staying in the ED — overall, weekday, weekend.

    Outputs (overall / weekday / weekend, same shape):
        [].t: minutes since arrival (sampled at 0, 15, 30, …, 1440).
        [].s: probability 0–1 (share of patients still in ED at time t).
        [].ci_lo, ci_hi: probability 0–1 (95% binomial CI).
        median_overall / weekday / weekend: minutes (50% survival time).
    """
    c = _cases().copy()
    if date_from: c = c[c["arrivee"] >= pd.Timestamp(date_from)]
    if date_to:   c = c[c["arrivee"] <= pd.Timestamp(date_to) + pd.Timedelta(days=1)]
    c = c.dropna(subset=["arrivee", "los_min"]).copy()
    c = c[(c["los_min"] > 0) & (c["los_min"] <= 1440)].copy()

    if len(c) < 30:
        return {"overall": [], "weekday": [], "weekend": [],
                "n_total": 0, "n_weekday": 0, "n_weekend": 0,
                "median_overall": 0.0, "median_weekday": 0.0, "median_weekend": 0.0}

    c["is_weekend"] = c["arrivee"].dt.dayofweek >= 5
    time_pts = list(range(0, 721, 15)) + [780, 840, 960, 1080, 1200, 1440]

    def km_curve(los: np.ndarray) -> list:
        n = len(los)
        return [
            {
                "t":     int(t),
                "s":     round(float((los > t).mean()), 4),
                "ci_lo": round(float(max(0, (los > t).mean() - 1.96 * np.sqrt((los > t).mean() * (1 - (los > t).mean()) / max(n, 1)))), 4),
                "ci_hi": round(float(min(1, (los > t).mean() + 1.96 * np.sqrt((los > t).mean() * (1 - (los > t).mean()) / max(n, 1)))), 4),
            }
            for t in time_pts
        ]

    overall  = c["los_min"].values
    weekday  = c[~c["is_weekend"]]["los_min"].values
    weekend  = c[c["is_weekend"]]["los_min"].values

    return {
        "overall":        km_curve(overall),
        "weekday":        km_curve(weekday) if len(weekday) >= 10 else [],
        "weekend":        km_curve(weekend) if len(weekend) >= 10 else [],
        "n_total":        int(len(overall)),
        "n_weekday":      int(len(weekday)),
        "n_weekend":      int(len(weekend)),
        "median_overall": round(float(np.median(overall)), 1),
        "median_weekday": round(float(np.median(weekday)) if len(weekday) else 0, 1),
        "median_weekend": round(float(np.median(weekend)) if len(weekend) else 0, 1),
    }


@app.get("/api/research/feature-importance")
def research_feature_importance() -> dict:
    """Feature importance from the LOS Gradient Boosting model.

    Outputs:
        features[].importance: 0–1 ratio (Gini importance, sums to 1 across all features).
        features[].name: human-readable feature label.
    """
    if Cache.model is None or Cache.feature_cols is None:
        return {"features": []}

    imp = Cache.model.feature_importances_
    pairs = sorted(zip(Cache.feature_cols, imp), key=lambda x: x[1], reverse=True)[:15]

    def cat(name: str) -> str:
        if name in ("hour", "day_of_week", "month"):   return "time"
        if name.startswith("loc_"):                     return "location"
        return "exit"

    def label(name: str) -> str:
        mapping = {"hour": "Heure arrivée", "day_of_week": "Jour semaine", "month": "Mois"}
        if name in mapping: return mapping[name]
        return name.replace("loc_", "").replace("exit_", "").replace("_", " ")[:20]

    return {
        "features": [
            {"name": label(n), "raw": n, "importance": round(float(v), 4),
             "rank": i + 1, "category": cat(n)}
            for i, (n, v) in enumerate(pairs)
        ]
    }


@app.get("/api/research")
def research_analytics(
    date_from: Optional[str] = Query(None),
    date_to:   Optional[str] = Query(None),
) -> dict:
    """Three datasets for research / statistical process control.

    Outputs:
        daily[].date: ISO date.
        daily[].count: integer (arrivals).
        daily[].avg_los: minutes.
        clusters[].avg_los, median_los: minutes.
        clusters[].hosp_rate: percentage 0–100.
        clusters[].size: integer.
        scatter[].hour: 0..23.
        scatter[].los: minutes (clipped at 720 for visualization).
        scatter[].cluster: integer cluster id (0..k-1).
    """
    c = _cases().copy()

    if date_from:
        c = c[c["arrivee"] >= pd.Timestamp(date_from)]
    if date_to:
        c = c[c["arrivee"] <= pd.Timestamp(date_to) + pd.Timedelta(days=1)]

    c = c.dropna(subset=["arrivee", "los_min"]).copy()
    c = c[c["los_min"] > 0].copy()

    if len(c) < 20:
        return {"clusters": [], "scatter": [], "daily": []}

    # ── Daily series for SPC & breakpoints ──────────────────────────────────
    c["_date"] = c["arrivee"].dt.date
    daily = (
        c.groupby("_date")
        .agg(count=("DOSSIER_ID", "count"), avg_los=("los_min", "mean"))
        .reset_index()
        .rename(columns={"_date": "date"})
    )
    daily["date"]    = daily["date"].astype(str)
    daily["avg_los"] = daily["avg_los"].round(1)
    daily_records    = daily.to_dict("records")

    # ── K-means clustering (k=4) ─────────────────────────────────────────────
    c["los_clipped"]  = c["los_min"].clip(0, 720)
    c["hospitalized"] = (c["mode_sortie"].fillna("") == "Hospitalisation").astype(float)
    c["hour"]         = c["arrivee"].dt.hour
    c["dow"]          = c["arrivee"].dt.dayofweek

    feats = c[["hour", "dow", "los_clipped", "hospitalized"]].values.astype(float)
    f_mean, f_std = feats.mean(axis=0), feats.std(axis=0)
    f_std[f_std == 0] = 1.0
    feats_norm = (feats - f_mean) / f_std

    K  = 4
    km = KMeans(n_clusters=K, random_state=42, n_init=10, max_iter=200)
    labels = km.fit_predict(feats_norm)

    PALETTE = ["#22d3ee", "#818cf8", "#34d399", "#f59e0b"]
    clusters = []
    for k in range(K):
        mask = labels == k
        if mask.sum() == 0:
            continue
        pts       = feats[mask]
        avg_hour  = float(pts[:, 0].mean())
        avg_dow   = float(pts[:, 1].mean())
        avg_los   = float(pts[:, 2].mean())
        hosp_rate = float(pts[:, 3].mean())

        if hosp_rate > 0.45:
            name = "Hospitalisés"
        elif avg_los < 90:
            name = "Passages courts"
        elif avg_hour >= 20 or avg_hour < 6:
            name = "Nocturnes"
        else:
            name = "Soins prolongés"

        clusters.append({
            "id":         int(k),
            "name":       name,
            "color":      PALETTE[k % len(PALETTE)],
            "count":      int(mask.sum()),
            "pct":        round(float(mask.mean()) * 100, 1),
            "avg_hour":   round(avg_hour, 1),
            "avg_dow":    round(avg_dow, 1),
            "avg_los":    round(avg_los, 1),
            "median_los": round(float(np.median(pts[:, 2])), 1),
            "hosp_rate":  round(hosp_rate * 100, 1),
        })

    # ── Scatter sample (max 800 pts): heure × LOS, couleur cluster ──────────
    rng       = np.random.default_rng(42)
    n_sample  = min(800, len(feats))
    idx_s     = rng.choice(len(feats), n_sample, replace=False)
    scatter   = [
        {"hour": int(feats[i, 0]), "los": int(min(feats[i, 2], 720)), "cluster": int(labels[i])}
        for i in idx_s
    ]

    return {"clusters": clusters, "scatter": scatter, "daily": daily_records}


# ─── Pathway Intelligence ─────────────────────────────────────────────────────

class PathwayNextInput(BaseModel):
    sequence: list[str]


@app.post("/api/pathway-next")
def pathway_next(body: PathwayNextInput):
    """Predict the most likely next location given a partial pathway (Jelinek-Mercer smoothed bigram).

    Inputs:
        sequence: list of location strings (the prefix to extend).
    Outputs:
        predictions[].location: candidate next location.
        predictions[].prob: probability 0–1 (smoothed bigram, λ=0.65).
        predictions[].count: integer (raw observed transition count for ranking).
        avg_remaining_los_min: minutes (median residual LOS for matched cases).
        n_matched: integer (number of historical cases matching the prefix).
        entropy_bits: bits (Shannon entropy of the prediction distribution; higher = more uncertain).
    """
    """Bigram Markov next-step prediction with remaining LOS estimation."""
    cases  = _cases()
    seqs   = [list(s) for s in cases["sequence"].tolist()]
    seq    = body.sequence

    if not seq:
        # Prior: most common first locations
        firsts: Counter = Counter(s[0] for s in seqs if s)
        total  = sum(firsts.values()) or 1
        preds  = [{"location": l, "prob": round(c / total, 4), "count": int(c)}
                  for l, c in firsts.most_common(7)]
        rem    = float(cases["los_min"].median())
        entropy = -sum(p["prob"] * np.log2(p["prob"]) for p in preds if p["prob"] > 0)
        return {"predictions": preds, "avg_remaining_los_min": round(rem, 1),
                "n_matched": len(seqs), "entropy_bits": round(entropy, 3)}

    last = seq[-1]
    prev = seq[-2] if len(seq) >= 2 else None

    # Count bigram and unigram transitions
    bigram:  Counter = Counter()
    unigram: Counter = Counter()
    for s in seqs:
        for i in range(len(s) - 1):
            nxt = s[i + 1]
            if s[i] == last:
                unigram[nxt] += 1
            if prev and i > 0 and s[i - 1] == prev and s[i] == last:
                bigram[nxt] += 1

    # Jelinek-Mercer interpolation: λ=0.65 bigram when available
    lam   = 0.65 if bigram else 0.0
    bt    = sum(bigram.values()) or 1
    ut    = sum(unigram.values()) or 1
    keys  = set(bigram) | set(unigram)
    blend = {k: lam * bigram.get(k, 0) / bt + (1 - lam) * unigram.get(k, 0) / ut
             for k in keys}
    top   = sorted(blend.items(), key=lambda x: x[1], reverse=True)[:7]
    norm  = sum(v for _, v in top) or 1
    preds = [{"location": l, "prob": round(p / norm, 4), "count": int(unigram.get(l, 0))}
             for l, p in top]

    # Matched patients following this exact prefix
    n     = len(seq)
    mask  = cases["sequence"].apply(lambda s: len(s) >= n and list(s[:n]) == seq)
    matched = cases[mask]
    rem_los = float(matched["los_min"].median()) if len(matched) > 0 else float(cases["los_min"].median())
    entropy = -sum(p["prob"] * np.log2(p["prob"]) for p in preds if p["prob"] > 0)

    return {
        "predictions":           preds,
        "avg_remaining_los_min": round(rem_los, 1),
        "n_matched":             int(mask.sum()),
        "entropy_bits":          round(entropy, 3),
    }


@app.get("/api/floor-plan")
def floor_plan():
    """Schematic floor plan derived from event flow (NOT a real architectural plan).

    Coordinates are layout-optimized canvas units, organized in 4 layers (entry → exit) by mean
    journey position. `scale_m_per_unit` converts to meters under the assumption that one room
    is ≈ 5 m wide.

    Outputs:
        rooms[].x, y, w, h: canvas units (NOT meters).
        rooms[].avg_duration_min: minutes (mean per-event stay).
        rooms[].count: integer (visits/events).
        rooms[].avg_pos: real (mean position index in the journey, used for layering).
        rooms[].layer: 0..3 (entry, IOA, care, exit).
        edges[].count: integer (transitions A→B).
        edges[].weight: 0–1 ratio (normalized edge importance for visualization).
        canvas.{w, h}: canvas units.
        scale_m_per_unit: meters per canvas unit (≈ 5 m / room width).
    """
    """Layered 2D floor plan: rooms positioned by average journey stage."""
    df    = _df()
    cases = _cases()
    seqs  = [list(s) for s in cases["sequence"].tolist()]

    # Top locations by visit count (max 16)
    loc_counts = df.groupby("loc_local_libelle").size().sort_values(ascending=False)
    top_n      = min(16, len(loc_counts))
    top_locs   = loc_counts.head(top_n).index.tolist()
    top_set    = set(top_locs)

    # Average journey position: 0 = first step, 1 = last step
    pos_sum: dict[str, float] = defaultdict(float)
    pos_cnt: dict[str, int]   = defaultdict(int)
    for s in seqs:
        n = len(s)
        for i, loc in enumerate(s):
            if loc in top_set:
                pos_sum[loc] += i / max(n - 1, 1)
                pos_cnt[loc] += 1
    avg_pos = {l: pos_sum[l] / pos_cnt[l] for l in top_locs if pos_cnt[l] > 0}

    # Assign to 4 layers by quartile thresholds
    thresholds = [0.18, 0.42, 0.68]
    def layer_of(loc: str) -> int:
        p = avg_pos.get(loc, 0.5)
        for i, t in enumerate(thresholds):
            if p < t:
                return i
        return 3

    layers: dict[int, list[str]] = defaultdict(list)
    for loc in sorted(top_locs, key=lambda l: avg_pos.get(l, 0.5)):
        layers[layer_of(loc)].append(loc)

    # Canvas geometry (units)
    CW, CH     = 920, 500
    RW, RH     = 128, 70
    PAD_X      = 48
    n_layers   = 4
    layer_xs   = [PAD_X + i * ((CW - 2 * PAD_X - RW) // (n_layers - 1)) for i in range(n_layers)]

    rooms = []
    for li in range(n_layers):
        locs = layers[li]
        if not locs:
            continue
        total_h = len(locs) * (RH + 18) - 18
        y0      = max(10, (CH - total_h) / 2)
        for j, loc in enumerate(locs):
            dur_mean = df[df["loc_local_libelle"] == loc]["duration_min"].mean()
            rooms.append({
                "id":    loc,
                "label": loc,
                "x":     int(layer_xs[li]),
                "y":     int(y0 + j * (RH + 18)),
                "w":     RW, "h": RH,
                "count": int(loc_counts.get(loc, 0)),
                "avg_duration_min": round(float(dur_mean) if not np.isnan(dur_mean) else 0, 1),
                "avg_pos": round(avg_pos.get(loc, 0.5), 3),
                "layer": li,
            })

    # Transition edges between top locations
    trans: dict[tuple[str, str], int] = defaultdict(int)
    for s in seqs:
        for i in range(len(s) - 1):
            if s[i] in top_set and s[i + 1] in top_set and s[i] != s[i + 1]:
                trans[(s[i], s[i + 1])] += 1

    max_t = max(trans.values(), default=1)
    edges = sorted(
        [{"source": src, "target": tgt, "count": int(cnt), "weight": round(cnt / max_t, 3)}
         for (src, tgt), cnt in trans.items() if cnt >= 3],
        key=lambda e: e["count"], reverse=True
    )[:50]

    # Physical scale: assume each room ≈ 5 m wide → 1 unit ≈ 5/RW m
    scale = round(5.0 / RW, 4)

    return {"rooms": rooms, "edges": edges,
            "canvas": {"w": CW, "h": CH}, "scale_m_per_unit": scale}


@app.get("/api/drilldown/by-location")
def drilldown_by_location(
    location: str,
    limit: int = 50,
    f: Filters = Depends(_filters_dep),
) -> dict:
    """List dossiers passing through a location, with stats.

    Inputs:
        location: location label (case-insensitive, normalized to upper-case).
        limit: integer (max items returned).
    Outputs:
        items[].dossier_id, patient_id, mode_sortie: strings.
        items[].arrivee: ISO datetime string.
        items[].los_min: minutes (case LOS).
        items[].min_at_loc: minutes (TOTAL time spent at this location for this dossier — name kept for backward compat; despite the prefix `min_`, this is the SUM).
        items[].n_passages: integer (number of separate visits to this location).
        stats.{n_total}: integer count.
        stats.{mean_min, median_min, p90_min}: minutes (event-level durations at this location).
    """
    df = Cache.df
    cases = Cache.cases
    if df is None or cases is None or df.empty:
        return {"location": location, "n_total": 0, "items": [], "stats": {}}

    df_f = filter_df(df, f, cases)
    loc = location.strip().upper()
    sub = df_f[df_f["loc_local_libelle"] == loc].copy()
    if sub.empty:
        return {"location": loc, "n_total": 0, "items": [], "stats": {}}

    cases_f = filter_cases(cases, f)
    cases_f = cases_f[cases_f["DOSSIER_ID"].isin(sub["DOSSIER_ID"].unique())]

    per = (
        sub.groupby("DOSSIER_ID")["duration_min"]
        .agg(["sum", "count"])
        .rename(columns={"sum": "min_at_loc", "count": "n_passages"})
    )
    merged = cases_f.set_index("DOSSIER_ID").join(per, how="left").reset_index()
    merged = merged.sort_values("min_at_loc", ascending=False).head(limit)

    items = []
    for _, r in merged.iterrows():
        items.append({
            "dossier_id": str(r["DOSSIER_ID"]),
            "patient_id": str(r.get("patient_id") or ""),
            "arrivee":    str(r["arrivee"]) if pd.notna(r["arrivee"]) else None,
            "los_min":    None if pd.isna(r["los_min"]) else float(r["los_min"]),
            "min_at_loc": None if pd.isna(r["min_at_loc"]) else float(r["min_at_loc"]),
            "n_passages": int(r["n_passages"]) if pd.notna(r["n_passages"]) else 0,
            "mode_sortie": str(r.get("mode_sortie") or ""),
        })
    durations = sub["duration_min"].dropna()
    stats = {
        "n_total":     int(sub["DOSSIER_ID"].nunique()),
        "mean_min":    float(durations.mean()) if not durations.empty else None,
        "median_min":  float(durations.median()) if not durations.empty else None,
        "p90_min":     float(durations.quantile(0.9)) if not durations.empty else None,
    }
    return {"location": loc, "n_total": stats["n_total"], "items": items, "stats": stats}


@app.get("/api/drilldown/by-variant")
def drilldown_by_variant(
    sequence: str,
    limit: int = 50,
    f: Filters = Depends(_filters_dep),
) -> dict:
    """List dossiers whose path STARTS with the given comma-separated sequence.

    Inputs:
        sequence: comma-separated location labels (e.g. "IOA,EXA,SAUV"). Case-insensitive.
        limit: integer (max items returned).
    Outputs:
        items[].dossier_id, patient_id, mode_sortie: strings.
        items[].arrivee: ISO datetime string.
        items[].los_min: minutes (case LOS).
        items[].n_steps: integer (number of location events).
        stats.n_total: integer (matched dossiers).
        stats.{mean_los, median_los, p90_los}: minutes (case-level LOS).
    """
    df = Cache.df
    cases = Cache.cases
    if df is None or cases is None:
        return {"sequence": [], "n_total": 0, "items": [], "stats": {}}

    target = tuple(s.strip().upper() for s in sequence.split(",") if s.strip())
    if not target:
        return {"sequence": [], "n_total": 0, "items": [], "stats": {}}

    df_f = filter_df(df, f, cases)
    matched_dids = set()
    for did, grp in df_f.groupby("DOSSIER_ID")["loc_local_libelle"]:
        seq = tuple(grp.tolist())
        if len(seq) >= len(target) and seq[:len(target)] == target:
            matched_dids.add(did)

    cases_f = filter_cases(cases, f)
    cases_f = cases_f[cases_f["DOSSIER_ID"].isin(matched_dids)].copy()
    cases_f = cases_f.sort_values("arrivee", ascending=False).head(limit)

    items = []
    for _, r in cases_f.iterrows():
        items.append({
            "dossier_id": str(r["DOSSIER_ID"]),
            "patient_id": str(r.get("patient_id") or ""),
            "arrivee":    str(r["arrivee"]) if pd.notna(r["arrivee"]) else None,
            "los_min":    None if pd.isna(r["los_min"]) else float(r["los_min"]),
            "n_steps":    int(r["n_steps"]) if pd.notna(r["n_steps"]) else 0,
            "mode_sortie": str(r.get("mode_sortie") or ""),
        })

    los = cases[cases["DOSSIER_ID"].isin(matched_dids)]["los_min"].dropna()
    stats = {
        "n_total":     len(matched_dids),
        "mean_los":    float(los.mean()) if not los.empty else None,
        "median_los":  float(los.median()) if not los.empty else None,
        "p90_los":     float(los.quantile(0.9)) if not los.empty else None,
    }
    return {"sequence": list(target), "n_total": len(matched_dids), "items": items, "stats": stats}


@app.get("/")
def root() -> dict:
    """Health-check / service identity endpoint (no units)."""
    return {"service": "ED Flow Intelligence", "status": "ok"}


# ─── Local LLM assistant (Ollama) ────────────────────────────────────────────
import json
import os
import httpx

OLLAMA_URL   = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:3b")

_SYSTEM_BASE = (
    "Tu es un expert en ingénierie industrielle et en management des services d'urgence, "
    "consultant pour un service d'urgences pédiatriques. Ta double expertise couvre : "
    "(a) ingénierie des flux hospitaliers (process mining, théorie des files d'attente, "
    "lean healthcare, simulation à événements discrets, capacity planning), "
    "(b) organisation médicale d'urgence (triage IOA, parcours UHCD/SAUV, modes de sortie, "
    "qualité, conformité, ré-admissions). "
    "Tu réponds en français, de manière concise (3 à 6 phrases), factuelle et orientée action. "
    "Tu t'appuies STRICTEMENT sur le contexte JSON fourni — tu cites les chiffres précis "
    "(durées en minutes, %, dates) et n'inventes jamais. Si une information manque, tu le dis. "
    "Vocabulaire à utiliser : LOS (durée de séjour), p50/p90 (médiane / 90e percentile), "
    "goulot, débit, occupation, taux de hospit, ré-admission à 72h, charge IOA, "
    "rupture (changement structurel), Cohen d (taille d'effet). "
    "Tu termines toujours par une recommandation opérationnelle concrète quand c'est pertinent "
    "(ex. ajouter un box, redéployer une ressource sur tel créneau, revoir un protocole)."
)

_SYSTEM_BY_KIND = {
    "rupture": (
        "Tu expliques une détection de rupture (Binary Segmentation) sur le "
        "volume journalier de passages. Indique : (1) combien de ruptures "
        "ont été détectées et à quelles dates, (2) le sens du changement "
        "(hausse/baisse) et son ampleur en %, (3) une hypothèse plausible."
    ),
    "avant_apres": (
        "Tu commentes un test statistique avant/après (Mann-Whitney U + Cohen d). "
        "Précise : (1) si la différence est significative (p-value), "
        "(2) sa magnitude pratique (taille d'effet), "
        "(3) ce que ça signifie pour le service."
    ),
    "briefing": (
        "Tu rédiges le BRIEFING MATINAL du chef de service. Format strict : "
        "5 puces markdown courtes (10-18 mots chacune), pas de phrase d'intro, "
        "pas de conclusion. Structure imposée : "
        "(1) **Activité** — volume et LOS (chiffre absolu + tendance), "
        "(2) **Goulots** — la localisation #1 + sa durée moyenne, "
        "(3) **Sorties** — répartition des modes de sortie, "
        "(4) **Qualité** — ré-admissions 7j/30j, "
        "(5) **À surveiller** — UNE recommandation actionnable du jour. "
        "Cite des chiffres précis. Pas de gras pour les chiffres, juste le label."
    ),
    "general": (
        "Tu fais une synthèse générale de la situation observée."
    ),
}


class ExplainMessage(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str


class ExplainRequest(BaseModel):
    kind: str = "general"
    context: Dict[str, Any] = Field(default_factory=dict)
    question: Optional[str] = None
    history: List[ExplainMessage] = Field(default_factory=list)


@app.get("/api/llm-status")
async def llm_status() -> dict:
    """Probe the local Ollama server.

    Outputs:
        ok: bool (service reachable).
        model: string (configured default).
        model_available: bool (the configured model is currently pulled).
        models[]: string list (all locally available models).
        error: string (on failure).
    """
    try:
        async with httpx.AsyncClient(timeout=2.0) as cli:
            r = await cli.get(f"{OLLAMA_URL}/api/tags")
            if r.status_code != 200:
                return {"ok": False, "error": f"HTTP {r.status_code}"}
            tags = r.json().get("models", [])
            names = [m.get("name", "") for m in tags]
            return {
                "ok": True,
                "model": OLLAMA_MODEL,
                "model_available": any(n.startswith(OLLAMA_MODEL.split(":")[0]) for n in names),
                "models": names,
            }
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/explain")
async def explain(req: ExplainRequest):
    """Stream a French explanation/briefing from the local LLM.

    Inputs:
        kind: "rupture" | "avant_apres" | "briefing" | "general" — selects the system prompt.
        context: free-form JSON snapshot of dashboard data (truncated to 6000 chars).
        question: optional user question.
        history: optional last 8 chat messages.
    Outputs:
        Server-Sent Events stream (`text/event-stream`):
            data: {"token": "..."}        — one for each generated token.
            data: {"done": true}          — final marker.
            data: {"error": "..."}        — on failure (Ollama unreachable, model error, etc.).
    """
    system_prompt = _SYSTEM_BASE + " " + _SYSTEM_BY_KIND.get(req.kind, _SYSTEM_BY_KIND["general"])
    ctx_str = json.dumps(req.context, ensure_ascii=False, default=str)[:6000]

    messages: list[dict] = [{"role": "system", "content": system_prompt}]
    messages.append({
        "role": "user",
        "content": f"Données du tableau de bord (JSON):\n```json\n{ctx_str}\n```",
    })
    for m in req.history[-8:]:
        messages.append({"role": m.role, "content": m.content})
    if req.question:
        messages.append({"role": "user", "content": req.question})

    async def gen():
        payload = {
            "model": OLLAMA_MODEL,
            "messages": messages,
            "stream": True,
            "options": {"temperature": 0.3, "num_ctx": 8192},
        }
        try:
            async with httpx.AsyncClient(timeout=None) as cli:
                async with cli.stream("POST", f"{OLLAMA_URL}/api/chat", json=payload) as r:
                    if r.status_code != 200:
                        body = await r.aread()
                        yield f"data: {json.dumps({'error': f'Ollama HTTP {r.status_code}: {body.decode()[:200]}'})}\n\n"
                        return
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            obj = json.loads(line)
                        except Exception:
                            continue
                        if "message" in obj and "content" in obj["message"]:
                            chunk = obj["message"]["content"]
                            if chunk:
                                yield f"data: {json.dumps({'token': chunk})}\n\n"
                        if obj.get("done"):
                            yield f"data: {json.dumps({'done': True})}\n\n"
                            return
        except httpx.ConnectError:
            yield f"data: {json.dumps({'error': 'Ollama injoignable. Lance `ollama serve` puis `ollama pull qwen2.5:14b`.'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
