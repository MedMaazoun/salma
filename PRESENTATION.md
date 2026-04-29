# ED Flow Intelligence — Guide de soutenance

> Document de support pour la présentation orale (thèse / mémoire / soutenance technique).
> Combine storytelling, détails techniques, modèles, métriques et plan de démonstration.

---

## 1. Pitch d'ouverture (90 secondes)

> « En France, **un service d'urgences pédiatriques traite en moyenne 50 à 200 dossiers par jour**.
> Pour chaque enfant, un parcours unique : IOA → examen → SAUV → BOX → hospitalisation ou retour.
> Multipliez par 365 jours, ajoutez les pics épidémiques de bronchiolite, les soirs de match,
> les week-ends, et vous obtenez **des dizaines de milliers de trajectoires** que personne ne lit jamais.
>
> Le chef de service dispose aujourd'hui d'**Excel et de son intuition**. Il sait qu'il y a
> "un problème en SAUV", mais il ne peut pas dire **quand**, **combien**, ni **pourquoi**.
>
> ED Flow Intelligence transforme ce log d'événements brut en un **système d'aide à la décision**
> qui combine **process mining**, **statistiques temporelles**, **machine learning** et
> **simulation à événements discrets**, le tout enrichi par un **assistant IA exécuté localement**
> pour préserver la confidentialité des données patient. »

**Phrase-choc à retenir pour le jury :**
> « Nous transformons 38 000 lignes de log en **5 minutes de briefing chaque matin**, sans aucune donnée patient qui ne quitte l'hôpital. »

---

## 2. Le problème (slides 1-3)

### Contexte clinique
- Service d'urgences pédiatriques (CHU)
- Saturation chronique : **+15 % de passages/an** sur la dernière décennie
- Indicateurs cibles HAS : durée de séjour < 4 h, ré-admissions < 5 %, conformité parcours

### Limites des outils actuels
| Outil utilisé | Limite |
|---------------|--------|
| Excel manuel | Pas de temps réel, erreurs de calcul, fragmentation |
| Tableaux de bord génériques (Power BI…) | Pas adaptés au flux patient, pas de simulation, pas d'IA |
| Solutions commerciales | Coût (50 k€+ /an), données cloud, pas customisable |

### Question de recherche
> « Peut-on construire un système open-source, on-premise, qui fournisse au chef de service
> une compréhension **prédictive** et **causale** du flux patient, à partir du seul log d'événements de localisation ? »

---

## 3. Vue d'ensemble de la solution (slide 4)

Architecture en 3 couches, **100 % locale** :

```
┌─────────────────────────────────────────────────────────────┐
│  Frontend (React/TS)   ──── Vite + Tailwind + Recharts      │
│  4 onglets · Command Center · Drill-down · PDF · ⌘K          │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP REST + SSE
┌───────────────────────────▼─────────────────────────────────┐
│  Backend (FastAPI)     ──── pandas · scikit-learn · SimPy   │
│  32 endpoints · cache LRU · streaming Server-Sent Events     │
└───────────────────────────┬─────────────────────────────────┘
                            │ HTTP localhost
┌───────────────────────────▼─────────────────────────────────┐
│  Ollama (LLM local)    ──── qwen2.5:3b/7b · français natif  │
│  RAG contextuel · pas de fuite donnée patient                │
└─────────────────────────────────────────────────────────────┘
```

**Stack technique en 1 phrase :** Python/FastAPI pour la science des données, React/TypeScript pour la visualisation, Ollama pour l'IA générative locale.

---

## 4. Données & préparation (slide 5)

### Source unique
- 1 fichier CSV : `2025_11_10_TrackingUrg.csv`
- Granularité : 1 ligne = 1 passage d'un patient dans 1 local
- Colonnes clés : `DOSSIER_ID`, `PATIENT_ID`, `date_arrivée`, `date_sortie`, `loc_local_libelle`, `loc_heure_debut`, `loc_heure_fin`, `mode_de_sortie`

### Volumétrie
- **~38 000 dossiers** (cas / passages aux urgences)
- **~150 000 événements** (lignes du CSV)
- Période : janvier → novembre 2025 (10 mois)
- ~30 localisations distinctes (IOA, BOX-1…N, SAUV, UHCD, EXA, RX, IRM, …)

