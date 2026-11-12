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
from shapely.geometry import MultiPoint, MultiPolygon, Polygon, box, mapping, shape
from shapely.ops import transform, unary_union
from xgboost import XGBClassifier, XGBRegressor

from rothermel import fuel_model_4_ros
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
MAX_VERTEX_COUNT = 1_000
MAX_DENSIFIED_VERTEX_COUNT = 5_000
MAX_SPREAD_METERS = 10_000.0
MAX_SEGMENT_LENGTH_METERS = 100.0
NDWS_PIXEL_METERS = 1_000.0
DENSITY_HALF_WINDOW_METERS = 3_500.0
INFERENCE_FEATURE_COLUMNS = (
    "elevation", "vs", "wind_from_sin", "wind_from_cos", "tmmn", "tmmx",
    "sph", "pr", "pdsi", "NDVI", "population", "erc",
    "physics_ros_m_min", "physics_heading_sin", "physics_heading_cos",
    "physics_baseline_distance_m", "wind_alignment_cosine",
    "neighboring_fire_pixels", "slope_wind_interaction",
)


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


def _ring_hole_flags(geometry: Polygon | MultiPolygon) -> list[bool]:
    polygons = [geometry] if isinstance(geometry, Polygon) else list(geometry.geoms)
    return [is_hole for polygon in polygons
            for is_hole in (False, *(True for _ in polygon.interiors))]


def _segmentize_metric_geometry(
    geometry: Polygon | MultiPolygon,
) -> Polygon | MultiPolygon:
    """Add boundary vertices so no metric edge exceeds 100 metres."""
    segmentized = geometry.segmentize(MAX_SEGMENT_LENGTH_METERS)
    vertex_count = sum(len(ring) for ring in _polygon_rings(segmentized))
    if vertex_count > MAX_DENSIFIED_VERTEX_COUNT:
        raise ValueError(
            f"segmentized boundary exceeds {MAX_DENSIFIED_VERTEX_COUNT} vertices"
        )
    return segmentized


