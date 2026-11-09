import unittest

import numpy as np
import pandas as pd

from train_hurdle import CLASSIFIER_PARAMS, FEATURE_COLUMNS, build_features


class HurdleFeatureContractTest(unittest.TestCase):
    def test_builds_ordered_cyclic_features_without_targets(self):
        frame = pd.DataFrame({
            "elevation": [100.0], "th": [270.0], "vs": [5.0],
            "tmmn": [280.0], "tmmx": [300.0], "sph": [0.01], "pr": [0.0],
            "pdsi": [-2.0], "NDVI": [0.4], "population": [3.0], "erc": [60.0],
            "physics_ros_m_min": [20.0], "physics_heading_deg": [90.0],
            "physics_baseline_distance_m": [10_000.0],
            "wind_alignment_cosine": [0.8], "neighboring_fire_pixels": [12.0],
            "slope_wind_interaction": [0.4], "spreads": [1],
            "residual_distance_m": [-1_000.0],
        })

        features = build_features(frame)

        self.assertEqual(tuple(features.columns), FEATURE_COLUMNS)
        self.assertNotIn("spreads", features)
        self.assertNotIn("residual_distance_m", features)
        self.assertAlmostEqual(float(features.loc[0, "wind_from_sin"]), -1.0)
        self.assertAlmostEqual(float(features.loc[0, "physics_heading_sin"]), 1.0)
        self.assertAlmostEqual(float(features.loc[0, "wind_alignment_cosine"]), 0.8)
        self.assertEqual(float(features.loc[0, "neighboring_fire_pixels"]), 12.0)
        self.assertEqual(CLASSIFIER_PARAMS["eval_metric"], "aucpr")
        self.assertTrue(np.isfinite(features.to_numpy()).all())


if __name__ == "__main__":
    unittest.main()
