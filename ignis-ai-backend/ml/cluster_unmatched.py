"""Cluster unmatched FIRMS points with a 1.5 km haversine DBSCAN."""

import json
import sys

import numpy as np
from sklearn.cluster import DBSCAN

EARTH_RADIUS_METERS = 6_371_000.0
DBSCAN_EPS_METERS = 1_500.0


def cluster_points(points: list[list[float]]) -> list[int]:
    """Return DBSCAN labels; -1 identifies observations treated as noise."""
    if not points:
        return []
    coordinates = np.radians([[point[1], point[0]] for point in points])
    labels = DBSCAN(
        eps=DBSCAN_EPS_METERS / EARTH_RADIUS_METERS,
        min_samples=3,
        metric="haversine",
        algorithm="ball_tree",
    ).fit_predict(coordinates)
    return labels.astype(int).tolist()


def main() -> None:
    payload = json.load(sys.stdin)
    points = payload.get("coordinates", [])
    if any(not isinstance(point, list) or len(point) != 2 for point in points):
        raise ValueError("coordinates must contain [longitude, latitude] pairs")
    print(json.dumps({"labels": cluster_points(points)}))


if __name__ == "__main__":
    main()
