import { polygon } from '@turf/helpers';
import {
  calculateSafeWaypoint,
  HOME_LOCATION_STORAGE_KEY,
  intersectingBoundaryKeys,
  loadSavedHomeLocation,
  notificationButtonLabel,
  notificationPermissionAction,
  proximityAlert,
  saveHomeLocation,
  safetyCircle
} from './evacuation';

const home = { lng: 0, lat: 0 };
const nearby = polygon([[[-0.02, -0.02], [0.02, -0.02], [0.02, 0.02], [-0.02, 0.02], [-0.02, -0.02]]]);
const distant = polygon([[[2, 2], [2.1, 2], [2.1, 2.1], [2, 2.1], [2, 2]]]);

test('uses simple desktop-notification permission labels', () => {
  expect(notificationButtonLabel('default')).toBe('Get Desktop Notifications');
  expect(notificationButtonLabel('denied')).toBe('Get Desktop Notifications');
  expect(notificationButtonLabel('granted')).toBe('Desktop Notifications Allowed');
  expect(notificationButtonLabel('unsupported')).toBe('Desktop Notifications Unavailable');
});

test('requests undecided notification permission and explains a browser block', () => {
  expect(notificationPermissionAction('default')).toBe('request');
  expect(notificationPermissionAction('denied')).toBe('help');
  expect(notificationPermissionAction('granted')).toBe('none');
});

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

test('returns only event keys whose boundaries intersect the safety radius', () => {
  const records = [
    { key: 'near-fire', boundary: nearby },
    { key: 'far-fire', boundary: distant }
  ];

  expect(intersectingBoundaryKeys(home, records)).toEqual(['near-fire']);
  expect(intersectingBoundaryKeys(null, records)).toEqual([]);
});

test('persists, restores and clears a valid home location', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key)
  };

  saveHomeLocation({ lat: 34.05, lng: -118.25 }, storage);
  expect(loadSavedHomeLocation(storage)).toEqual({ lat: 34.05, lng: -118.25 });
  saveHomeLocation(null, storage);
  expect(values.has(HOME_LOCATION_STORAGE_KEY)).toBe(false);
});

test('rejects invalid persisted home coordinates', () => {
  const storage = { getItem: () => '{"lat":120,"lng":-118}' };
  expect(loadSavedHomeLocation(storage)).toBeNull();
});
