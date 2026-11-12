const labels = {
  confirmed_wildfire: 'Confirmed wildfire',
  satellite_detected_active_fire: 'Satellite-detected active fire',
  unverified_thermal_anomaly: 'Unverified thermal anomaly',
  reported_incident_no_recent_satellite_detection: 'Reported incident - no recent satellite detection'
};

export function detectionStatusLabel(status) {
  return labels[status] || 'Satellite detection';
}

export function hasSatelliteObservation(event) {
  return Number(event?.observationCount) > 0 && Number.isFinite(Number(event?.brightness));
}

export function predictionCoordinates(event, markerCoordinates) {
  const useRepresentative = event?.status === 'satellite_detected_active_fire' &&
    Number.isFinite(Number(event?.representativeLatitude)) &&
    Number.isFinite(Number(event?.representativeLongitude));
  return {
    latitude: useRepresentative ? Number(event.representativeLatitude) : markerCoordinates[1],
    longitude: useRepresentative ? Number(event.representativeLongitude) : markerCoordinates[0]
  };
}
