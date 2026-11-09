"""FastAPI service for 24-hour physics-informed boundary prediction."""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from math import cos, exp, radians, sin
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd
import requests
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from pyproj import CRS, Transformer
from shapely.geometry import MultiPolygon, Polygon, mapping, shape
from xgboost import XGBClassifier, XGBRegressor

from rothermel import fuel_model_4_ros
from train_hurdle import FEATURE_COLUMNS


FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
MAX_VERTEX_COUNT = 1_000
MAX_SPREAD_METERS = 10_000.0


class GeoJSONFeature(BaseModel):
    type: Literal["Feature"]
    geometry: dict[str, Any]
    properties: dict[str, Any] = Field(default_factory=dict)


class UpstreamDataError(RuntimeError):
    """Raised when required live environmental data cannot be retrieved."""


@dataclass(frozen=True)
class LiveWeather:
    temperature_c: float
    humidity_percent: float
    surface_pressure_hpa: float
    wind_speed_m_s: float
    wind_from_degrees: float
    temperature_min_c: float
    temperature_max_c: float
    precipitation_mm: float


class OpenMeteoClient:
    """Fetch current weather at the centroid and elevation at every vertex."""

    def __init__(self, session: requests.Session | None = None) -> None:
        self.session = session or requests.Session()

    def weather(self, latitude: float, longitude: float) -> LiveWeather:
        params = {
            "latitude": latitude, "longitude": longitude,
            "current": (
                "temperature_2m,relative_humidity_2m,precipitation,"
                "surface_pressure,wind_speed_10m,wind_direction_10m"
            ),
            "daily": "temperature_2m_min,temperature_2m_max,precipitation_sum",
            "wind_speed_unit": "ms", "timezone": "auto", "forecast_days": 1,
        }
        try:
            response = self.session.get(FORECAST_URL, params=params, timeout=(3, 10))
            response.raise_for_status()
            data = response.json()
            current, daily = data["current"], data["daily"]
            return LiveWeather(
                temperature_c=float(current["temperature_2m"]),
                humidity_percent=float(current["relative_humidity_2m"]),
                surface_pressure_hpa=float(current["surface_pressure"]),
                wind_speed_m_s=float(current["wind_speed_10m"]),
                wind_from_degrees=float(current["wind_direction_10m"]),
                temperature_min_c=float(daily["temperature_2m_min"][0]),
                temperature_max_c=float(daily["temperature_2m_max"][0]),
                precipitation_mm=float(daily["precipitation_sum"][0]),
            )
        except (requests.RequestException, KeyError, TypeError, ValueError) as exc:
            raise UpstreamDataError(f"Open-Meteo weather request failed: {exc}") from exc

    def elevations(self, coordinates: list[tuple[float, float]]) -> list[float]:
        result: list[float] = []
        for start in range(0, len(coordinates), 100):
            chunk = coordinates[start:start + 100]
            params = {
                "longitude": ",".join(str(point[0]) for point in chunk),
                "latitude": ",".join(str(point[1]) for point in chunk),
            }
            try:
                response = self.session.get(ELEVATION_URL, params=params, timeout=(3, 10))
                response.raise_for_status()
                values = [float(value) for value in response.json()["elevation"]]
            except (requests.RequestException, KeyError, TypeError, ValueError) as exc:
                raise UpstreamDataError(f"Open-Meteo elevation request failed: {exc}") from exc
            if len(values) != len(chunk):
                raise UpstreamDataError("Open-Meteo returned the wrong elevation count")
            result.extend(values)
        return result


def specific_humidity(temperature_c: float, relative_humidity: float, pressure_hpa: float) -> float:
    """Convert relative humidity to kg/kg specific humidity."""
    saturation_vapor_pressure = 6.112 * exp(
        17.67 * temperature_c / (temperature_c + 243.5)
    )
    vapor_pressure = max(0.0, min(100.0, relative_humidity)) / 100.0 * saturation_vapor_pressure
    return 0.622 * vapor_pressure / (pressure_hpa - 0.378 * vapor_pressure)


