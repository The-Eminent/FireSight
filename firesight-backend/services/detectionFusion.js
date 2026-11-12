const EARTH_RADIUS_KM = 6371;

const STATUS = {
  CONFIRMED: 'confirmed_wildfire',
  SATELLITE: 'satellite_detected_active_fire',
  ANOMALY: 'unverified_thermal_anomaly',
  REPORTED: 'reported_incident_no_recent_satellite_detection'
};

function haversineKm(a, b) {
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const value = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function normalizeIncidentId(value) {
  return String(value || '').replace(/[{}]/g, '').toLowerCase();
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = ((yi > point.latitude) !== (yj > point.latitude)) &&
      (point.longitude < (xj - xi) * (point.latitude - yi) / (yj - yi) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, geometry) {
  if (!geometry) return false;
  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(rings =>
    rings.length > 0 && pointInRing(point, rings[0]) &&
    !rings.slice(1).some(ring => pointInRing(point, ring))
  );
}

function clusterObservations(observations, radiusKm = 5, windowHours = 24) {
  const visited = new Set();
  const clusters = [];
  if (!observations.length) return clusters;
  const cellDegrees = Math.max(radiusKm / 111.32, 0.000001);
  const timestamps = observations.map(item => new Date(item.timestamp).getTime());
  const grid = new Map();
  const cellKey = (latitudeCell, longitudeCell) => `${latitudeCell}:${longitudeCell}`;
  observations.forEach((observation, index) => {
    const latitudeCell = Math.floor(observation.latitude / cellDegrees);
    const longitudeCell = Math.floor(observation.longitude / cellDegrees);
    const key = cellKey(latitudeCell, longitudeCell);
    const bucket = grid.get(key) || [];
    bucket.push(index);
    grid.set(key, bucket);
  });

  const neighborsOf = index => {
    const origin = observations[index];
    const latitudeCell = Math.floor(origin.latitude / cellDegrees);
    const longitudeCell = Math.floor(origin.longitude / cellDegrees);
    const longitudeRadius = Math.max(
      1,
      Math.ceil(1 / Math.max(Math.cos(origin.latitude * Math.PI / 180), 0.1))
    );
    const neighbors = [];
    for (let latitudeOffset = -1; latitudeOffset <= 1; latitudeOffset += 1) {
      for (let longitudeOffset = -longitudeRadius;
        longitudeOffset <= longitudeRadius; longitudeOffset += 1) {
        const candidates = grid.get(cellKey(
          latitudeCell + latitudeOffset,
          longitudeCell + longitudeOffset
        )) || [];
        candidates.forEach(candidate => {
          const timeDifferenceHours = Math.abs(timestamps[candidate] - timestamps[index]) / 3600000;
          if (timeDifferenceHours <= windowHours &&
            haversineKm(observations[candidate], origin) <= radiusKm) {
            neighbors.push(candidate);
          }
        });
      }
    }
    return neighbors;
  };

  observations.forEach((observation, index) => {
    if (visited.has(index)) return;
    visited.add(index);
    const clusterIndexes = new Set([index]);
    const queue = neighborsOf(index);
    const queued = new Set(queue);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const candidate = queue[cursor];
      if (visited.has(candidate)) continue;
      visited.add(candidate);
      clusterIndexes.add(candidate);
      neighborsOf(candidate).forEach(neighbor => {
        if (!visited.has(neighbor) && !queued.has(neighbor)) {
          queued.add(neighbor);
          queue.push(neighbor);
        }
      });
    }
    clusters.push([...clusterIndexes].map(candidate => observations[candidate]));
  });
  return clusters;
}

function parseIncident(feature) {
  const properties = feature.properties || {};
  const coordinates = feature.geometry?.coordinates || [];
  return {
    id: normalizeIncidentId(properties.IrwinID || properties.UniqueFireIdentifier),
    uniqueFireIdentifier: properties.UniqueFireIdentifier || null,
    name: properties.IncidentName || 'Unnamed incident',
    latitude: Number(properties.InitialLatitude ?? coordinates[1]),
    longitude: Number(properties.InitialLongitude ?? coordinates[0]),
    discoveryAt: properties.FireDiscoveryDateTime || null,
    modifiedAt: properties.ModifiedOnDateTime_dt || null,
    sizeAcres: properties.IncidentSize ?? null,
    percentContained: properties.PercentContained ?? null,
    state: properties.POOState || null
  };
}

function parsePerimeter(feature) {
  const properties = feature.properties || {};
  return {
    incidentId: normalizeIncidentId(properties.poly_IRWINID || properties.attr_IrwinID),
    geometry: feature.geometry,
    acres: properties.poly_GISAcres ?? properties.attr_IncidentSize ?? null,
    currentAt: properties.poly_DateCurrent || null
  };
}

function representativeObservation(observations) {
  return observations.reduce((best, observation) =>
    Number(observation.brightness) > Number(best.brightness) ? observation : best);
}

function eventFromObservations(observations, status, incident = null, perimeter = null) {
  const representative = representativeObservation(observations);
  const timestamps = observations.map(item => new Date(item.timestamp).getTime()).filter(Number.isFinite);
  return {
    eventId: incident?.id ? `official:${incident.id}` : `satellite:${observations[0].detectionId}`,
    status,
    latitude: incident?.latitude ?? observations.reduce((sum, item) => sum + item.latitude, 0) / observations.length,
    longitude: incident?.longitude ?? observations.reduce((sum, item) => sum + item.longitude, 0) / observations.length,
    brightness: representative.brightness,
    confidence: representative.confidence,
    ...(status === STATUS.SATELLITE ? {
      representativeLatitude: representative.latitude,
      representativeLongitude: representative.longitude
    } : {}),
    timestamp: timestamps.length ? new Date(Math.max(...timestamps)) : null,
    firstObservedAt: timestamps.length ? new Date(Math.min(...timestamps)) : null,
    observationCount: observations.length,
    cluster_coordinates: observations.map(item => [item.longitude, item.latitude]),
    sources: [...new Set(observations.map(item => item.source))],
    incidentName: incident?.name || null,
    officialIncidentId: incident?.id || null,
    uniqueFireIdentifier: incident?.uniqueFireIdentifier || null,
    incidentSizeAcres: perimeter?.acres ?? incident?.sizeAcres ?? null,
    percentContained: incident?.percentContained ?? null,
    discoveryAt: incident?.discoveryAt || null,
    hasOfficialPerimeter: Boolean(perimeter?.geometry)
  };
}

function reportedEvent(incident, perimeter) {
  return {
    eventId: `official:${incident.id}`,
    status: STATUS.REPORTED,
    latitude: incident.latitude,
    longitude: incident.longitude,
    brightness: null,
    confidence: null,
    timestamp: incident.modifiedAt,
    firstObservedAt: null,
    observationCount: 0,
    cluster_coordinates: [],
    sources: ['NIFC_WFIGS'],
    incidentName: incident.name,
    officialIncidentId: incident.id,
    uniqueFireIdentifier: incident.uniqueFireIdentifier,
    incidentSizeAcres: perimeter?.acres ?? incident.sizeAcres,
    percentContained: incident.percentContained,
    discoveryAt: incident.discoveryAt,
    hasOfficialPerimeter: Boolean(perimeter?.geometry)
  };
}

function fuseDetections(observations, incidentFeatures, perimeterFeatures, options = {}) {
  const clusterRadiusKm = options.clusterRadiusKm ?? 5;
  const clusterWindowHours = options.clusterWindowHours ?? 24;
  const incidentMatchKm = options.incidentMatchKm ?? 15;
  const bounds = options.bounds || { west: -125, south: 24, east: -66, north: 49 };
  const incidents = incidentFeatures.map(parseIncident)
    .filter(item => item.id && Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
    .filter(item => item.longitude >= bounds.west && item.longitude <= bounds.east &&
      item.latitude >= bounds.south && item.latitude <= bounds.north);
  const perimeters = new Map(perimeterFeatures.map(parsePerimeter)
    .filter(item => item.incidentId)
    .map(item => [item.incidentId, item]));
  const matchedByIncident = new Map();
  let matchedClusters = 0;
  let clusters;

  if (options.incidentMatches instanceof Map) {
    observations.forEach(observation => {
      const incidentId = options.incidentMatches.get(observation.detectionId);
      if (!incidentId) return;
      const existing = matchedByIncident.get(incidentId) || [];
      matchedByIncident.set(incidentId, existing.concat(observation));
    });
    matchedClusters = matchedByIncident.size;
    const unmatchedClusters = options.unmatchedClusters || [];
    unmatchedClusters.forEach((cluster, index) => {
      matchedByIncident.set(`cluster:${index}`, cluster);
    });
    clusters = [...matchedByIncident.values()];
  } else {
    clusters = clusterObservations(observations, clusterRadiusKm, clusterWindowHours);
    clusters.forEach((cluster, index) => {
      const centroid = {
        latitude: cluster.reduce((sum, item) => sum + item.latitude, 0) / cluster.length,
        longitude: cluster.reduce((sum, item) => sum + item.longitude, 0) / cluster.length
      };
      const perimeterMatch = incidents.find(incident => {
        const perimeter = perimeters.get(incident.id);
        return perimeter && cluster.some(point => pointInPolygon(point, perimeter.geometry));
      });
      const nearest = incidents.reduce((best, incident) => {
        const distance = haversineKm(centroid, incident);
        return !best || distance < best.distance ? { incident, distance } : best;
      }, null);
      const incident = perimeterMatch || (nearest?.distance <= incidentMatchKm ? nearest.incident : null);

      if (incident) {
        matchedClusters += 1;
        const existing = matchedByIncident.get(incident.id) || [];
        matchedByIncident.set(incident.id, existing.concat(cluster));
      } else {
        matchedByIncident.set(`cluster:${index}`, cluster);
      }
    });
  }

  const events = [];
  incidents.forEach(incident => {
    const observationsForIncident = matchedByIncident.get(incident.id);
    events.push(observationsForIncident
      ? eventFromObservations(observationsForIncident, STATUS.CONFIRMED, incident, perimeters.get(incident.id))
      : reportedEvent(incident, perimeters.get(incident.id)));
    matchedByIncident.delete(incident.id);
  });
  matchedByIncident.forEach(cluster => events.push(eventFromObservations(
    cluster,
    cluster.length >= 2 ? STATUS.SATELLITE : STATUS.ANOMALY
  )));

  const matchedIncidentEvents = events.filter(event => event.status === STATUS.CONFIRMED);
  const observationTimes = observations
    .map(item => new Date(item.timestamp).getTime())
    .filter(Number.isFinite);
  const observationWindowStart = observationTimes.length ? Math.min(...observationTimes) : null;
  const latencyWindowStart = observationWindowStart === null
    ? null
    : observationWindowStart - 48 * 3600000;
  const latencyHours = matchedIncidentEvents
    .map(event => event.discoveryAt && event.firstObservedAt
      && new Date(event.discoveryAt).getTime() >= latencyWindowStart
      ? (new Date(event.firstObservedAt) - new Date(event.discoveryAt)) / 3600000
      : null)
    .filter(value => Number.isFinite(value));

  return {
    events,
    metrics: {
      officialIncidentCount: incidents.length,
      matchedOfficialIncidentCount: matchedIncidentEvents.length,
      recall: incidents.length ? matchedIncidentEvents.length / incidents.length : null,
      satelliteEventCount: clusters.length,
      officiallyMatchedSatelliteEventCount: matchedClusters,
      officialConfirmationProxy: clusters.length ? matchedClusters / clusters.length : null,
      latencySampleCount: latencyHours.length,
      averageDetectionLatencyHours: latencyHours.length
        ? latencyHours.reduce((sum, value) => sum + value, 0) / latencyHours.length
        : null,
      ignoredNoiseObservationCount: options.ignoredNoiseObservationCount || 0,
      ...(options.incidentMatches instanceof Map ? {
        densityClusterEpsMeters: 1500,
        densityClusterMinSamples: 3,
        wfigsBufferKmByAcres: { under500: 5, upTo10000: 10, over10000: 15 }
      } : {
        clusterRadiusKm,
        clusterWindowHours,
        incidentMatchKm
      })
    }
  };
}

module.exports = {
  STATUS,
  clusterObservations,
  fuseDetections,
  haversineKm,
  pointInPolygon
};
