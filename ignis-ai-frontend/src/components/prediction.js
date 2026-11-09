function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function predictionSummary(feature) {
  const properties = feature?.properties || {};
  const weather = properties.weather || {};
  return {
    probabilityPercent: Math.round(
      finiteNumber(properties.mean_spread_probability) * 100
    ),
    willSpread: finiteNumber(properties.spreading_vertices) > 0,
    distanceKm: finiteNumber(properties.max_displacement_m) / 1000,
    directionDegrees: finiteNumber(properties.physics_heading_degrees),
    windSpeedMps: finiteNumber(weather.wind_speed_m_s),
    windDirectionDegrees: finiteNumber(weather.wind_from_degrees),
    temperatureC: finiteNumber(weather.temperature_c),
    humidityPercent: finiteNumber(weather.relative_humidity_percent)
  };
}

export function predictionErrorMessage(error) {
  return error?.response?.data?.error
    || 'Prediction service is unavailable. Please try again.';
}
