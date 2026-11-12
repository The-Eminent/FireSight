import {
  ALL_EVENT_TYPES,
  boundaryAvailability,
  filterDetectionEvents
} from './eventFilters';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const base = {
  status: 'satellite_detected_active_fire',
  observationCount: 3,
  brightness: 350,
  timestamp: '2026-11-05T10:00:00Z',
  cluster_coordinates: [[-120, 40], [-120.01, 40.01]],
  hasOfficialPerimeter: false
};

test('classifies official, estimated, and unavailable boundaries', () => {
  expect(boundaryAvailability({ ...base, hasOfficialPerimeter: true })).toBe('official');
  expect(boundaryAvailability(base)).toBe('estimated');
  expect(boundaryAvailability({ ...base, cluster_coordinates: [] })).toBe('none');
});

test('filters event type and boundary availability', () => {
  const events = [
    { ...base, status: 'confirmed_wildfire', hasOfficialPerimeter: true },
    base
  ];
  expect(filterDetectionEvents(events, {
    eventTypes: ['confirmed_wildfire'],
    recencyHours: '',
    boundaryFilter: 'official'
  }, NOW)).toEqual([events[0]]);
});

test('recency filters use recent satellite observations only', () => {
  const officialOnly = {
    ...base,
    status: 'reported_incident_no_recent_satellite_detection',
    observationCount: 0,
    brightness: null,
    timestamp: '2026-11-05T11:00:00Z',
    cluster_coordinates: []
  };
  const oldSatelliteEvent = { ...base, timestamp: '2026-11-03T10:00:00Z' };
  expect(filterDetectionEvents([base, officialOnly, oldSatelliteEvent], {
    eventTypes: ALL_EVENT_TYPES,
    recencyHours: '24',
    boundaryFilter: 'all'
  }, NOW)).toEqual([base]);
});
