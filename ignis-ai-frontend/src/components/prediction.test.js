import { predictionSummary } from './prediction';

test('maps FastAPI GeoJSON properties into display units', () => {
  const summary = predictionSummary({ properties: {
    mean_spread_probability: 0.3849,
    spreading_vertices: 2,
    max_displacement_m: 2544,
    physics_heading_degrees: 181,
    weather: {
      wind_speed_m_s: 2.79,
      wind_from_degrees: 1,
      temperature_c: 15.2,
      relative_humidity_percent: 62
    }
  }});

  expect(summary).toEqual({
    probabilityPercent: 38,
    willSpread: true,
    distanceKm: 2.544,
    directionDegrees: 181,
    windSpeedMps: 2.79,
    windDirectionDegrees: 1,
    temperatureC: 15.2,
    humidityPercent: 62
  });
});

test('does not claim spread when no boundary vertices pass the hurdle', () => {
  expect(predictionSummary({ properties: { spreading_vertices: 0 } }).willSpread).toBe(false);
});
