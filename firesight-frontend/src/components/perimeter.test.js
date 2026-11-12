import {
  canShowPerimeter,
  eventMarkerCoordinates,
  geoJsonBounds,
  parseClusterCoordinates,
  perimeterActionLabel,
  perimeterResultLabel
} from './perimeter';

test('parses Mapbox-serialized cluster coordinates', () => {
  expect(parseClusterCoordinates('[[-120,37],[-119.5,38]]')).toEqual([
    [-120, 37],
    [-119.5, 38]
  ]);
  expect(parseClusterCoordinates('invalid')).toEqual([]);
});

test('centers active-event markers on their satellite coordinates', () => {
  expect(eventMarkerCoordinates({
    longitude: -120,
    latitude: 37,
    cluster_coordinates: [[-119, 38], [-117, 36]]
  })).toEqual([-118, 37]);
  expect(eventMarkerCoordinates({ longitude: -120, latitude: 37, cluster_coordinates: [] }))
    .toEqual([-120, 37]);
});

test('calculates bounds for Polygon and MultiPolygon features', () => {
  const polygon = {
    geometry: {
      type: 'Polygon',
      coordinates: [[[-120, 37], [-119, 38], [-118, 36], [-120, 37]]]
    }
  };
  const multiPolygon = {
    geometry: {
      type: 'MultiPolygon',
      coordinates: [polygon.geometry.coordinates, [[[-121, 35], [-120, 36], [-121, 35]]]]
    }
  };

  expect(geoJsonBounds(polygon)).toEqual([[-120, 36], [-118, 38]]);
  expect(geoJsonBounds(multiPolygon)).toEqual([[-121, 35], [-118, 38]]);
});

test('distinguishes official perimeters from synthetic satellite footprints', () => {
  expect(perimeterActionLabel(true)).toBe('Show Current Perimeter');
  expect(perimeterActionLabel(false)).toBe('Show Estimated Satellite Footprint');
  expect(perimeterResultLabel('wfigs')).toBe('Official Perimeter Shown');
  expect(perimeterResultLabel('synthetic')).toBe('Estimated Satellite Footprint Shown');
});

test('shows perimeter access for an official-only incident', () => {
  expect(canShowPerimeter([], true)).toBe(true);
  expect(canShowPerimeter([[-120, 37]], false)).toBe(true);
  expect(canShowPerimeter([], false)).toBe(false);
});
