"""Build a satellite-derived current fire footprint."""

from __future__ import annotations

import json
import math
import sys
from typing import Any, Sequence

import numpy as np
from pyproj import CRS, Transformer
from shapely import concave_hull
from shapely.geometry import MultiPoint, mapping
from shapely.ops import transform
from sklearn.cluster import DBSCAN

DEFAULT_BUFFER_METERS = 500.0
DEFAULT_CONCAVE_HULL_RATIO = 0.3
DEFAULT_DBSCAN_EPS_METERS = 1_500.0

Coordinate = tuple[float, float]
GeoJsonFeature = dict[str, Any]


class DetectionPolygonError(ValueError):
    """Raised when a detection polygon cannot be built from the input."""


def _validated_coordinates(fire_event_cluster: Sequence[Sequence[float]]) -> list[Coordinate]:
    if not isinstance(fire_event_cluster, (list, tuple)) or not fire_event_cluster:
        raise DetectionPolygonError("fire_event_cluster must be a non-empty coordinate list")

    coordinates: list[Coordinate] = []
    for index, coordinate in enumerate(fire_event_cluster):
        if not isinstance(coordinate, (list, tuple)) or len(coordinate) < 2:
            raise DetectionPolygonError(f"coordinate {index} must be [longitude, latitude]")
        if isinstance(coordinate[0], bool) or isinstance(coordinate[1], bool):
            raise DetectionPolygonError(f"coordinate {index} must contain numeric values")
        try:
            longitude, latitude = float(coordinate[0]), float(coordinate[1])
        except (TypeError, ValueError) as exc:
            raise DetectionPolygonError(
                f"coordinate {index} must contain numeric values"
            ) from exc
        if not math.isfinite(longitude) or not math.isfinite(latitude):
            raise DetectionPolygonError(f"coordinate {index} must contain finite values")
        if not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
            raise DetectionPolygonError(f"coordinate {index} is outside WGS84 bounds")
        coordinates.append((longitude, latitude))

    # Repeated detections at the exact same location add no geometry.
    return list(dict.fromkeys(coordinates))


def _center(coordinates: Sequence[Coordinate]) -> Coordinate:
    values = np.asarray(coordinates, dtype=float)
    return float(values[:, 0].mean()), float(values[:, 1].mean())


def _local_transformers(center: Coordinate) -> tuple[Transformer, Transformer]:
    longitude, latitude = center
    local_crs = CRS.from_proj4(
        f"+proj=aeqd +lat_0={latitude} +lon_0={longitude} "
        "+datum=WGS84 +units=m +no_defs"
    )
    forward = Transformer.from_crs("EPSG:4326", local_crs, always_xy=True)
    reverse = Transformer.from_crs(local_crs, "EPSG:4326", always_xy=True)
    return forward, reverse


def _remove_severe_outliers(
    projected_coordinates: list[Coordinate],
    eps_meters: float | None,
) -> list[Coordinate]:
    """Keep the largest DBSCAN group when it contains at least three points."""

    if eps_meters is None or len(projected_coordinates) < 4:
        return projected_coordinates
    labels = DBSCAN(eps=eps_meters, min_samples=3).fit_predict(projected_coordinates)
    groups = [label for label in set(labels) if label != -1]
    if not groups:
        return projected_coordinates
    largest = max(groups, key=lambda label: int(np.count_nonzero(labels == label)))
    selected = [point for point, label in zip(projected_coordinates, labels) if label == largest]
    return selected if len(selected) >= 3 else projected_coordinates


def build_synthetic_polygon(
    coordinates: Sequence[Coordinate],
    *,
    buffer_meters: float = DEFAULT_BUFFER_METERS,
    concave_hull_ratio: float = DEFAULT_CONCAVE_HULL_RATIO,
    dbscan_eps_meters: float | None = DEFAULT_DBSCAN_EPS_METERS,
) -> dict[str, Any]:
    """Create a metric buffer or concave hull and return WGS84 GeoJSON geometry."""

    if buffer_meters <= 0:
        raise DetectionPolygonError("buffer_meters must be positive")
    if not 0 <= concave_hull_ratio <= 1:
        raise DetectionPolygonError("concave_hull_ratio must be between 0 and 1")

    center = _center(coordinates)
    forward, reverse = _local_transformers(center)
    projected = [forward.transform(longitude, latitude) for longitude, latitude in coordinates]
    projected = _remove_severe_outliers(projected, dbscan_eps_meters)
    points = MultiPoint(projected)

    if len(projected) <= 2:
        # MultiPoint.convex_hull is a point or line; buffering it guarantees one pill.
        polygon = points.convex_hull.buffer(buffer_meters)
    else:
        polygon = concave_hull(points, ratio=concave_hull_ratio, allow_holes=False)
        if polygon.geom_type not in {"Polygon", "MultiPolygon"} or polygon.is_empty:
            polygon = points.convex_hull.buffer(buffer_meters)

    wgs84_polygon = transform(reverse.transform, polygon)
    if wgs84_polygon.geom_type not in {"Polygon", "MultiPolygon"} or wgs84_polygon.is_empty:
        raise DetectionPolygonError("synthetic geometry did not produce a polygon")
    return mapping(wgs84_polygon)


def build_detection_polygon(
    fire_event_cluster: Sequence[Sequence[float]],
) -> GeoJsonFeature:
    """Return a satellite-derived GeoJSON footprint for a validated cluster."""

    coordinates = _validated_coordinates(fire_event_cluster)
    return {
        "type": "Feature",
        "properties": {"source": "synthetic"},
        "geometry": build_synthetic_polygon(coordinates),
    }


def main() -> int:
    """Read one JSON request from stdin and write one GeoJSON Feature to stdout."""

    try:
        payload = json.load(sys.stdin)
        result = build_detection_polygon(payload.get("fire_event_cluster"))
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except (DetectionPolygonError, TypeError, json.JSONDecodeError) as exc:
        print(f"Invalid detection polygon request: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # Keep stdout clean for the Express JSON bridge.
        print(f"Detection polygon generation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
