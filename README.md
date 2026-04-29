# ED Flow Intelligence

Tableau de bord temps-réel pour service d'urgences pédiatriques.
Stack : **FastAPI + pandas + SimPy + scikit-learn** (backend) · **Vite + React + TypeScript + Tailwind + Recharts + React Flow** (frontend) · **Ollama + qwen2.5** (assistant IA local, optionnel).

---

## 1. Pré-requis

| Outil | Version conseillée | Vérification |
|-------|-------------------|--------------|
| Python | ≥ 3.9 | `python3 --version` |
| Node | ≥ 18 | `node -v` |
| npm | ≥ 9 | `npm -v` |
| Ollama (optionnel — pour l'assistant IA) | ≥ 0.5 | `ollama --version` |

Le fichier de données `2025_11_10_TrackingUrg.csv` doit se trouver à la racine du projet (à côté de ce README).

---

## 2. Lancement rapide (3 terminaux)

### Terminal A — Backend

```bash
cd backend
pip install -r requirements.txt          # première fois uniquement
uvicorn main:app --reload --port 8000
# raccourci : ./run.sh   (ou run.bat sous Windows)
```

API exposée sur `http://localhost:8000`. Le CSV est chargé une fois au démarrage et mis en cache.

### Terminal B — Frontend

```bash
cd frontend
npm install                               # première fois uniquement
npm run dev
```

Application sur `http://localhost:5173`.

### Terminal C — Assistant IA local (optionnel)

```bash
# 1. Installer Ollama (une seule fois)
brew install ollama                       # macOS
# ou télécharger depuis https://ollama.com pour Windows / Linux

# 2. Démarrer le service en tâche de fond
brew services start ollama                # macOS
# ou : ollama serve &                     # autres OS

# 3. Télécharger le modèle (~2 Go pour le 3B, ~5 Go pour le 7B)
ollama pull qwen2.5:3b                    # recommandé pour 8 Go RAM
# ou : ollama pull qwen2.5:7b             # 16 Go RAM
# ou : ollama pull mistral-small:24b      # 24+ Go RAM, français natif top
```

Le backend cherche par défaut `qwen2.5:3b` sur `http://localhost:11434`. Pour changer :

```bash
export OLLAMA_MODEL=qwen2.5:7b
export OLLAMA_URL=http://localhost:11434
```

Vérification rapide : `curl http://localhost:11434/api/tags` doit lister tes modèles installés.

> Sans Ollama l'app fonctionne normalement — seuls le bouton **Assistant** (en bas à droite) et le **Briefing IA** (Monitoring) seront désactivés.

---

## 3. Onglets principaux

| Onglet | Contenu |
|--------|---------|
| **Monitoring** | Command Center temps-réel (KPIs, heatmap arrivées, distribution LOS, goulots, sorties), réadmissions, briefing IA matinal |
| **Replay & Processus** | Carte du flux (Directly-Follows + React Flow), Sankey 3 étapes, top variantes, Parcours patients (timeline + Gantt) |
| **Jumeau Numérique** | Plan 3D du service avec flux patients animés (Three.js) |
| **Prospectif & IA** | Simulation Monte Carlo, prédiction LOS, parcours IA, recherche statistique (détection de rupture, test avant/après) |

---

## 4. Raccourcis & fonctionnalités

- **⌘K / Ctrl-K** — palette de commandes (navigation, filtres, actions)
- **Bouton Assistant** (bas droite) — chat IA avec contexte global du service
- **Bouton PDF** (header) — rapport opérationnel multi-pages pour responsable
- **Bouton FlexSim** — export ZIP de 3 CSV (arrivées, services, transitions) pour simulation externe
- **Bouton Présentation** — auto-rotation des onglets toutes les 14 s (Echap pour quitter)
- **Drill-down** — clic sur un goulot ou une variante → liste des dossiers concernés
- **Briefing IA** — désactivé par défaut, activable depuis Monitoring (préférence persistée)

---

## 5. Configuration

| Variable | Défaut | Description |
|----------|--------|-------------|
| `OLLAMA_URL` | `http://localhost:11434` | URL du serveur Ollama |
| `OLLAMA_MODEL` | `qwen2.5:3b` | Modèle utilisé par l'assistant et le briefing |
| `VITE_API_URL` | `http://localhost:8000` | URL du backend (à mettre dans un `.env` côté frontend si différent) |

---

## 6. Endpoints principaux (backend)

Documentation complète des unités dans les docstrings du fichier [`backend/main.py`](backend/main.py).

| Endpoint | Description |
|----------|-------------|
| `GET /api/kpis` | KPIs filtrables (LOS médian/p90, hospit %, dossiers, patients) |
| `GET /api/command-center` | Payload agrégé pour le Monitoring |
| `GET /api/process-graph` | Directly-follows graph (top 25 locations) |
| `GET /api/bottlenecks` | Top 15 goulots par durée moyenne |
| `GET /api/sankey` | Flows des 3 premières étapes |
| `GET /api/readmissions` | Taux 7j/30j (en pourcentage 0–100) |
| `GET /api/research` | Données pour SPC, ruptures, clusters |
| `POST /api/predict` | Prédiction LOS (modèle GBM, p10/p90 garantis) |
| `POST /api/simulate` | Simulation SimPy (DES) — scénario unique ou Monte-Carlo |
| `POST /api/simulate-trace` | Trace détaillée par local (queues, waits, time-series) |
| `GET /api/drilldown/by-location` | Dossiers passant par une localisation |
| `GET /api/drilldown/by-variant` | Dossiers d'un parcours donné |
| `GET /api/llm-status` | Statut du serveur Ollama |
| `POST /api/explain` | Stream SSE depuis le modèle local (briefing / explication) |

**Conventions d'unités** documentées dans chaque docstring : durées en **minutes**, pourcentages en **0–100**, probabilités en **0–1**, dates en **ISO**.

---

## 7. Dépannage

- **`ModuleNotFoundError: httpx`** → `pip install httpx` dans l'environnement Python du backend
- **`Ollama indisponible`** dans l'app → vérifier que `ollama serve` tourne et que le modèle est bien tiré (`ollama list`)
- **Erreur CORS** → s'assurer que le frontend tourne sur `5173` ou ajuster `allow_origins` dans `backend/main.py`
- **Briefing IA très lent à la 1re génération** → normal (chargement du modèle en RAM, ~15 s la première fois). Les suivantes sont quasi-instantanées
- **`2000 patients` qui ne descend pas** dans Parcours → la liste est plafonnée à 2000 ; il faut un filtre suffisamment restrictif (plage de dates courte, mode de sortie rare) pour passer sous ce seuil
