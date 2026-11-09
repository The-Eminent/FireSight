"""Focused tests for unmatched-observation clustering."""

import unittest

from cluster_unmatched import DBSCAN_EPS_METERS, cluster_points


class ClusterUnmatchedTests(unittest.TestCase):
    def test_uses_1_5_km_and_keeps_a_distant_point_as_noise(self):
        points = [
            [-120.000, 37.000],
            [-119.990, 37.000],
            [-120.000, 37.010],
            [-119.950, 37.050],
        ]

        self.assertEqual(DBSCAN_EPS_METERS, 1_500.0)
        self.assertEqual(cluster_points(points), [0, 0, 0, -1])


if __name__ == "__main__":
    unittest.main()