def utm_crs(longitude: float, latitude: float) -> CRS:
    if not -80.0 <= latitude <= 84.0:
        raise ValueError("local UTM projection supports latitudes from -80 to 84 degrees")
    zone = min(60, max(1, int((longitude + 180.0) // 6.0) + 1))
    return CRS.from_epsg((32600 if latitude >= 0 else 32700) + zone)


def _polygon_rings(geometry: Polygon | MultiPolygon) -> list[list[tuple[float, float]]]:
    polygons = [geometry] if isinstance(geometry, Polygon) else list(geometry.geoms)
    return [list(ring.coords)[:-1] for polygon in polygons
            for ring in (polygon.exterior, *polygon.interiors)]


def _rebuild_geometry(
    template: Polygon | MultiPolygon, rings: list[list[tuple[float, float]]],
) -> Polygon | MultiPolygon:
    polygons = [template] if isinstance(template, Polygon) else list(template.geoms)
    rebuilt, index = [], 0
    for polygon in polygons:
        exterior = rings[index]; index += 1
        holes = []
        for _ in polygon.interiors:
            holes.append(rings[index]); index += 1
        rebuilt.append(Polygon(exterior, holes))
    result: Polygon | MultiPolygon = rebuilt[0] if len(rebuilt) == 1 else MultiPolygon(rebuilt)
    if not result.is_valid:
        result = result.buffer(0)
    if result.is_empty or result.geom_type not in {"Polygon", "MultiPolygon"}:
        raise ValueError("predicted coordinates did not form a polygon")
    return result


class PredictionService:
    def __init__(
        self, classifier: Any, regressor: Any, metadata: dict[str, Any],
        environment: OpenMeteoClient | Any,
    ) -> None:
        if metadata["features"] != list(FEATURE_COLUMNS):
            raise ValueError("model metadata does not match the inference feature contract")
        self.classifier = classifier
        self.regressor = regressor
        self.metadata = metadata
        self.environment = environment

    @classmethod
    def load(cls, metadata_path: Path) -> "PredictionService":
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

        def model_path(key: str) -> Path:
            configured = Path(metadata["models"][key])
            return configured if configured.exists() else metadata_path.parent / configured.name

        classifier, regressor = XGBClassifier(), XGBRegressor()
        classifier.load_model(model_path("classifier"))
        regressor.load_model(model_path("regressor"))
        return cls(classifier, regressor, metadata, OpenMeteoClient())

    def predict(self, feature: dict[str, Any]) -> dict[str, Any]:
        geometry = shape(feature["geometry"])
        if geometry.geom_type not in {"Polygon", "MultiPolygon"} or geometry.is_empty:
            raise ValueError("geometry must be a non-empty Polygon or MultiPolygon")
        if not geometry.is_valid:
            raise ValueError("input geometry must be valid")
        if any(not (-180 <= x <= 180 and -90 <= y <= 90) for ring in _polygon_rings(geometry) for x, y in ring):
            raise ValueError("geometry coordinates must use EPSG:4326 longitude/latitude")

        rings = _polygon_rings(geometry)
        coordinates = [point for ring in rings for point in ring]
        if len(coordinates) < 3 or len(coordinates) > MAX_VERTEX_COUNT:
            raise ValueError(f"boundary must contain 3 to {MAX_VERTEX_COUNT} vertices")
        centroid = geometry.centroid
        weather = self.environment.weather(centroid.y, centroid.x)
        elevations = self.environment.elevations(coordinates)
        physics = fuel_model_4_ros(weather.wind_speed_m_s, weather.wind_from_degrees)
        match_radius = min(MAX_SPREAD_METERS, max(1_000.0, physics.distance_24h_m * 1.5))
        baseline = min(physics.distance_24h_m, match_radius)
        defaults = self.metadata["runtime_defaults"]
        humidity = specific_humidity(
            weather.temperature_c, weather.humidity_percent, weather.surface_pressure_hpa
        )
        rows = pd.DataFrame({
            "elevation": elevations, "vs": weather.wind_speed_m_s,
            "wind_from_sin": sin(radians(weather.wind_from_degrees)),
            "wind_from_cos": cos(radians(weather.wind_from_degrees)),
            "tmmn": weather.temperature_min_c + 273.15,
            "tmmx": weather.temperature_max_c + 273.15,
            "sph": humidity, "pr": weather.precipitation_mm,
            "pdsi": defaults["pdsi"]["value"], "NDVI": defaults["NDVI"]["value"],
            "population": defaults["population"]["value"], "erc": defaults["erc"]["value"],
            "physics_ros_m_min": physics.rate_m_min,
            "physics_heading_sin": sin(radians(physics.heading_degrees)),
            "physics_heading_cos": cos(radians(physics.heading_degrees)),
            "physics_baseline_distance_m": baseline,
        }, columns=FEATURE_COLUMNS, dtype=np.float32)
        probabilities = self.classifier.predict_proba(rows)[:, 1]
        spreading = probabilities >= float(self.metadata["classifier_threshold"])
        residuals = np.zeros(len(rows), dtype=np.float32)
        if spreading.any():
            residuals[spreading] = self.regressor.predict(rows.loc[spreading])
        distances = np.where(spreading, np.clip(baseline + residuals, 0, MAX_SPREAD_METERS), 0)

        metric_crs = utm_crs(centroid.x, centroid.y)
        forward = Transformer.from_crs("EPSG:4326", metric_crs, always_xy=True)
        inverse = Transformer.from_crs(metric_crs, "EPSG:4326", always_xy=True)
        x, y = forward.transform(
            [coordinate[0] for coordinate in coordinates],
            [coordinate[1] for coordinate in coordinates],
        )
        east = np.sin(np.deg2rad(physics.heading_degrees)) * distances
        north = np.cos(np.deg2rad(physics.heading_degrees)) * distances
        predicted_lon, predicted_lat = inverse.transform(np.asarray(x) + east, np.asarray(y) + north)
        predicted_flat = list(zip(predicted_lon, predicted_lat))
        predicted_rings, offset = [], 0
        for ring in rings:
            predicted_rings.append(predicted_flat[offset:offset + len(ring)])
            offset += len(ring)
        predicted = _rebuild_geometry(geometry, predicted_rings)

        return {
            "type": "Feature", "geometry": mapping(predicted),
            "properties": {
                "type": "predicted_spread", "horizon_hours": 24,
                "model_run_id": self.metadata["run_id"],
                "feature_set_version": self.metadata["feature_set_version"],
                "classifier_threshold": self.metadata["classifier_threshold"],
                "vertex_count": len(coordinates), "spreading_vertices": int(spreading.sum()),
                "mean_spread_probability": float(probabilities.mean()),
                "mean_displacement_m": float(distances.mean()),
                "max_displacement_m": float(distances.max()),
                "physics_heading_degrees": physics.heading_degrees,
                "physics_baseline_distance_m": baseline, "utm_epsg": metric_crs.to_epsg(),
                "weather": {
                    "temperature_c": weather.temperature_c,
                    "relative_humidity_percent": weather.humidity_percent,
                    "wind_speed_m_s": weather.wind_speed_m_s,
                    "wind_from_degrees": weather.wind_from_degrees,
                    "daily_precipitation_mm": weather.precipitation_mm,
                },
                "fallback_features": list(defaults),
                "data_sources": ["Open-Meteo", "Copernicus DEM GLO-90 via Open-Meteo"],
                "limitations": [
                    "Fuel Model 4 and zero terrain slope are MVP assumptions",
                    "PDSI, NDVI, population and ERC use training-set medians",
                ],
            },
        }


def resolve_metadata_path() -> Path:
    configured = os.getenv("HURDLE_METADATA_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    matches = sorted((Path(__file__).parent / "models").glob("*_hurdle_v1_metadata.json"))
    if not matches:
        raise RuntimeError("no hurdle model metadata found")
    return matches[-1]


@asynccontextmanager
async def lifespan(application: FastAPI):
    application.state.predictor = PredictionService.load(resolve_metadata_path())
    yield


app = FastAPI(title="Ignis AI Spread Inference", version="1.0.0", lifespan=lifespan)


@app.get("/health")
def health(request: Request) -> dict[str, Any]:
    predictor = request.app.state.predictor
    return {"status": "ok", "model_run_id": predictor.metadata["run_id"]}


@app.post("/predict")
def predict(feature: GeoJSONFeature, request: Request) -> dict[str, Any]:
    try:
        return request.app.state.predictor.predict(feature.model_dump())
    except UpstreamDataError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
