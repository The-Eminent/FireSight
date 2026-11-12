import bbox from '@turf/bbox';
import bearing from '@turf/bearing';
import booleanIntersects from '@turf/boolean-intersects';
import centroid from '@turf/centroid';
import circle from '@turf/circle';
import destination from '@turf/destination';
import { point } from '@turf/helpers';

export const SAFETY_RADIUS_MILES = 10;
export const SAFE_WAYPOINT_MILES = 15;

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