### Pipeline de préparation (`_clean()` + `_build_cases()`)
1. **Parsing temporel** : `pd.to_datetime(errors="coerce")` sur 4 colonnes datetime
2. **Calcul des durées événement** : `duration_min = (loc_heure_fin - loc_heure_debut).total_seconds() / 60`
3. **Agrégation case-level** : un dossier = une séquence ordonnée de localisations + un LOS
4. **Features dérivées** : heure d'arrivée, jour de semaine, mois, première localisation, mode de sortie
5. **Cache global** au démarrage du serveur (chargement unique → toutes les requêtes sont rapides)

---

## 5. Modèles statistiques (slides 6-10)

### 5.1 SPC – Cartes de contrôle de Shewhart

**Objectif** : détecter en temps réel une dérive du volume journalier hors contrôle naturel.

**Formules :**
- Limites de contrôle : `UCL = μ + 3σ`, `LCL = μ - 3σ`
- Zones d'alerte : `±2σ` (warning)
- μ = moyenne journalière sur la période, σ = écart-type empirique

**Sortie** : pour chaque jour, statut `normal / warning / signal` + nombre de signaux par règle Shewhart.

### 5.2 SPC – CUSUM bidirectionnel

**Objectif** : détecter des dérives **persistantes** plus subtiles qu'un dépassement ±3σ.

**Formules :**
```
z_i = (x_i - μ) / σ
C+_i = max(0, C+_{i-1} + z_i - k)         (hausse)
C-_i = max(0, C-_{i-1} - z_i - k)         (baisse)
Signal si C±_i > H
```
- `k = 0.5σ` (allowance), `H = 5σ` (decision interval)

### 5.3 Détection de rupture — Binary Segmentation

