import { hasSatelliteObservation } from './detectionStatus';
import { parseClusterCoordinates } from './perimeter';

export const EVENT_TYPE_OPTIONS = [
  { value: 'confirmed_wildfire', label: 'Confirmed wildfire', color: '#d7191c' },
  { value: 'satellite_detected_active_fire', label: 'Satellite-detected fire', color: '#ff7f00' },
  { value: 'unverified_thermal_anomaly', label: 'Unverified thermal anomaly', color: '#f6c344' },
  {
    value: 'reported_incident_no_recent_satellite_detection',
    label: 'Official report - no recent satellite detection',
    color: '#2c7bb6'
  }
];

export const ALL_EVENT_TYPES = EVENT_TYPE_OPTIONS.map(option => option.value);

export function boundaryAvailability(event) {
  if (event?.hasOfficialPerimeter === true || event?.hasOfficialPerimeter === 'true') {
    return 'official';
  }
  if (parseClusterCoordinates(event?.cluster_coordinates).length) return 'estimated';
  return 'none';
}

export function filterDetectionEvents(events, filters, now = Date.now()) {
  const allowedTypes = new Set(filters.eventTypes || []);
  const recencyHours = Number(filters.recencyHours);
  const cutoff = recencyHours > 0 ? now - recencyHours * 60 * 60 * 1000 : null;

  return (events || []).filter(event => {
    if (!allowedTypes.has(event.status)) return false;
    if (filters.boundaryFilter !== 'all' &&
        boundaryAvailability(event) !== filters.boundaryFilter) return false;

    if (cutoff !== null) {
      const observedAt = new Date(event.timestamp).getTime();
      if (!hasSatelliteObservation(event) || !Number.isFinite(observedAt) || observedAt < cutoff) {
        return false;
      }
    }
    return true;
  });
}
