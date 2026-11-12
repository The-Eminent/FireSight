import { polygon } from '@turf/helpers';
import {
  calculateSafeWaypoint,
  proximityAlert,
  safetyCircle
} from './evacuation';

const home = { lng: 0, lat: 0 };
const nearby = polygon([[[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02], [-0.02, -0.02]]]);
const distant = polygon([[[2, 2], [2.1, 2], [2.1, 2.1], [2, 2.1], [2, 2]]]);

test('creates a ten-mile polygon around the home location', () => {
  const radius = safetyCircle(home);
  expect(radius.geometry.type).toBe('Polygon');
  expect(radius.properties.radius).toBeUndefined();
  expect(radius.geometry.coordinates[0].length).toBe(97);
});

test('prediction alert overrides a current-fire alert', () => {
  expect(proximityAlert(home, [nearby], nearby)).toBe('evacuation');
  expect(proximityAlert(home, [nearby], distant)).toBe('nearby');
  expect(proximityAlert(home, [distant], distant)).toBeNull();
});

test('safe waypoint continues from the fire through the user location', () => {
  const fireWest = polygon([[[-0.2, -0.01], [-0.1, -0.01], [-0.1, 0.01], [-0.2, 0.01], [-0.2, -0.01]]]);
  const waypoint = calculateSafeWaypoint(home, fireWest);

  expect(waypoint.bearing).toBeCloseTo(90, 0);
  expect(waypoint.lng).toBeGreaterThan(0);
  expect(Math.abs(waypoint.lat)).toBeLessThan(0.01);
});
