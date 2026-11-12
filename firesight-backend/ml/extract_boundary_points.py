"""Convert NDWS TFRecords into boundary-point training rows.

The source chips have no geographic coordinates, so positions are expressed as
metric offsets from the 64x64 chip centre. One pixel is 1 km in the published
Next Day Wildfire Spread dataset.
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
from pathlib import Path
from typing import Iterable

import numpy as np
import tensorflow as tf
from scipy.ndimage import binary_erosion, convolve, sobel

from rothermel import RothermelResult, fuel_model_4_ros


CELL_SIZE_METERS = 1_000.0
MATCH_DISTANCE_MULTIPLIER = 1.5
MIN_MATCH_RADIUS_METERS = CELL_SIZE_METERS
MAX_MATCH_RADIUS_METERS = 10_000.0
MAX_HEADING_DIFFERENCE_DEGREES = 90.0
ENVIRONMENT_FEATURES = (
    "elevation", "th", "vs", "tmmn", "tmmx", "sph",
    "pr", "pdsi", "NDVI", "population", "erc",
)
ENGINEERED_FEATURES = (
    "wind_alignment_cosine", "neighboring_fire_pixels",
    "slope_wind_interaction",
)
NEIGHBORHOOD_SIZE = 7
OUTPUT_COLUMNS = (
    "sample_id", "split", "source_file", "record_index", "row", "column",
    "x_m", "y_m", *ENVIRONMENT_FEATURES, *ENGINEERED_FEATURES, "spreads",
    "target_row", "target_column", "target_x_m", "target_y_m",
    "actual_dx_m", "actual_dy_m", "actual_distance_m",
    "physics_ros_m_min", "physics_heading_deg", "physics_distance_24h_m",
    "match_radius_m", "physics_baseline_distance_m", "residual_distance_m",
)


def _feature_array(example: tf.train.Example, name: str, size: int) -> np.ndarray:
    feature = example.features.feature.get(name)
    if feature is None:
        return np.full(size, np.nan, dtype=np.float32)
    values = feature.float_list.value
    if not values:
        return np.full(size, np.nan, dtype=np.float32)
    array = np.asarray(values, dtype=np.float32)
    if array.size != size:
        raise ValueError(f"{name} has {array.size} values; expected {size}")
    return array


def _required_square(example: tf.train.Example, name: str) -> np.ndarray:
    feature = example.features.feature.get(name)
    values = feature.float_list.value if feature is not None else ()
    side = int(np.sqrt(len(values)))
    if side == 0 or side * side != len(values):
        raise ValueError(f"{name} is missing or is not a square float grid")
    return np.asarray(values, dtype=np.float32).reshape(side, side)


def _boundary(mask: np.ndarray) -> np.ndarray:
    active = np.nan_to_num(mask, nan=0.0) > 0
    return active & ~binary_erosion(active, structure=np.ones((3, 3)), border_value=0)


def _engineered_grids(
    mask: np.ndarray,
    wind_speed: np.ndarray,
    wind_from: np.ndarray,
    east_slope: np.ndarray,
    north_slope: np.ndarray,
) -> dict[str, np.ndarray]:
    """Build current-fire geometry features without using the future mask."""
    active = (np.nan_to_num(mask, nan=0.0) > 0).astype(np.float32)
    # The active-mask gradient points inward; negate it for the outward normal.
    outward_east = -sobel(active, axis=1, mode="constant")
    outward_north = sobel(active, axis=0, mode="constant")
    normal_length = np.hypot(outward_east, outward_north)
    downwind_radians = np.deg2rad(
        (np.nan_to_num(wind_from, nan=0.0) + 180.0) % 360.0
    )
    alignment = np.divide(
        outward_east * np.sin(downwind_radians)
        + outward_north * np.cos(downwind_radians),
        normal_length,
        out=np.zeros_like(normal_length),
        where=normal_length > 0,
    )
    alignment = np.clip(alignment, -1.0, 1.0)

    kernel = np.ones((NEIGHBORHOOD_SIZE, NEIGHBORHOOD_SIZE), dtype=np.float32)
    kernel[NEIGHBORHOOD_SIZE // 2, NEIGHBORHOOD_SIZE // 2] = 0.0
    neighboring = convolve(active, kernel, mode="constant", cval=0.0)
    slope = np.hypot(east_slope, north_slope)
    interaction = slope * np.nan_to_num(wind_speed, nan=0.0) * alignment
    return {
        "wind_alignment_cosine": alignment,
        "neighboring_fire_pixels": neighboring,
        "slope_wind_interaction": interaction,
    }


def _angle_difference(first: float, second: float) -> float:
    return abs((first - second + 180.0) % 360.0 - 180.0)


def _spread_targets(
    current: np.ndarray,
    future: np.ndarray,
    physics: dict[tuple[int, int], RothermelResult],
) -> dict[tuple[int, int], tuple[int, int]]:
    """Match new cells to the closest physically eligible boundary point."""
    boundary = _boundary(current)
    if not boundary.any():
        return {}
    current_active = np.nan_to_num(current, nan=0.0) > 0
    future_active = np.nan_to_num(future, nan=0.0) > 0
    new_cells = np.argwhere(future_active & ~current_active)
    if not new_cells.size:
        return {}

    sources = list(physics)
    targets: dict[tuple[int, int], tuple[int, int]] = {}
    distances: dict[tuple[int, int], float] = {}
    for target_row, target_column in new_cells:
        candidates: list[tuple[float, tuple[int, int]]] = []
        for source in sources:
            dx = (target_column - source[1]) * CELL_SIZE_METERS
            dy = (source[0] - target_row) * CELL_SIZE_METERS
            distance = float(np.hypot(dx, dy))
            radius = min(MAX_MATCH_RADIUS_METERS, max(
                MIN_MATCH_RADIUS_METERS,
                physics[source].distance_24h_m * MATCH_DISTANCE_MULTIPLIER,
            ))
            heading = float(np.degrees(np.arctan2(dx, dy)) % 360.0)
            if distance <= radius and _angle_difference(
                heading, physics[source].heading_degrees
            ) <= MAX_HEADING_DIFFERENCE_DEGREES:
                candidates.append((distance, source))
        if not candidates:
            continue
        distance, source = min(candidates)
        if distance > distances.get(source, -1.0):
            targets[source] = (int(target_row), int(target_column))
            distances[source] = distance
    return targets


def extract_example(
    example: tf.train.Example,
    sample_id: str,
    split: str,
    source_file: str,
    record_index: int,
) -> list[dict[str, object]]:
    current = _required_square(example, "PrevFireMask")
    future = _required_square(example, "FireMask")
    if current.shape != future.shape:
        raise ValueError("PrevFireMask and FireMask shapes differ")

    side = current.shape[0]
    centre = (side - 1) / 2.0
    grids = {
        name: _feature_array(example, name, side * side).reshape(side, side)
        for name in ENVIRONMENT_FEATURES
    }
    elevation = grids["elevation"]
    if not np.isfinite(elevation).all():
        finite = elevation[np.isfinite(elevation)]
        elevation = np.nan_to_num(elevation, nan=float(np.median(finite)) if finite.size else 0.0)
    down_slope, east_slope = np.gradient(elevation, CELL_SIZE_METERS)
    north_slope = -down_slope
    engineered = _engineered_grids(
        current, grids["vs"], grids["th"], east_slope, north_slope
    )
    physics: dict[tuple[int, int], RothermelResult] = {}
    for row, column in np.argwhere(_boundary(current)):
        row, column = int(row), int(column)
        wind_speed = float(grids["vs"][row, column])
        wind_direction = float(grids["th"][row, column])
        physics[(row, column)] = fuel_model_4_ros(
            wind_speed if np.isfinite(wind_speed) else 0.0,
            wind_direction if np.isfinite(wind_direction) else 0.0,
            float(east_slope[row, column]),
            float(north_slope[row, column]),
        )
    targets = _spread_targets(current, future, physics)
    rows: list[dict[str, object]] = []
    for row, column in np.argwhere(_boundary(current)):
        row, column = int(row), int(column)
        x_m = (column - centre) * CELL_SIZE_METERS
        y_m = (centre - row) * CELL_SIZE_METERS
        target = targets.get((row, column))
        target_row, target_column = target if target else (row, column)
        target_x_m = (target_column - centre) * CELL_SIZE_METERS
        target_y_m = (centre - target_row) * CELL_SIZE_METERS
        actual_distance = float(np.hypot(target_x_m - x_m, target_y_m - y_m))
        physical = physics[(row, column)]
        match_radius = min(MAX_MATCH_RADIUS_METERS, max(
            MIN_MATCH_RADIUS_METERS,
            physical.distance_24h_m * MATCH_DISTANCE_MULTIPLIER,
        ))
        physics_baseline = min(physical.distance_24h_m, match_radius)
        output = {
            "sample_id": sample_id, "split": split, "source_file": source_file,
            "record_index": record_index, "row": row, "column": column,
            "x_m": x_m, "y_m": y_m, "spreads": int(target is not None),
            "target_row": target_row, "target_column": target_column,
            "target_x_m": target_x_m, "target_y_m": target_y_m,
            "actual_dx_m": target_x_m - x_m,
            "actual_dy_m": target_y_m - y_m,
            "actual_distance_m": actual_distance,
            "physics_ros_m_min": physical.rate_m_min,
            "physics_heading_deg": physical.heading_degrees,
            "physics_distance_24h_m": physical.distance_24h_m,
            "match_radius_m": match_radius,
            "physics_baseline_distance_m": physics_baseline,
            "residual_distance_m": actual_distance - physics_baseline,
        }
        output.update({name: float(grids[name][row, column]) for name in ENVIRONMENT_FEATURES})
        output.update({name: float(engineered[name][row, column]) for name in ENGINEERED_FEATURES})
        rows.append(output)
    return rows


def extract_files(
    files: Iterable[Path], output_path: Path, split: str, max_records: int | None = None,
) -> dict[str, object]:
    files = list(files)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    records_read = rows_written = skipped_no_boundary = 0
    feature_records_present = {name: 0 for name in ENVIRONMENT_FEATURES}
    with output_path.open("w", newline="", encoding="utf-8") as output_file:
        writer = csv.DictWriter(output_file, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        for path in files:
            for record_index, raw_record in enumerate(tf.data.TFRecordDataset([str(path)])):
                if max_records is not None and records_read >= max_records:
                    break
                example = tf.train.Example.FromString(bytes(raw_record.numpy()))
                for name in ENVIRONMENT_FEATURES:
                    feature = example.features.feature.get(name)
                    if feature is not None and feature.float_list.value:
                        feature_records_present[name] += 1
                sample_id = f"{split}:{path.name}:{record_index}"
                rows = extract_example(example, sample_id, split, path.name, record_index)
                records_read += 1
                if not rows:
                    skipped_no_boundary += 1
                writer.writerows(rows)
                rows_written += len(rows)
            if max_records is not None and records_read >= max_records:
                break

    manifest = {
        "split": split, "input_files": [str(path) for path in files],
        "records_read": records_read, "rows_written": rows_written,
        "records_without_current_boundary": skipped_no_boundary,
        "feature_records_present": feature_records_present,
        "cell_size_m": CELL_SIZE_METERS, "coordinates": "local chip-centred metric offsets",
        "incident_ids_available": False, "columns": list(OUTPUT_COLUMNS),
        "engineered_features": {
            "wind_alignment_cosine": "Sobel outward normal dotted with downwind unit vector",
            "neighboring_fire_pixels": f"active pixels in a {NEIGHBORHOOD_SIZE}x{NEIGHBORHOOD_SIZE} window excluding centre",
            "slope_wind_interaction": "terrain slope magnitude * wind speed * wind alignment",
        },
        "target_matching": {
            "fuel_model": "Anderson 4 (brush/chaparral)",
            "distance_multiplier": MATCH_DISTANCE_MULTIPLIER,
            "min_radius_m": MIN_MATCH_RADIUS_METERS,
            "max_radius_m": MAX_MATCH_RADIUS_METERS,
            "heading_tolerance_degrees": MAX_HEADING_DIFFERENCE_DEGREES,
        },
    }
    manifest_path = output_path.with_suffix(".manifest.json")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", help="TFRecord files or glob patterns")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--split", required=True, choices=("train", "eval", "test"))
    parser.add_argument("--max-records", type=int)
    args = parser.parse_args()
    files = sorted({Path(match) for pattern in args.inputs for match in glob.glob(pattern)})
    if not files:
        parser.error("no TFRecord files matched the supplied inputs")
    manifest = extract_files(files, args.output, args.split, args.max_records)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
