import unittest

import numpy as np

from inference_api import LiveWeather, PredictionService, specific_humidity, utm_crs
from train_hurdle import FEATURE_COLUMNS


class FakeEnvironment:
    def weather(self, latitude, longitude):
        return LiveWeather(25.0, 30.0, 900.0, 4.0, 270.0, 15.0, 29.0, 0.0)

    def elevations(self, coordinates):
        return [500.0 + index for index, _ in enumerate(coordinates)]


class FakeClassifier:
    def predict_proba(self, features):
        assert tuple(features.columns) == FEATURE_COLUMNS
        return np.tile([0.2, 0.8], (len(features), 1))


class FakeRegressor:
    def predict(self, features):
        return np.full(len(features), -2_000.0)


class InferenceServiceTest(unittest.TestCase):
    def setUp(self):
        metadata = {
            "run_id": "fixture", "feature_set_version": "boundary_physics_v1",
            "features": list(FEATURE_COLUMNS), "classifier_threshold": 0.5,
            "runtime_defaults": {
                name: {"value": value, "source": "train_median"}
                for name, value in {
                    "pdsi": -2.0, "NDVI": 4900.0, "population": 0.0, "erc": 77.0,
                }.items()
            },
        }
        self.service = PredictionService(
            FakeClassifier(), FakeRegressor(), metadata, FakeEnvironment()
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
        self.assertEqual(result["properties"]["spreading_vertices"], 4)
        self.assertEqual(result["properties"]["utm_epsg"], 32610)
        self.assertLessEqual(result["properties"]["max_displacement_m"], 10_000.0)
        self.assertEqual(len(result["properties"]["fallback_features"]), 4)

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


if __name__ == "__main__":
    unittest.main()
