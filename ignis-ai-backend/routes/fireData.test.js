const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCSV, deduplicateObservations, isRefreshLocked } = require('./fireData');
const {
  FIRMS_SOURCES,
  isAllowedNoaaObservation,
  partitionSpatialContext,
  sortObservationsChronologically,
  SPATIAL_CONTEXT_VERSION
} = require('../services/wildfireRefresh');

test('pulls only NOAA-20 and NOAA-21 VIIRS feeds', () => {
  assert.deepEqual(FIRMS_SOURCES, ['VIIRS_NOAA21_NRT', 'VIIRS_NOAA20_NRT']);
  assert.equal(isAllowedNoaaObservation({
    source: 'VIIRS_NOAA20_NRT', satellite: 'N20'
  }), true);
  assert.equal(isAllowedNoaaObservation({
    source: 'VIIRS_SNPP_NRT', satellite: 'NPP'
  }), false);
  assert.equal(isAllowedNoaaObservation({
    source: 'MODIS_NRT', satellite: 'Aqua'
  }), false);
});

test('parses VIIRS observations by header', () => {
  const csv = [
    'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
    '39.23505,-122.99954,341.2,0.4,0.4,2026-09-20,0930,N21,VIIRS,h,2.0NRT,300.1,18.4,D'
  ].join('\n');

  const [fire] = parseCSV(csv, 'VIIRS_NOAA21_NRT');
  assert.equal(fire.brightness, 341.2);
  assert.equal(fire.confidence, 'h');
  assert.equal(fire.source, 'VIIRS_NOAA21_NRT');
  assert.equal(fire.timestamp.toISOString(), '2026-09-20T09:30:00.000Z');
  assert.deepEqual(fire.location, {
    type: 'Point',
    coordinates: [-122.99954, 39.23505]
  });
  assert.equal(fire.acquiredAt.toISOString(), fire.timestamp.toISOString());
});

test('parses MODIS brightness and numeric confidence', () => {
  const csv = [
    'latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight',
    '35.90356,-121.41472,322.5,1.0,1.0,2026-09-20,0815,Aqua,MODIS,87,6.1NRT,291.0,12.2,N'
  ].join('\n');

  const [fire] = parseCSV(csv, 'MODIS_NRT');
  assert.equal(fire.brightness, 322.5);
  assert.equal(fire.confidence, '87');
  assert.equal(fire.instrument, 'MODIS');
});

test('deduplicates repeated observations without merging different sensors', () => {
  const viirs = { detectionId: 'viirs:one' };
  const modis = { detectionId: 'modis:one' };
  assert.deepEqual(deduplicateObservations([viirs, viirs, modis]), [viirs, modis]);
});

test('sorts combined satellite observations by acquisition time', () => {
  const later = { detectionId: 'later', acquiredAt: new Date('2026-10-20T18:00:00Z') };
  const earlier = { detectionId: 'earlier', acquiredAt: new Date('2026-10-20T16:00:00Z') };
  const input = [later, earlier];

  assert.deepEqual(sortObservationsChronologically(input), [earlier, later]);
  assert.deepEqual(input, [later, earlier]);
});

test('reuses current spatial context and only classifies new or stale observations', () => {
  const observations = [{ detectionId: 'current' }, { detectionId: 'stale' }, { detectionId: 'new' }];
  const stored = [
    { detectionId: 'current', processing: { contextVersion: SPATIAL_CONTEXT_VERSION } },
    { detectionId: 'stale', processing: { contextVersion: 'older-version' } }
  ];
  const result = partitionSpatialContext(observations, stored);
  assert.equal(result.reusable.size, 1);
  assert.deepEqual(result.needingContext, [{ detectionId: 'stale' }, { detectionId: 'new' }]);
});

test('locks manual refreshes for twenty minutes after a completed snapshot', () => {
  const now = new Date('2026-10-20T12:20:00Z').getTime();
  assert.equal(isRefreshLocked('2026-10-20T12:01:00Z', now), true);
  assert.equal(isRefreshLocked('2026-10-20T12:00:00Z', now), false);
  assert.equal(isRefreshLocked(null, now), false);
});
