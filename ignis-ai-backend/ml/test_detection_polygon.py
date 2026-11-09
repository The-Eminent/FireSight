"""Focused tests for detection-polygon geometry and WFIGS selection."""

import unittest

from pyproj import CRS, Transformer
from shapely.geometry import shape
from shapely.ops import transform

from detection_polygon import (
    DEFAULT_DBSCAN_EPS_METERS,
    DetectionPolygonError,
    build_detection_polygon,
)


class DetectionPolygonTests(unittest.TestCase):
    def test_uses_the_shared_1_5_km_dbscan_distance(self):
        self.assertEqual(DEFAULT_DBSCAN_EPS_METERS, 1_500.0)

    def test_single_point_uses_a_roughly_500_meter_metric_buffer(self):
        longitude, latitude = -120.0, 37.0

        feature = build_detection_polygon([[longitude, latitude]])
        polygon = shape(feature["geometry"])
        local_crs = CRS.from_proj4(
            f"+proj=aeqd +lat_0={latitude} +lon_0={longitude} +datum=WGS84 +units=m"
        )
        forward = Transformer.from_crs("EPSG:4326", local_crs, always_xy=True)
        metric_polygon = transform(forward.transform, polygon)

        self.assertEqual(feature["properties"]["source"], "synthetic")
        self.assertEqual(polygon.geom_type, "Polygon")
        self.assertAlmostEqual(metric_polygon.bounds[2] - metric_polygon.bounds[0], 1_000, delta=3)

    def test_two_points_produce_one_connected_pill(self):
        feature = build_detection_polygon([[-120.0, 37.0], [-119.98, 37.0]])

        self.assertEqual(shape(feature["geometry"]).geom_type, "Polygon")

    def test_three_or_more_points_produce_a_concave_polygon(self):
        cluster = [
            [-120.00, 37.00], [-119.99, 37.00], [-119.99, 37.01],
            [-119.995, 37.005], [-120.00, 37.01],
        ]

        feature = build_detection_polygon(cluster)

        self.assertIn(shape(feature["geometry"]).geom_type, {"Polygon", "MultiPolygon"})

    def test_rejects_out_of_bounds_coordinates(self):
        with self.assertRaises(DetectionPolygonError):
            build_detection_polygon([[200, 37]])


if __name__ == "__main__":
    unittest.main()