def _live_geometry_features(
    geometry: Polygon | MultiPolygon,
    rings: list[list[tuple[float, float]]],
    holes: list[bool],
    wind_from_degrees: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Approximate NDWS raster geometry features from a metric live polygon."""
    downwind = radians((wind_from_degrees + 180.0) % 360.0)
    wind_east, wind_north = sin(downwind), cos(downwind)
    alignments, densities = [], []
    for ring, is_hole in zip(rings, holes):
        area_twice = sum(
            ring[index][0] * ring[(index + 1) % len(ring)][1]
            - ring[(index + 1) % len(ring)][0] * ring[index][1]
            for index in range(len(ring))
        )
        orientation = 1.0 if area_twice >= 0.0 else -1.0
        outward_sign = -orientation if is_hole else orientation
        for index, (east, north) in enumerate(ring):
            previous, following = ring[index - 1], ring[(index + 1) % len(ring)]
            tangent_east = following[0] - previous[0]
            tangent_north = following[1] - previous[1]
            normal_east = outward_sign * tangent_north
            normal_north = -outward_sign * tangent_east
            length = np.hypot(normal_east, normal_north)
            alignment = (
                (normal_east * wind_east + normal_north * wind_north) / length
                if length else 0.0
            )
            alignments.append(float(np.clip(alignment, -1.0, 1.0)))
            local_window = box(
                east - DENSITY_HALF_WINDOW_METERS,
                north - DENSITY_HALF_WINDOW_METERS,
                east + DENSITY_HALF_WINDOW_METERS,
                north + DENSITY_HALF_WINDOW_METERS,
            )
            active_pixels = geometry.intersection(local_window).area / NDWS_PIXEL_METERS**2
            densities.append(float(np.clip(active_pixels - 1.0, 0.0, 48.0)))
    return np.asarray(alignments), np.asarray(densities)


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
        if metadata["features"] != list(INFERENCE_FEATURE_COLUMNS):
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

        input_rings = _polygon_rings(geometry)
        input_coordinates = [point for ring in input_rings for point in ring]
        if len(input_coordinates) < 3 or len(input_coordinates) > MAX_VERTEX_COUNT:
            raise ValueError(f"boundary must contain 3 to {MAX_VERTEX_COUNT} vertices")
        centroid = geometry.centroid
        metric_crs = utm_crs(centroid.x, centroid.y)
        forward = Transformer.from_crs("EPSG:4326", metric_crs, always_xy=True)
        inverse = Transformer.from_crs(metric_crs, "EPSG:4326", always_xy=True)
        x, y = forward.transform(
            [coordinate[0] for coordinate in input_coordinates],
            [coordinate[1] for coordinate in input_coordinates],
        )
        metric_rings, offset = [], 0
        for ring in input_rings:
            metric_rings.append(list(zip(x[offset:offset + len(ring)], y[offset:offset + len(ring)])))
            offset += len(ring)
        metric_geometry = _rebuild_geometry(geometry, metric_rings)
        metric_geometry = _segmentize_metric_geometry(metric_geometry)
        metric_rings = _polygon_rings(metric_geometry)
        metric_coordinates = [point for ring in metric_rings for point in ring]
        x = np.asarray([point[0] for point in metric_coordinates])
        y = np.asarray([point[1] for point in metric_coordinates])
        longitude, latitude = inverse.transform(x, y)
        coordinates = list(zip(longitude, latitude))

        weather = self.environment.weather(centroid.y, centroid.x)
        center_east, center_north = forward.transform(centroid.x, centroid.y)
        sample_lon, sample_lat = inverse.transform(
            [center_east, center_east + NDWS_PIXEL_METERS, center_east],
            [center_north, center_north, center_north + NDWS_PIXEL_METERS],
        )
        elevation_values = self.environment.elevations(
            coordinates + list(zip(sample_lon, sample_lat))
        )
        elevations, terrain = elevation_values[:-3], elevation_values[-3:]
        slope_east = (terrain[1] - terrain[0]) / NDWS_PIXEL_METERS
        slope_north = (terrain[2] - terrain[0]) / NDWS_PIXEL_METERS
        slope = float(np.hypot(slope_east, slope_north))
        physics = fuel_model_4_ros(
            weather.wind_speed_m_s, weather.wind_from_degrees, slope_east, slope_north
        )
        alignment, density = _live_geometry_features(
            metric_geometry, metric_rings, _ring_hole_flags(metric_geometry),
            weather.wind_from_degrees,
        )
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
            "wind_alignment_cosine": alignment,
            "neighboring_fire_pixels": density,
            "slope_wind_interaction": slope * weather.wind_speed_m_s * alignment,
        }, columns=INFERENCE_FEATURE_COLUMNS, dtype=np.float32)
        probabilities = self.classifier.predict_proba(rows)[:, 1]
        spreading = probabilities >= float(self.metadata["classifier_threshold"])
        residuals = np.zeros(len(rows), dtype=np.float32)
        if spreading.any():
            residuals[spreading] = self.regressor.predict(rows.loc[spreading])
        distances = np.where(spreading, np.clip(baseline + residuals, 0, MAX_SPREAD_METERS), 0)

        east = np.sin(np.deg2rad(physics.heading_degrees)) * distances
        north = np.cos(np.deg2rad(physics.heading_degrees)) * distances
        translated_points = MultiPoint(
            [
                (x[index] + east[index], y[index] + north[index])
                for index in np.flatnonzero(spreading)
            ]
        )
        if translated_points.is_empty:
            predicted_metric = metric_geometry
        else:
            growth_envelope = unary_union(
                [metric_geometry.boundary, translated_points]
            ).convex_hull
            predicted_metric = metric_geometry.union(growth_envelope)
        predicted = transform(inverse.transform, predicted_metric)

        return {
            "type": "Feature", "geometry": mapping(predicted),
            "properties": {
                "type": "predicted_spread", "horizon_hours": 24,
                "model_run_id": self.metadata["run_id"],
                "feature_set_version": self.metadata["feature_set_version"],
                "classifier_threshold": self.metadata["classifier_threshold"],
                "input_vertex_count": len(input_coordinates),
                "vertex_count": len(coordinates), "spreading_vertices": int(spreading.sum()),
                "mean_spread_probability": float(probabilities.mean()),
                "mean_displacement_m": float(distances.mean()),
                "max_displacement_m": float(distances.max()),
                "physics_heading_degrees": physics.heading_degrees,
                "physics_baseline_distance_m": baseline, "utm_epsg": metric_crs.to_epsg(),
                "terrain_slope": slope,
                "neighboring_fire_pixels_proxy": "local polygon area in a 7 km window",
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
                    "Fuel Model 4 is an MVP fuel assumption",
                    "Neighboring fire pixels are inferred from polygon area, not a live raster",
                    "PDSI, NDVI, population and ERC use training-set medians",
                ],
            },
        }


def resolve_metadata_path() -> Path:
    configured = os.getenv("HURDLE_METADATA_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    matches = sorted((Path(__file__).parent / "models").glob("*_hurdle_v2_metadata.json"))
    if not matches:
        raise RuntimeError("no hurdle model metadata found")
    return matches[-1]


@asynccontextmanager
async def lifespan(application: FastAPI):
    application.state.predictor = PredictionService.load(resolve_metadata_path())
    yield


app = FastAPI(title="FireSight Spread Inference", version="2.0.0", lifespan=lifespan)


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
