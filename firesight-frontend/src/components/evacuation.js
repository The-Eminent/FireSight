import bbox from '@turf/bbox';
import bearing from '@turf/bearing';
import booleanIntersects from '@turf/boolean-intersects';
import centroid from '@turf/centroid';
import circle from '@turf/circle';
import destination from '@turf/destination';
import { point } from '@turf/helpers';

export const SAFETY_RADIUS_MILES = 10;
export const SAFE_WAYPOINT_MILES = 15;
export const HOME_LOCATION_STORAGE_KEY = 'firesight-home-location';

export function notificationButtonLabel(permission) {
  if (permission === 'granted') return 'Desktop Notifications Allowed';
  if (permission === 'unsupported') return 'Desktop Notifications Unavailable';
  return 'Get Desktop Notifications';
}

export function notificationPermissionAction(permission) {
  if (permission === 'denied') return 'help';
  if (permission === 'default') return 'request';
  return 'none';
}

function validHomeLocation(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  return Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    Number.isFinite(lng) && lng >= -180 && lng <= 180
    ? { lat, lng }
    : null;
}

export function loadSavedHomeLocation(storage) {
  try {
    const target = storage || window.localStorage;
    return validHomeLocation(JSON.parse(target.getItem(HOME_LOCATION_STORAGE_KEY)));
  } catch {
    return null;
  }
}

export function saveHomeLocation(location, storage) {
  try {
    const target = storage || window.localStorage;
    const validLocation = validHomeLocation(location);
    if (validLocation) {
      target.setItem(HOME_LOCATION_STORAGE_KEY, JSON.stringify(validLocation));
    } else {
      target.removeItem(HOME_LOCATION_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

function homePoint(location) {
  return point([Number(location.lng), Number(location.lat)]);
}

export function safetyCircle(location) {
  if (!location) return null;
  return circle(homePoint(location), SAFETY_RADIUS_MILES, {
    units: 'miles',
    steps: 96
  });
}

function intersects(circleFeature, polygonFeature) {
  try {
    return Boolean(
      polygonFeature?.geometry && booleanIntersects(circleFeature, polygonFeature)
    );
  } catch {
    return false;
  }
}

export function proximityAlert(location, currentBoundaries = [], prediction = null) {
  const radius = safetyCircle(location);
  if (!radius) return null;
  if (intersects(radius, prediction)) return 'evacuation';
  return currentBoundaries.some(boundary => intersects(radius, boundary))
    ? 'nearby'
    : null;
}

export function intersectingBoundaryKeys(location, boundaryRecords = []) {
  const radius = safetyCircle(location);
  if (!radius) return [];
  return boundaryRecords
    .filter(record => record?.key && intersects(radius, record.boundary))
    .map(record => String(record.key));
}

export function calculateSafeWaypoint(location, prediction) {
  if (!location || !prediction?.geometry) return null;
  const fireCenter = centroid(prediction);
  const awayBearing = bearing(fireCenter, homePoint(location));
  const safePoint = destination(
    homePoint(location), SAFE_WAYPOINT_MILES, awayBearing, { units: 'miles' }
  );
  const [lng, lat] = safePoint.geometry.coordinates;
  return { lng, lat, bearing: awayBearing };
}

export function featureBounds(feature) {
  const [west, south, east, north] = bbox(feature);
  return [[west, south], [east, north]];
}
