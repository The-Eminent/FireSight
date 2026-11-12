import { confidenceToPercent } from './confidence';
import {
  detectionStatusLabel,
  hasSatelliteObservation,
  predictionCoordinates
} from './detectionStatus';

test.each([
  ['l', 25],
  ['n', 60],
  ['h', 90],
  ['H', 90],
  ['0.41', 41],
  ['41', 41],
  ['unknown', 0]
])('converts confidence %p to %p percent', (raw, expected) => {
  expect(confidenceToPercent(raw)).toBe(expected);
});

test('uses explicit labels for confirmed and unverified detections', () => {
  expect(detectionStatusLabel('confirmed_wildfire')).toBe('Confirmed wildfire');
  expect(detectionStatusLabel('unverified_thermal_anomaly')).toBe('Unverified thermal anomaly');
});

test('only enables prediction for events with satellite measurements', () => {
  expect(hasSatelliteObservation({ observationCount: 2, brightness: 340 })).toBe(true);
  expect(hasSatelliteObservation({ observationCount: 0, brightness: null })).toBe(false);
});

test('uses representative coordinates only for satellite-detected events', () => {
  const marker = [-120.01, 37.01];
  const representative = { representativeLatitude: 37.02, representativeLongitude: -120.02 };

  expect(predictionCoordinates({
    ...representative,
    status: 'satellite_detected_active_fire'
  }, marker)).toEqual({ latitude: 37.02, longitude: -120.02 });
  expect(predictionCoordinates({
    ...representative,
    status: 'confirmed_wildfire'
  }, marker)).toEqual({ latitude: 37.01, longitude: -120.01 });
  expect(predictionCoordinates({
    ...representative,
    status: 'unverified_thermal_anomaly'
  }, marker)).toEqual({ latitude: 37.01, longitude: -120.01 });
});
