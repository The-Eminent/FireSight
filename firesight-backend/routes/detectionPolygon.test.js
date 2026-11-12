const test = require('node:test');
const assert = require('node:assert/strict');
const { officialPerimeterFeature } = require('./detectionPolygon');

test('returns saved WFIGS geometry without rebuilding it', () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [[[-120, 37], [-119.9, 37], [-120, 37.1], [-120, 37]]]
  };
  const feature = officialPerimeterFeature({
    incidentId: 'incident-123',
    currentAt: new Date('2026-10-20T12:00:00Z'),
    geometry
  });

  assert.equal(feature.properties.source, 'wfigs');
  assert.equal(feature.properties.incidentId, 'incident-123');
  assert.equal(feature.geometry, geometry);
});
