#!/usr/bin/env python3
"""Repair polygon topology and optionally simplify in a metric projection."""

from __future__ import annotations

import json
import sys
from collections.abc import Iterable
from typing import Any

from pyproj import Transformer
from shapely import make_valid
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon, mapping, shape
from shapely.ops import transform


TO_METERS = Transformer.from_crs("EPSG:4326", "EPSG:5070", always_xy=True)
TO_WGS84 = Transformer.from_crs("EPSG:5070", "EPSG:4326", always_xy=True)


def polygon_parts(geometry: Any) -> Iterable[Polygon]:
    if isinstance(geometry, Polygon):
        yield geometry
    elif isinstance(geometry, MultiPolygon):
        yield from geometry.geoms
    elif isinstance(geometry, GeometryCollection):
        for part in geometry.geoms:
            yield from polygon_parts(part)


def repair_geometry(
    raw_geometry: dict[str, Any], simplify_meters: float
) -> dict[str, Any] | None:
    geometry = make_valid(shape(raw_geometry))
    if simplify_meters > 0:
        projected = transform(TO_METERS.transform, geometry)
        projected = make_valid(projected.simplify(simplify_meters, preserve_topology=True))
        geometry = transform(TO_WGS84.transform, projected)
    geometry = make_valid(geometry)
    parts = [part for part in polygon_parts(geometry) if not part.is_empty]
    if not parts:
        return None
    polygonal = parts[0] if len(parts) == 1 else MultiPolygon(parts)
    return mapping(polygonal)


def main() -> None:
    payload = json.load(sys.stdin)
    simplify_meters = max(0.0, float(payload.get("simplify_meters", 0)))
    repaired_features = []
    skipped = 0
    for feature in payload.get("features", []):
        try:
            geometry = repair_geometry(feature.get("geometry") or {}, simplify_meters)
        except Exception:
            geometry = None
        if geometry is None:
            skipped += 1
            continue
        repaired_features.append({**feature, "geometry": geometry})
    json.dump({"features": repaired_features, "skipped": skipped}, sys.stdout)


if __name__ == "__main__":
    main()
