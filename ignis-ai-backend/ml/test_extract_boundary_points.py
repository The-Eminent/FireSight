import csv
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import tensorflow as tf

from extract_boundary_points import ENVIRONMENT_FEATURES, extract_example, extract_files


def make_example(current, future, wind_from=270.0, wind_speed=3.0):
    features = {
        "PrevFireMask": tf.train.Feature(float_list=tf.train.FloatList(value=current.ravel())),
        "FireMask": tf.train.Feature(float_list=tf.train.FloatList(value=future.ravel())),
    }
    for index, name in enumerate(ENVIRONMENT_FEATURES):
        value = wind_from if name == "th" else wind_speed if name == "vs" else index + 0.5
        values = np.full(current.size, value, dtype=np.float32)
        features[name] = tf.train.Feature(float_list=tf.train.FloatList(value=values))
    return tf.train.Example(features=tf.train.Features(feature=features))


class BoundaryPointExtractionTest(unittest.TestCase):
    def test_assigns_new_cells_and_preserves_zero_spread_boundary_points(self):
        current = np.zeros((5, 5), dtype=np.float32)
        current[2, 2] = 1
        future = current.copy()
        future[2, 3] = 1
        rows = extract_example(make_example(current, future), "train:0:0", "train", "fixture", 0)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["spreads"], 1)
        self.assertEqual(rows[0]["actual_dx_m"], 1000.0)
        self.assertEqual(rows[0]["actual_dy_m"], 0.0)
        self.assertEqual(rows[0]["actual_distance_m"], 1000.0)
        self.assertEqual(rows[0]["elevation"], 0.5)
        self.assertLessEqual(rows[0]["actual_distance_m"], rows[0]["match_radius_m"])
        self.assertGreater(rows[0]["physics_ros_m_min"], 0.0)
        self.assertLessEqual(
            rows[0]["physics_baseline_distance_m"], rows[0]["match_radius_m"]
        )
        self.assertAlmostEqual(
            rows[0]["residual_distance_m"],
            rows[0]["actual_distance_m"] - rows[0]["physics_baseline_distance_m"],
        )

    def test_no_new_cells_produces_zero_target(self):
        current = np.zeros((5, 5), dtype=np.float32)
        current[1:4, 1:4] = 1
        rows = extract_example(make_example(current, current), "test:0:0", "test", "fixture", 0)

        self.assertEqual(len(rows), 8)
        self.assertTrue(all(row["spreads"] == 0 for row in rows))
        self.assertTrue(all(row["actual_distance_m"] == 0 for row in rows))

    def test_rejects_distant_front_in_same_chip(self):
        current = np.zeros((64, 64), dtype=np.float32)
        current[32, 32] = 1
        future = current.copy()
        future[32, 63] = 1
        rows = extract_example(make_example(current, future), "train:0:0", "train", "fixture", 0)

        self.assertEqual(rows[0]["spreads"], 0)
        self.assertEqual(rows[0]["actual_distance_m"], 0.0)
        self.assertLessEqual(rows[0]["match_radius_m"], 10_000.0)

    def test_rejects_new_cell_behind_head_fire(self):
        current = np.zeros((5, 5), dtype=np.float32)
        current[2, 2] = 1
        future = current.copy()
        future[2, 1] = 1
        rows = extract_example(make_example(current, future), "train:0:0", "train", "fixture", 0)

        self.assertEqual(rows[0]["spreads"], 0)

    def test_streams_csv_and_writes_manifest(self):
        current = np.zeros((5, 5), dtype=np.float32)
        current[2, 2] = 1
        future = current.copy()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record_path = root / "fixture.tfrecord"
            output_path = root / "points.csv"
            with tf.io.TFRecordWriter(str(record_path)) as writer:
                writer.write(make_example(current, future).SerializeToString())

            manifest = extract_files([record_path], output_path, "train")
            with output_path.open(newline="", encoding="utf-8") as handle:
                rows = list(csv.DictReader(handle))
            stored_manifest = json.loads(output_path.with_suffix(".manifest.json").read_text())

            self.assertEqual(len(rows), 1)
            self.assertEqual(manifest["rows_written"], 1)
            self.assertEqual(manifest["feature_records_present"]["pr"], 1)
            self.assertFalse(stored_manifest["incident_ids_available"])


if __name__ == "__main__":
    unittest.main()
