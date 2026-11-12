import unittest

import numpy as np
from shapely.geometry import MultiPolygon, Polygon, shape

from inference_api import (
    INFERENCE_FEATURE_COLUMNS,
    LiveWeather,
    PredictionService,
    _build_swept_prediction,
    _live_geometry_features,
    _polygon_rings,
    _ring_hole_flags,
    _segmentize_metric_geometry,
    _spread_directions,
    specific_humidity,
    utm_crs,
)


class FakeEnvironment:
    def weather(self, latitude, longitude):
        return LiveWeather(25.0, 30.0, 900.0, 4.0, 270.0, 15.0, 29.0, 0.0)

    def elevations(self, coordinates):
        return [500.0 + index for index, _ in enumerate(coordinates)]


class FakeClassifier:
    features = None

    def predict_proba(self, features):
        assert tuple(features.columns) == INFERENCE_FEATURE_COLUMNS
        self.features = features.copy()
        return np.tile([0.2, 0.8], (len(features), 1))


class FakeRegressor:
    def predict(self, features):
        return np.full(len(features), -2_000.0)


class InferenceServiceTest(unittest.TestCase):
    def setUp(self):
        metadata = {
            "run_id": "fixture", "feature_set_version": "boundary_physics_v2",
            "features": list(INFERENCE_FEATURE_COLUMNS), "classifier_threshold": 0.5,
            "runtime_defaults": {
                name: {"value": value, "source": "train_median"}
                for name, value in {
                    "pdsi": -2.0, "NDVI": 4900.0, "population": 0.0, "erc": 77.0,
                }.items()
            },
        }
        self.classifier = FakeClassifier()
        self.service = PredictionService(
            self.classifier, FakeRegressor(), metadata, FakeEnvironment()
        )

    def test_predicts_valid_geojson_with_metric_projection(self):
        feature = {
            "type": "Feature", "properties": {},
            "geometry": {"type": "Polygon", "coordinates": [[
                [-120.01, 37.0], [-120.0, 37.0], [-120.0, 37.01],
                [-120.01, 37.01], [-120.01, 37.0],
            ]]},
        }

        result = self.service.predict(feature)

        self.assertEqual(result["type"], "Feature")
        self.assertEqual(result["geometry"]["type"], "Polygon")
        self.assertEqual(result["properties"]["input_vertex_count"], 4)
        self.assertGreater(result["properties"]["spreading_vertices"], 4)
        self.assertEqual(result["properties"]["utm_epsg"], 32610)
        self.assertLessEqual(result["properties"]["max_displacement_m"], 10_000.0)
        self.assertEqual(len(result["properties"]["fallback_features"]), 4)
        self.assertEqual(
            self.classifier.features.shape,
            (result["properties"]["vertex_count"], 19),
        )
        self.assertTrue(
            shape(result["geometry"]).buffer(1e-10).covers(shape(feature["geometry"]))
        )
        self.assertTrue(
            self.classifier.features["wind_alignment_cosine"].between(-1.0, 1.0).all()
        )
        self.assertTrue(
            self.classifier.features["neighboring_fire_pixels"].between(0.0, 48.0).all()
        )
        expected = (
            self.classifier.features["wind_alignment_cosine"]
            * self.classifier.features["vs"]
            * result["properties"]["terrain_slope"]
        )
        np.testing.assert_allclose(
            self.classifier.features["slope_wind_interaction"], expected, atol=1e-8
        )

    def test_rejects_non_polygon_geometry(self):
        feature = {
            "type": "Feature", "properties": {},
            "geometry": {"type": "Point", "coordinates": [-120.0, 37.0]},
        }
        with self.assertRaisesRegex(ValueError, "Polygon"):
            self.service.predict(feature)

    def test_specific_humidity_and_utm_are_physical(self):
        self.assertTrue(0.0 < specific_humidity(25.0, 30.0, 900.0) < 0.03)
        self.assertEqual(utm_crs(-120.0, 37.0).to_epsg(), 32611)

    def test_polygon_normals_are_outward_for_either_ring_orientation(self):
        ring = [(0.0, 0.0), (1_000.0, 0.0), (1_000.0, 1_000.0), (0.0, 1_000.0)]
        forward, _ = _live_geometry_features(Polygon(ring), [ring], [False], 270.0)
        reversed_ring = list(reversed(ring))
        reverse, _ = _live_geometry_features(
            Polygon(reversed_ring), [reversed_ring], [False], 270.0
        )

        np.testing.assert_allclose(sorted(forward), sorted(reverse), atol=1e-9)
        self.assertEqual(sum(forward > 0.0), 2)
        self.assertEqual(sum(forward < 0.0), 2)

    def test_segmentizes_metric_edges_to_one_hundred_metres(self):
        segmentized = _segmentize_metric_geometry(
            Polygon([(0.0, 0.0), (1_000.0, 0.0), (1_000.0, 1_000.0), (0.0, 1_000.0)])
        )

        lengths = []
        for ring in _polygon_rings(segmentized):
            lengths.extend(
                np.hypot(
                    ring[(index + 1) % len(ring)][0] - point[0],
                    ring[(index + 1) % len(ring)][1] - point[1],
                )
                for index, point in enumerate(ring)
            )

        self.assertLessEqual(max(lengths), 100.0 + 1e-9)

    def test_swept_growth_expands_local_fronts_instead_of_one_parallel_corridor(self):
        current = Polygon([
            (0.0, 0.0), (1_000.0, 0.0),
            (1_000.0, 1_000.0), (0.0, 1_000.0),
        ])
        rings = _polygon_rings(current)
        predicted = _build_swept_prediction(
            current, rings, _ring_hole_flags(current),
            np.full(4, 2_000.0), 90.0,
        )

        self.assertTrue(predicted.is_valid)
        self.assertTrue(predicted.buffer(1e-9).covers(current))
        west, south, east, north = predicted.bounds
        self.assertLess(west, -1_000.0)
        self.assertLess(south, -1_000.0)
        self.assertGreater(east, 2_000.0)
        self.assertGreater(north, 2_000.0)

    def test_heading_bias_never_turns_a_vertex_inward(self):
        normals = np.asarray([
            [1.0, 0.0], [-1.0, 0.0], [0.0, 1.0], [0.0, -1.0]
        ])
        directions = _spread_directions(normals, 90.0)

        self.assertTrue(np.all(np.sum(normals * directions, axis=1) > 0.0))
        self.assertGreater(directions[2, 0], 0.0)
        self.assertGreater(directions[3, 0], 0.0)

    def test_swept_growth_repairs_concave_uneven_front(self):
        current = Polygon([
            (0.0, 0.0), (4_000.0, 0.0), (4_000.0, 4_000.0),
            (3_000.0, 4_000.0), (3_000.0, 1_000.0),
            (1_000.0, 1_000.0), (1_000.0, 4_000.0), (0.0, 4_000.0),
        ])
        rings = _polygon_rings(current)
        predicted = _build_swept_prediction(
            current, rings, _ring_hole_flags(current),
            np.asarray([0.0, 3_000.0, 500.0, 0.0, 2_500.0, 0.0, 1_000.0, 0.0]),
            315.0,
        )

        self.assertTrue(predicted.is_valid)
        self.assertIn(predicted.geom_type, {"Polygon", "MultiPolygon"})
        self.assertTrue(predicted.buffer(1e-9).covers(current))
        self.assertTrue(current.buffer(3_100.0).covers(predicted))

    def test_swept_growth_supports_multipolygons_and_holes(self):
        donut = Polygon(
            [(0.0, 0.0), (2_000.0, 0.0), (2_000.0, 2_000.0), (0.0, 2_000.0)],
            [[(700.0, 700.0), (1_300.0, 700.0),
              (1_300.0, 1_300.0), (700.0, 1_300.0)]],
        )
        current = MultiPolygon([
            donut,
            Polygon([(4_000.0, 0.0), (5_000.0, 0.0),
                     (5_000.0, 1_000.0), (4_000.0, 1_000.0)]),
        ])
        rings = _polygon_rings(current)
        distances = np.linspace(0.0, 1_000.0, sum(map(len, rings)))
        predicted = _build_swept_prediction(
            current, rings, _ring_hole_flags(current), distances, 180.0,
        )

        self.assertTrue(predicted.is_valid)
        self.assertTrue(predicted.buffer(1e-9).covers(current))
        self.assertIn(predicted.geom_type, {"Polygon", "MultiPolygon"})


if __name__ == "__main__":
    unittest.main()