**Objectif** : trouver automatiquement les **points de changement structurel** dans la série journalière (ex : début d'épidémie de bronchiolite).

**Algorithme** : récursivement, on cherche le point `t*` qui **maximise la réduction du SSE** :
```
t* = argmax_t [ SSE(série_complète) - (SSE(0..t) + SSE(t..n)) ]
```
Profondeur max = 4 ruptures, longueur de segment minimum = 7 jours.

**Sortie** : liste de dates de rupture + moyenne par segment + delta % entre segments consécutifs.

### 5.4 Test avant/après — Mann-Whitney U + Cohen d

**Objectif** : pour une date pivot choisie par l'utilisateur (typiquement après un changement de protocole), comparer **rigoureusement** les distributions de LOS avant et après.

**Méthodologie :**
- **Mann-Whitney U** (non-paramétrique, ne suppose pas la normalité — adapté au LOS qui est skewed) :
  - H₀ : les deux distributions sont identiques
  - p-value bilatérale via approximation normale
- **Cohen's d** : magnitude pratique de l'effet (LOS étant souvent significatif statistiquement à grand N, on a besoin d'une mesure d'amplitude)
  - `d = (μ_après - μ_avant) / σ_pooled`
  - Lecture : |d| < 0.2 négligeable · 0.5 moyen · > 0.8 fort

**Sortie** : statistiques descriptives (médiane, P10, P25, P75, P90) avant/après + p-value + d.

### 5.5 Décomposition STL

Sépare la série journalière en **tendance + saisonnalité + résidu** (saisonnalité = 7 jours).
Permet d'isoler l'effet "jour de semaine" du "trend long terme".

### 5.6 Kaplan-Meier (durée de séjour)

**Objectif** : courbe de survie empirique S(t) = P(durée_séjour > t), stratifiée par jour ouvré vs week-end.

**Formules :**
```
S(t) = ∏_{t_i ≤ t} (1 - d_i / n_i)
```
- t évalué tous les 15 min jusqu'à 24 h
- IC 95 % via approximation binomiale
- Médiane = premier t tel que S(t) ≤ 0.5

**Lecture** : si la courbe week-end est au-dessus de la courbe semaine, les patients restent plus longtemps le week-end (moins d'effectifs).

### 5.7 Clustering patients — K-means + TF-IDF

**Objectif** : identifier des **profils de parcours** sans labellisation manuelle.

**Approche :**
1. Chaque dossier → document = séquence de locations (concaténée)
2. **TF-IDF** sur vocabulaire = top 30 locations
3. **K-means (k=3 ou 4)** sur la matrice TF-IDF
4. Étiquetage automatique par LOS moyen croissant : *Fast track / Standard / Complexe*

**Bonus** : les centroïdes donnent les top-locations de chaque cluster (interprétabilité).

---

## 6. Modèle de prédiction LOS (slide 11)

### 6.1 Architecture

**Gradient Boosting Regressor** (`sklearn.ensemble.GradientBoostingRegressor`) avec **3 modèles parallèles** :
- 1 modèle **MSE** (point prediction)
- 1 modèle **quantile loss α=0.10** (P10)
- 1 modèle **quantile loss α=0.90** (P90)

### 6.2 Features

| Feature | Encodage | Pourquoi |
|---------|----------|----------|
| `hour` (0-23) | numérique | charge horaire |
| `day_of_week` (0-6) | numérique | week-end vs semaine |
| `month` (1-12) | numérique | saisonnalité |
| `first_location` | one-hot top 15 | porte d'entrée détermine le parcours |
| `exit_mode` | one-hot top 8 | hospitalisation ≠ retour domicile |

### 6.3 Entraînement
- Données filtrées : `los_min > 0` (pas de doublon)
- Clip à P99 pour réduire l'effet d'outliers
- Train sur ≥ 50 cas (sinon abort)
- Sortie post-traitée : **garantie p10 ≤ pred ≤ p90** (tri pour éviter les inversions)

### 6.4 Métriques d'évaluation envisageables (à mentionner dans la défense)
- **MAE** sur LOS (en minutes)
- **MAPE** (pour comparer entre services)
- **Coverage** P10/P90 : % d'observations entre p10 et p90 (devrait être ≈ 80 %)
- **Pinball loss** sur quantiles
- Importance des variables (Gini) → fournie via `/api/research/feature-importance`

---

## 7. Simulation à événements discrets — SimPy (slide 12)

### 7.1 Modèle

Système **multi-poste avec files d'attente** :
- **Arrivées** : processus de Poisson **non-homogène** (taux λ(h) estimé empiriquement par heure de la journée)
- **Service** : par local, durée tirée d'une **loi exponentielle** de moyenne empirique (M/M/c-like)
- **Capacités** : nombre de boxes par local, configurables par scénario
- **Routing** : matrice de transitions empirique (probabilité d'aller du local A au local B)

### 7.2 Knobs interactifs
- `extra_boxes` : ajout de boxes au local goulot
- `arrival_multiplier` : facteur multiplicatif sur λ (simuler un pic épidémique)
- `ioa_speedup` : réduction du temps de service IOA (impact d'un nouveau protocole de tri)
- `duration_days` ou `duration_hours` : horizon de simulation

### 7.3 Mode Monte-Carlo
- N réplications par scénario (réduction du bruit aléatoire)
- Sortie : moyennes de LOS, P90 LOS, throughput, attente — **avec intervalle d'incertitude**

### 7.4 Mode trace détaillée
Endpoint dédié `/api/simulate-trace` qui produit :
- Stats par local : queue moyenne, attente P90, % saturation
- Timeseries échantillonnée toutes les 5 min (queue_total, in_service_total)
- Liste des événements (arrival, service_start, departure)

→ permet le rendu d'une **vidéo "battement de cœur"** du service simulé.

---

## 8. Process mining (slide 13)

### 8.1 Directly-Follows Graph
- Nœuds : top 25 localisations
- Arêtes : transition A → B observée + count + avg_wait_min entre A et B
- Visualisation : **React Flow + dagre** (layout automatique)

### 8.2 Sankey 3 étapes
- 3 colonnes (étape 1, 2, 3) + colonne sortie
- Flux pondérés par nombre de dossiers
- Met en évidence les **goulots de transition** (ex. 70 % passent par BOX-1 → SAUV)

### 8.3 Conformité du parcours
Règles métier vérifiées par dossier :
- Le parcours commence par IOA / Tri / Accueil
- Au moins un BOX ou une SALLE est traversé
- L'ordre BOX-avant-IOA n'est pas observé

**Métrique** : `conformance_rate` = part de dossiers conformes (en 0–100 %).

### 8.4 Détection d'anomalies
- LOS > μ + 3σ
- Variantes rares (< 0.5 % du total)
- Sortie : top 50 dossiers anormaux + raison explicite

### 8.5 Pathway Intelligence (prédiction de la prochaine étape)
- Modèle **bigramme avec Jelinek-Mercer smoothing** (λ=0.65 vs unigramme)
- Sortie : top 7 prochaines locations + probabilité + LOS résiduel médian + entropie de Shannon (mesure d'incertitude)

---

## 9. Assistant IA local (slide 14)

### 9.1 Pourquoi local ?
- **RGPD** : aucune donnée patient ne quitte l'hôpital
- **Coût** : 0 €/requête vs ~0,01 €/requête sur un LLM cloud
- **Latence** : ~30 tokens/sec sur un MacBook M-series
- **Contrôle** : on peut spécialiser le system prompt à 100 % sur le contexte ED

### 9.2 Stack
- **Ollama** (runtime) — API REST compatible OpenAI sur `localhost:11434`
- **Modèles supportés** : qwen2.5:3b (~2 Go), qwen2.5:7b (~5 Go), mistral-small:24b (~14 Go)
- **Streaming** : Server-Sent Events (SSE) du backend FastAPI vers le frontend React
- **Persona** : "Expert en ingénierie industrielle ET management des services d'urgence"

### 9.3 Prompts spécialisés (4 modes)
| Kind | Usage |
|------|-------|
| `briefing` | Synthèse matinale 5 puces (activité, goulots, sorties, qualité, recommandation) |
| `rupture` | Explication d'une détection de rupture |
| `avant_apres` | Interprétation Mann-Whitney + Cohen d |
| `general` | Question libre de l'utilisateur |

### 9.4 RAG contextuel (pas de vector DB)
- **Pas de RAG vectoriel** (on n'a qu'une seule source : les KPI calculés)
- Chaque requête envoie un **snapshot JSON** du tableau de bord (KPIs, top goulots, variantes, sorties, réadmissions, période, filtres) + un **focus** spécifique à l'onglet ouvert
- Le LLM est forcé de citer les chiffres exacts du JSON, jamais d'inventer

---

## 10. Métriques opérationnelles affichées (slide 15)

### 10.1 KPIs primaires
| Métrique | Unité | Source | Norme HAS |
|----------|-------|--------|-----------|
| Total dossiers | count | période filtrée | — |
| LOS médian (P50) | minutes | distribution case-level | < 240 min |
| LOS P90 | minutes | distribution case-level | < 480 min |
| Taux d'hospitalisation | % | mode_sortie contains "Hospit" | ~20-25 % typique |
| Réadmissions 7 j | % | retour <7j d'un même patient | < 5 % |
| Réadmissions 30 j | % | retour <30j d'un même patient | < 8 % |

### 10.2 KPIs de flux
- **Délai premier soin** : arrivée → premier événement non-attente (avg, P25, P75, P90)
- **Attente sortie** : fin de prise en charge → sortie réelle
- **Taux de réorientation** : % de dossiers transférés
- **Throughput per day** : dossiers traités / jours calendaires

### 10.3 KPIs de qualité
- Taux de conformité du parcours
- Taux d'anomalies (LOS aberrant ou variante rare)
- % temps saturation par local (simulation)

---

## 11. Démonstration en direct (8 minutes) — plan slide-par-slide

| Min | Onglet / Action | Message à faire passer |
|-----|----------------|------------------------|
| 0:00 | **Monitoring** | « Voici l'état du service en temps réel, en un coup d'œil » |
| 0:30 | Bouton **Activer briefing IA** + clic | « L'IA locale rédige automatiquement la synthèse matinale en 15 secondes » |
| 1:30 | Click sur un goulot rouge | « Drill-down : on voit les dossiers concernés et leurs LOS individuels » |
| 2:30 | **Replay → Carte du flux** | « Le process mining révèle le flux réel — pas le flux théorique » |
| 3:30 | **Replay → Variantes**, click sur la #1 | « 35 % des patients suivent ce parcours-type ; click → liste détaillée » |
| 4:30 | **Replay → Parcours patients**, sélection d'un dossier | « Timeline individuelle ou Gantt — selon ce que vous cherchez » |
| 5:30 | **Prospectif → Détection de rupture** | « L'algo Binary Segmentation a trouvé une rupture le 14 octobre — le pic de bronchiolite » |
| 6:30 | **Prospectif → Test avant/après** + clic suggestion IA | « Mann-Whitney + Cohen d : la baisse est statistiquement significative ET cliniquement modérée » |
| 7:30 | **⌘K** + recherche "PDF" | « Palette de commandes — tout est accessible en 2 touches » |
| 8:00 | Génération **PDF** | « Et voilà le rapport opérationnel pour le prochain comité de direction » |

---

## 12. Limites et perspectives (slide 16)

### 12.1 Limites identifiées
- **Données déclaratives** : qualité des timestamps dépend de la saisie infirmière
- **Pas de tz_localize** : les calculs DST peuvent décaler de ±1 h aux passages d'heure
- **Plafond 2000 résultats** sur `/api/patients` (à lever pour production)
- **Pas de RBAC** : tous les utilisateurs voient tout (pour soutenance, mais pas en prod)
- **Pas de tests automatisés** (Playwright/Vitest absents → à ajouter pour passer en prod)

### 12.2 Évolutions envisagées
- **Streaming temps réel** via WebSocket (au lieu du polling actuel)
- **Vector DB** sur les protocoles internes pour un vrai RAG médical
- **Modèle de prédiction des admissions** (J+1, J+7) — passer de réactif à proactif
- **Mode multi-services** : étendre au-delà des urgences pédiatriques
- **Audit trail RGPD** + anonymisation au runtime

### 12.3 Apport scientifique de la thèse
- **Combinaison originale** : process mining + DES + LLM local dans un même outil
- **Validation empirique** : les ruptures détectées par l'algo correspondent à des événements connus du chef de service (validation expert)
- **Reproductible** : 100 % open-source, déployable sur n'importe quel CHU avec un CSV similaire

---

## 13. FAQ — questions probables du jury

### Q : « Pourquoi pas un modèle plus sophistiqué qu'un Gradient Boosting pour le LOS ? »
**R** : Trois raisons. (1) Les Gradient Boosters sont **état de l'art sur du tabulaire** (cf. compétitions Kaggle). (2) Ils sont **interprétables** via feature importance (essentiel en médical). (3) Un modèle deep learning (LSTM, Transformer) demanderait > 100 k cas pour bien généraliser, on en a 38 k.

### Q : « Le test Mann-Whitney suffit-il vraiment ? »
**R** : Combiné avec Cohen d, oui. La p-value seule sur 38 k cas est presque toujours significative (puissance excessive). C'est précisément pour cela qu'on rapporte la **taille d'effet** — on évite la sur-interprétation.

### Q : « Le LLM peut-il halluciner sur les données patient ? »
**R** : Le system prompt force le modèle à citer les chiffres du JSON contextuel et lui interdit d'inventer. On a aussi tronqué le contexte à 6 000 caractères pour rester dans la fenêtre du modèle 3B. Pour les hallucinations résiduelles, l'utilisateur médical reste responsable de la vérification — l'IA est explicitement positionnée comme **aide à la décision, pas substitut**.

### Q : « Pourquoi SimPy et pas une lib commerciale (FlexSim, Arena…) ? »
**R** : SimPy est **gratuit, open-source, Python natif** — donc intégrable directement dans le pipeline de données (pas d'export/import). Un export FlexSim est néanmoins fourni pour ceux qui préfèrent. La complexité du modèle ED (M/M/c multi-postes avec routing empirique) est largement à la portée de SimPy.

### Q : « Comment validez-vous la simulation ? »
**R** : Trois angles. (1) Calibration : on rejoue les arrivées historiques, et le LOS simulé doit être proche du LOS observé. (2) Sensibilité : doubler λ doit doubler approximativement les attentes (loi de Little). (3) Validation expert : le chef de service confirme que les goulots détectés sont ceux qu'il observe.

### Q : « Qu'est-ce qui différencie cet outil de Power BI / Tableau ? »
**R** : Trois choses. (1) **Process mining intégré** (DFG, Sankey, conformité) absent des outils BI. (2) **Simulation prédictive** ("et si j'ajoutais 2 boxes ?") impossible en BI. (3) **IA générative locale** pour la rédaction de briefings — c'est de l'**intelligence augmentée**, pas seulement de la visualisation.

---

## 14. Aide-mémoire chiffres-clés

À avoir en tête pendant la défense :

```
Dataset       : ~38 000 dossiers · ~150 000 événements · 10 mois
LOS médian    : ~3 h 30 (à confirmer sur les données réelles)
Hospit rate   : ~20-25 %
Réadmissions  : 7j ~3 % · 30j ~8 %
Endpoints API : 32
Modèles       : GBM x 3 (point + p10 + p90)
Sim           : SimPy DES non-homogène, Monte-Carlo k=10
LLM           : qwen2.5:3b (1.9 Go) · 30 tok/s sur M2
PDF           : 6 pages · 4 sections + cover + briefing
Code          : ~2900 lignes Python · ~6000 lignes TypeScript
```

---

## 15. Une dernière chose pour le jury

Dis ceci à la fin, avant les questions :

> « Cet outil n'est pas une thèse purement académique : il **tourne aujourd'hui** sur un MacBook,
> consomme un CSV brut d'un service d'urgences, et produit en moins de 2 secondes
> un tableau de bord exploitable. Le code est intégralement open-source, documenté avec
> les unités explicites de chaque endpoint, et **prêt à être déployé** dans n'importe quel
> CHU disposant du même format de log.
>
> J'ai voulu construire un outil qui réponde à la question d'un chef de service —
> "que se passe-t-il **vraiment** dans mon service, et qu'est-ce que je peux y faire ?" —
> avec la rigueur d'un travail de thèse et le pragmatisme d'un produit utilisable demain matin. »
