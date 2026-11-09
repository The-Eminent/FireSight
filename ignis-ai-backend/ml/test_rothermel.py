import unittest

from rothermel import fuel_model_4_ros


class FuelModel4RothermelTest(unittest.TestCase):
    def test_returns_positive_finite_baseline(self):
        result = fuel_model_4_ros(0.0, 0.0)

        self.assertGreater(result.rate_m_min, 0.0)
        self.assertAlmostEqual(result.distance_24h_m, result.rate_m_min * 1440.0)

    def test_wind_increases_rate_and_points_downwind(self):
        calm = fuel_model_4_ros(0.0, 270.0)
        windy = fuel_model_4_ros(5.0, 270.0)

        self.assertGreater(windy.rate_m_min, calm.rate_m_min)
        self.assertAlmostEqual(windy.heading_degrees, 90.0, places=6)

    def test_uphill_slope_turns_resultant_north(self):
        result = fuel_model_4_ros(0.0, 270.0, slope_north=0.2)

        self.assertAlmostEqual(result.heading_degrees, 0.0, places=6)
        self.assertGreater(result.slope_factor, 0.0)

    def test_rejects_negative_wind(self):
        with self.assertRaises(ValueError):
            fuel_model_4_ros(-1.0, 0.0)


if __name__ == "__main__":
    unittest.main()
