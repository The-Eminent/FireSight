# FireSight

FireSight is a wildfire detection and 24-hour spread-prediction capstone. It
combines recent satellite thermal observations with official US incident data,
shows consolidated events on a Mapbox map, builds a current fire boundary on
demand, and sends that boundary through a physics-informed XGBoost model.

> FireSight is a research prototype. Its detections and predictions are not
> emergency guidance and must not replace official agency information.

## What it does

- Ingests NASA FIRMS NOAA-20 and NOAA-21 VIIRS observations.
- Deduplicates observations and filters curated industrial heat sources.
- Enriches observations with urban-area context without automatically calling
  urban heat a structural fire.
- Matches satellite observations to NIFC/WFIGS incidents using acreage-scaled
  geospatial search radii.
- Groups unmatched observations with 1.5 km/minimum-3 DBSCAN clustering.
- Distinguishes confirmed wildfires, satellite-detected fires, unverified
  thermal anomalies, and official reports without recent satellite detection.
- Displays saved WFIGS perimeters when available; otherwise it can construct an
  estimated footprint from the satellite cluster.
- Predicts a 24-hour boundary using Fuel Model 4 Rothermel physics plus an
  XGBoost classifier/regressor hurdle model.

## Architecture

```text
NASA FIRMS + NIFC/WFIGS
          |
          v
scheduled Express ingestion worker
          |
          v
MongoDB GeoJSON + 2dsphere indexes
          |
          v
React/Mapbox event map
          |
          +--> current official/estimated boundary
          |
          +--> Express prediction proxy --> FastAPI --> XGBoost + Open-Meteo
                                                    --> predicted GeoJSON
```

| Layer | Technology |
|---|---|
| Frontend | React 19, Mapbox GL JS, Axios |
| Public API | Node.js, Express, Mongoose |
| Database | MongoDB with native GeoJSON and `2dsphere` indexes |
| Geospatial/ML | Python 3.11, Shapely, PyProj, scikit-learn, XGBoost |
| Inference | FastAPI/Uvicorn with models loaded once at startup |

## Repository layout

```text
ignis-ai-frontend/          React map, controls, perimeter and prediction UI
ignis-ai-backend/
  models/                   MongoDB/Mongoose schemas
  routes/                   Public Express endpoints
  services/                 Ingestion, matching, clustering and persistence
  scripts/                  Database migration and reference-data utilities
  ml/                       Geometry, training and FastAPI inference code
    models/                 Versioned XGBoost JSON runtime artifacts
    experiments/runs.csv    Held-out model metrics
```

Raw TFRecords and generated training CSVs are intentionally excluded from Git.
The small runtime XGBoost artifacts under `ml/models/` are included.

## Prerequisites

- Node.js 18+ and npm
- Python 3.11
- MongoDB locally or through Atlas
- A NASA FIRMS API key
- A public Mapbox token beginning with `pk.`
- macOS: Homebrew `libomp` is required by XGBoost (`brew install libomp`)

## Local setup

Clone the repository:

```bash
git clone https://github.com/The-Eminent/FireSight.git
cd FireSight
```

Install backend and Python dependencies:

```bash
cd ignis-ai-backend
npm install
python3.11 -m venv ml/venv
ml/venv/bin/pip install -r ml/requirements-detection.txt \
  -r ml/requirements-inference.txt
cp .env.example .env
```

Edit `ignis-ai-backend/.env`:

```dotenv
PORT=5001
PREDICTION_SERVICE_URL=http://127.0.0.1:8000
MONGODB_URI=mongodb://localhost:27017/ignis_ai
NASA_API_KEY=your_firms_key
MAPBOX_ACCESS_TOKEN=<your-public-mapbox-token>
PYTHON_COMMAND=./ml/venv/bin/python
```

Install and configure the frontend:

```bash
cd ../ignis-ai-frontend
npm install
```

Create `ignis-ai-frontend/.env`:

```dotenv
REACT_APP_MAPBOX_TOKEN=<your-public-mapbox-token>
REACT_APP_API_BASE_URL=http://localhost:5001/api
```

Never put a Mapbox secret token beginning with `sk.` in frontend code. Both
local `.env` files are ignored by Git.

Initialize MongoDB indexes from `ignis-ai-backend/`:

```bash
npm run db:migrate-geo
```

Optional maintenance commands:

```bash
npm run db:sync-spatial
ml/venv/bin/python seed_industry.py
npm run data:refresh
```

## Run locally

Start all three development services from the repository root:

```bash
npm run dev
```

Press `Ctrl+C` once to stop FastAPI, Express and React together. To run the
services separately for debugging, use the individual commands below.

```bash
# Terminal 1 — ignis-ai-backend/
ml/venv/bin/uvicorn inference_api:app --app-dir ml \
  --host 127.0.0.1 --port 8000

# Terminal 2 — ignis-ai-backend/
npm start

# Terminal 3 — ignis-ai-frontend/
npm start
```

Open `http://localhost:3000`. Express runs on port 5001 and FastAPI on 8000.
The backend refresh worker runs on startup and every 15 minutes by default.

## Main API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/wildfires` | Read the latest completed event snapshot |
| `POST` | `/api/wildfires/refresh` | Request a guarded background refresh |
| `POST` | `/api/detection-polygon` | Return official or estimated current boundary |
| `POST` | `/api/predict-fire-spread` | Proxy boundary prediction to FastAPI |
| `GET` | `http://127.0.0.1:8000/health` | Check loaded model/service health |

## Tests

```bash
# Backend
cd ignis-ai-backend && npm test

# Python ML/geospatial tests
cd ignis-ai-backend/ml && venv/bin/python -m unittest -v

# Focused frontend tests and production build
cd ignis-ai-frontend
CI=true npm test -- --watchman=false --runInBand src/components
npm run build
```

## Model and data notes

The active model was trained from the Next Day Wildfire Spread TFRecords. The
pipeline extracts boundary-point tables, applies a Fuel Model 4 Rothermel
baseline, classifies spread/no-spread, and regresses residual movement only for
positive points. Training preserves the dataset's supplied train/eval/test
splits and logs metrics in `ml/experiments/runs.csv`.

The latest `boundary_physics_v2` experiment adds boundary/wind alignment, 7×7
local fire density and slope-wind interaction. Against the v1 test baseline,
classifier precision improved from 0.245 to 0.293, recall from 0.446 to 0.551,
and positive-only residual RMSE from 2.545 km to 2.466 km. These are useful but
still preliminary results, not operational accuracy.

FastAPI loads the 19-feature v2 model. It derives boundary/wind alignment from
the projected polygon, estimates terrain slope from a 1 km Open-Meteo elevation
stencil, and uses local polygon area as an explicit proxy for the unavailable
7×7 live-raster density. Live inference also uses fixed Fuel Model 4 assumptions
and median fallbacks for features unavailable from Open-Meteo. Estimated
satellite footprints represent recent thermal-observation geometry, not an
official burned-area perimeter.

## Data sources

- NASA FIRMS — NOAA-20/NOAA-21 VIIRS active-fire observations
- NIFC WFIGS — official incident locations, acreage, containment and perimeters
- US Census TIGERweb — urban-area context
- EPA GHGRP and EOG VIIRS flare catalogs — industrial heat-source exclusions
- Open-Meteo and Copernicus GLO-90 — live weather and elevation
- Next Day Wildfire Spread dataset — model training

