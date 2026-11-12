const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS,
  clusterObservations,
  fuseDetections,
  pointInPolygon
} = require('./detectionFusion');

function observation(id, latitude, longitude, timestamp = '2026-09-20T12:00:00Z', brightness = 340) {
  return {
    detectionId: id,
    source: 'VIIRS_NOAA21_NRT',
    latitude,
    longitude,
    brightness,
    confidence: 'h',
    timestamp: new Date(timestamp)
  };
}

function incident(id, latitude, longitude) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties: {
      IrwinID: `{${id}}`,
      IncidentName: 'TEST FIRE',
      InitialLatitude: latitude,
      InitialLongitude: longitude,
      FireDiscoveryDateTime: '2026-09-20T10:00:00Z',
      IncidentSize: 100,
      PercentContained: 20
    }
  };
}

test('clusters nearby observations and leaves a distant observation separate', () => {
  const clusters = clusterObservations([
    observation('one', 37, -120),
    observation('two', 37.01, -120.01),
    observation('three', 40, -110)
  ], 5);

  assert.deepEqual(clusters.map(cluster => cluster.length).sort(), [1, 2]);
});

test('does not merge observations outside the event time window', () => {
  const clusters = clusterObservations([
    observation('one', 37, -120, '2026-09-18T01:00:00Z'),
    observation('two', 37, -120, '2026-09-20T01:00:00Z')
  ], 5, 24);

  assert.deepEqual(clusters.map(cluster => cluster.length), [1, 1]);
});

test('spatial buckets preserve connected clusters across cell boundaries', () => {
  const clusters = clusterObservations([
    observation('one', 49, -120),
    observation('two', 49, -119.94),
    observation('three', 49, -119.88)
  ], 5, 24);

  assert.deepEqual(clusters.map(cluster => cluster.length), [3]);
});

test('point-in-polygon respects polygon holes', () => {
  const geometry = {
    type: 'Polygon',
    coordinates: [
      [[-121, 36], [-119, 36], [-119, 38], [-121, 38], [-121, 36]],
      [[-120.2, 36.8], [-119.8, 36.8], [-119.8, 37.2], [-120.2, 37.2], [-120.2, 36.8]]
    ]
  };
  assert.equal(pointInPolygon({ latitude: 36.5, longitude: -120 }, geometry), true);
  assert.equal(pointInPolygon({ latitude: 37, longitude: -120 }, geometry), false);
});

test('fuses a satellite cluster with an official incident and reports metrics', () => {
  const observations = [
    observation('one', 37, -120, '2026-09-20T11:00:00Z'),
    observation('two', 37.01, -120.01, '2026-09-20T12:00:00Z')
  ];
  const result = fuseDetections(observations, [incident('ABC', 37, -120)], []);

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].status, STATUS.CONFIRMED);
  assert.equal(result.events[0].observationCount, 2);
  assert.deepEqual(result.events[0].cluster_coordinates, [
    [-120, 37],
    [-120.01, 37.01]
  ]);
  assert.equal(result.metrics.recall, 1);
  assert.equal(result.metrics.officialConfirmationProxy, 1);
  assert.equal(result.metrics.averageDetectionLatencyHours, 1);
});

test('labels unmatched clusters and singletons without claiming confirmation', () => {
  const observations = [
    observation('one', 37, -120),
    observation('two', 37.01, -120.01),
    observation('three', 42, -110)
  ];
  const result = fuseDetections(observations, [], []);

  assert.deepEqual(
    result.events.map(event => event.status).sort(),
    [STATUS.SATELLITE, STATUS.ANOMALY].sort()
  );
});

test('keeps satellite centroid and highest-brightness observation coordinates separate', () => {
  const result = fuseDetections([
    observation('one', 37, -120, '2026-09-20T12:00:00Z', 330),
    observation('two', 37.02, -120.02, '2026-09-20T12:30:00Z', 360)
  ], [], []);
  const [event] = result.events;

  assert.equal(event.status, STATUS.SATELLITE);
  assert.ok(Math.abs(event.latitude - 37.01) < 1e-10);
  assert.ok(Math.abs(event.longitude - -120.01) < 1e-10);
  assert.equal(event.brightness, 360);
  assert.equal(event.representativeLatitude, 37.02);
  assert.equal(event.representativeLongitude, -120.02);
});

test('includes official incidents with no recent satellite observation', () => {
  const result = fuseDetections([], [incident('ABC', 37, -120)], []);

  assert.equal(result.events[0].status, STATUS.REPORTED);
  assert.equal(result.events[0].observationCount, 0);
  assert.deepEqual(result.events[0].cluster_coordinates, []);
  assert.equal(result.events[0].brightness, null);
  assert.equal(result.metrics.recall, 0);
});

test('excludes official incidents outside the FIRMS request bounds from recall', () => {
  const result = fuseDetections([], [
    incident('CONUS', 37, -120),
    incident('ALASKA', 64, -150)
  ], []);

  assert.equal(result.events.length, 1);
  assert.equal(result.metrics.officialIncidentCount, 1);
});

test('uses precomputed WFIGS matches and DBSCAN clusters while excluding noise', () => {
  const matched = observation('matched', 37, -120);
  const dense = [
    observation('dense-1', 38, -121),
    observation('dense-2', 38.001, -121.001),
    observation('dense-3', 38.002, -121.002)
  ];
  const result = fuseDetections(
    [matched, ...dense, observation('noise', 40, -110)],
    [incident('ABC', 37, -120)],
    [],
    {
      incidentMatches: new Map([['matched', 'abc']]),
      unmatchedClusters: [dense],
      ignoredNoiseObservationCount: 1
    }
  );

  assert.deepEqual(result.events.map(event => event.status).sort(), [
    STATUS.CONFIRMED,
    STATUS.SATELLITE
  ].sort());
  assert.equal(result.metrics.ignoredNoiseObservationCount, 1);
  assert.equal(result.metrics.densityClusterEpsMeters, 1500);
  assert.equal(result.metrics.densityClusterMinSamples, 3);
  assert.equal(result.metrics.incidentMatchKm, undefined);
});
