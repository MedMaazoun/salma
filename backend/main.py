from __future__ import annotations

import io
import random
import zipfile
from collections import Counter, defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd
import simpy
from fastapi import FastAPI, HTTPException, Query
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
    return {
        "predicted_los_min": round(max(0.0, pred), 1),
        "p10": round(max(0.0, min(p10, pred)), 1),
        "p90": round(max(p90, pred), 1),
    }


@app.get("/api/predict-options")
def predict_options() -> dict:
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
    extra_boxes: int | None = None
    arrival_multiplier: float | None = None
    ioa_speedup: float | None = None
    duration_days: int | None = None
    # New multi-scenario
    scenarios: list[Scenario] | None = None
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
    d = _df()
    mn = d["loc_heure_debut"].min()
    mx = d["loc_heure_debut"].max()
    return {
        "min": mn.strftime("%Y-%m-%d") if pd.notna(mn) else "",
        "max": mx.strftime("%Y-%m-%d") if pd.notna(mx) else "",
    }


@app.post("/api/real-trace")
def real_trace(inp: RealTraceInput) -> dict:
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


# ---------------- FLEXSIM EXPORT ----------------

@app.get("/api/flexsim-export")
def flexsim_export() -> StreamingResponse:
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


@app.get("/")
def root() -> dict:
    return {"service": "ED Flow Intelligence", "status": "ok"}
