const test = require('node:test');
const assert = require('node:assert/strict');
const { applySpatialContext, geometryBbox } = require('./spatialData');

function observation(latitude, longitude) {
  return {
    detectionId: `${latitude}:${longitude}`,
    latitude,
    longitude,
    location: { type: 'Point', coordinates: [longitude, latitude] }
  };
}

test('marks a detection inside a curated industrial exclusion radius', () => {
  const [result] = applySpatialContext(
    [observation(34.05, -118.25)],
    [{
      sourceId: 'facility-1',
      active: true,
      radiusMeters: 100,
      location: { type: 'Point', coordinates: [-118.2503, 34.0502] }
    }],
    []
  );

  assert.equal(result.processing.industrialBlacklistChecked, true);
  assert.equal(result.processing.industrialMatch, true);
  assert.equal(result.processing.excludedFromFusion, true);
  assert.equal(result.processing.industrialSourceId, 'facility-1');
});

test('does not exclude an observation outside the industrial radius', () => {
  const [result] = applySpatialContext(
    [observation(34.05, -118.25)],
    [{
      sourceId: 'facility-1',
      active: true,
      radiusMeters: 100,
      location: { type: 'Point', coordinates: [-118.30, 34.10] }
    }],
    []
  );

  assert.equal(result.processing.industrialMatch, false);
  assert.equal(result.processing.excludedFromFusion, false);
});

test('adds urban context without reclassifying or excluding the detection', () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [[
      [-119, 33], [-117, 33], [-117, 35], [-119, 35], [-119, 33]
    ]]
  };
  const [result] = applySpatialContext(
    [observation(34.05, -118.25)],
    [],
    [{ sourceId: 'urban-1', name: 'Test Urban Area', geometry, bbox: geometryBbox(geometry) }]
  );

  assert.equal(result.processing.urbanBoundaryChecked, true);
  assert.equal(result.processing.intersectsUrbanArea, true);
  assert.equal(result.processing.urbanAreaName, 'Test Urban Area');
  assert.equal(result.processing.excludedFromFusion, false);
});

test('computes bounding boxes for Polygon and MultiPolygon coordinates', () => {
  assert.deepEqual(geometryBbox({
    type: 'MultiPolygon',
    coordinates: [
      [[[1, 2], [3, 2], [3, 4], [1, 2]]],
      [[[-5, -1], [-4, -1], [-4, 0], [-5, -1]]]
    ]
  }), [-5, -1, 3, 4]);
});
