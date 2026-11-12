const CityBoundary = require('../models/CityBoundary');
const IndustrialLocation = require('../models/IndustrialLocation');
const OfficialIncident = require('../models/OfficialIncident');
const OfficialPerimeter = require('../models/OfficialPerimeter');
const FireEvent = require('../models/FireEvent');
const { randomUUID } = require('crypto');
const { haversineKm, pointInPolygon } = require('./detectionFusion');
const { repairGeoJsonFeatures } = require('./geometryRepair');

const REFERENCE_CACHE_MS = 6 * 60 * 60 * 1000;
let referenceCache = null;

function normalizeIncidentId(value) {
  return String(value || '').replace(/[{}]/g, '').toLowerCase();
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateValue(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function geometryBbox(geometry) {
  const points = [];
  const visit = value => {
    if (Array.isArray(value) && value.length >= 2 &&
      Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      points.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
  };
  visit(geometry?.coordinates);
  if (!points.length) return null;
  return [
    Math.min(...points.map(point => point[0])),
    Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[0])),
    Math.max(...points.map(point => point[1]))
  ];
}

function gridKey(latitude, longitude, cellSize) {
  return `${Math.floor(latitude / cellSize)}:${Math.floor(longitude / cellSize)}`;
}

function buildPointGrid(items, cellSize) {
  const grid = new Map();
  items.forEach(item => {
    const [longitude, latitude] = item.location.coordinates;
    const key = gridKey(latitude, longitude, cellSize);
    const bucket = grid.get(key) || [];
    bucket.push(item);
    grid.set(key, bucket);
  });
  return grid;
}

function nearbyGridItems(grid, latitude, longitude, cellSize, cellRadius) {
  const items = [];
  const latitudeCell = Math.floor(latitude / cellSize);
  const longitudeCell = Math.floor(longitude / cellSize);
  for (let y = -cellRadius; y <= cellRadius; y += 1) {
    for (let x = -cellRadius; x <= cellRadius; x += 1) {
      items.push(...(grid.get(`${latitudeCell + y}:${longitudeCell + x}`) || []));
    }
  }
  return items;
}

function buildBoundaryGrid(boundaries) {
  const grid = new Map();
  boundaries.forEach(boundary => {
    const bbox = boundary.bbox?.length === 4 ? boundary.bbox : geometryBbox(boundary.geometry);
    if (!bbox) return;
    const [west, south, east, north] = bbox;
    for (let latitude = Math.floor(south); latitude <= Math.floor(north); latitude += 1) {
      for (let longitude = Math.floor(west); longitude <= Math.floor(east); longitude += 1) {
        const key = `${latitude}:${longitude}`;
        const bucket = grid.get(key) || [];
        bucket.push({ ...boundary, bbox });
        grid.set(key, bucket);
      }
    }
  });
  return grid;
}

function applySpatialContext(observations, industrialLocations, boundaries, contextVersion = null) {
  const activeIndustrial = industrialLocations.filter(item => item.active !== false && item.location);
  const industrialGrid = buildPointGrid(activeIndustrial, 0.05);
  const maxRadiusMeters = activeIndustrial.reduce(
    (maximum, item) => Math.max(maximum, Number(item.radiusMeters) || 100),
    100
  );
  const industrialCellRadius = Math.max(1, Math.ceil(maxRadiusMeters / 3500));
  const boundaryGrid = buildBoundaryGrid(boundaries);

  return observations.map(observation => {
    const industrialCandidates = nearbyGridItems(
      industrialGrid,
      observation.latitude,
      observation.longitude,
      0.05,
      industrialCellRadius
    );
    const industrialMatch = industrialCandidates
      .map(location => ({
        location,
        distanceMeters: haversineKm(observation, {
          latitude: location.location.coordinates[1],
          longitude: location.location.coordinates[0]
        }) * 1000
      }))
      .filter(candidate => candidate.distanceMeters <= (candidate.location.radiusMeters || 100))
      .sort((a, b) => a.distanceMeters - b.distanceMeters)[0];

    const boundaryCandidates = boundaryGrid.get(
      gridKey(observation.latitude, observation.longitude, 1)
    ) || [];
    const urbanMatch = boundaryCandidates.find(boundary => {
      const [west, south, east, north] = boundary.bbox;
      return observation.longitude >= west && observation.longitude <= east &&
        observation.latitude >= south && observation.latitude <= north &&
        pointInPolygon(observation, boundary.geometry);
    });

    return {
      ...observation,
      processing: {
        contextVersion,
        industrialBlacklistChecked: activeIndustrial.length > 0,
        industrialMatch: Boolean(industrialMatch),
        industrialSourceId: industrialMatch?.location.sourceId || null,
        excludedFromFusion: Boolean(industrialMatch),
        urbanBoundaryChecked: boundaries.length > 0,
        intersectsUrbanArea: Boolean(urbanMatch),
        urbanAreaId: urbanMatch?.sourceId || null,
        urbanAreaName: urbanMatch?.name || null
      }
    };
  });
}

async function loadSpatialReferences() {
  if (referenceCache && Date.now() - referenceCache.loadedAt < REFERENCE_CACHE_MS) {
    return referenceCache;
  }
  const [industrialLocations, boundaries] = await Promise.all([
    IndustrialLocation.find({ active: true }).lean(),
    CityBoundary.find({}).select('sourceId name geometry bbox').lean()
  ]);
  referenceCache = { industrialLocations, boundaries, loadedAt: Date.now() };
  return referenceCache;
}

async function enrichObservations(observations, contextVersion = null) {
  if (!observations.length) return [];
  const { industrialLocations, boundaries } = await loadSpatialReferences();
  return applySpatialContext(observations, industrialLocations, boundaries, contextVersion);
}

async function syncOfficialData(incidentFeatures, perimeterFeatures, options = {}) {
  const synchronizedAt = new Date();
  const result = { incidents: 0, perimeters: 0 };

  if (options.incidentsAvailable !== false) {
    const incidents = incidentFeatures.map(feature => {
      const properties = feature.properties || {};
      const coordinates = feature.geometry?.coordinates || [];
      const latitude = finiteNumber(properties.InitialLatitude ?? coordinates[1]);
      const longitude = finiteNumber(properties.InitialLongitude ?? coordinates[0]);
      const incidentId = normalizeIncidentId(
        properties.IrwinID || properties.UniqueFireIdentifier
      );
      if (!incidentId || latitude == null || longitude == null) return null;
      return {
        incidentId,
        uniqueFireIdentifier: properties.UniqueFireIdentifier || null,
        name: properties.IncidentName || 'Unnamed incident',
        source: 'NIFC_WFIGS',
        location: { type: 'Point', coordinates: [longitude, latitude] },
        latitude,
        longitude,
        discoveryAt: dateValue(properties.FireDiscoveryDateTime),
        modifiedAt: dateValue(properties.ModifiedOnDateTime_dt),
        sizeAcres: finiteNumber(properties.IncidentSize),
        percentContained: finiteNumber(properties.PercentContained),
        state: properties.POOState || null,
        synchronizedAt
      };
    }).filter(Boolean);
    if (incidents.length) {
      await OfficialIncident.bulkWrite(incidents.map(incident => ({
        updateOne: {
          filter: { incidentId: incident.incidentId },
          update: { $set: incident },
          upsert: true
        }
      })), { ordered: false });
    }
    await OfficialIncident.deleteMany({ synchronizedAt: { $ne: synchronizedAt } });
    result.incidents = incidents.length;
  }

  if (options.perimetersAvailable !== false) {
    const candidates = perimeterFeatures.map(feature => {
      const properties = feature.properties || {};
      const incidentId = normalizeIncidentId(properties.poly_IRWINID || properties.attr_IrwinID);
      const currentAt = dateValue(properties.poly_DateCurrent);
      if (!incidentId || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) return null;
      return {
        feature,
        sourceId: String(feature.id || properties.OBJECTID ||
          `${incidentId}:${currentAt?.toISOString() || 'current'}`),
        incidentId,
        currentAt,
        acres: finiteNumber(properties.poly_GISAcres ?? properties.attr_IncidentSize)
      };
    }).filter(Boolean);
    const existing = await OfficialPerimeter.find({
      sourceId: { $in: candidates.map(item => item.sourceId) }
    }).select('sourceId currentAt').lean();
    const existingById = new Map(existing.map(item => [item.sourceId, item]));
    const unchanged = candidates.filter(item => {
      const stored = existingById.get(item.sourceId);
      return item.currentAt && stored?.currentAt &&
        item.currentAt.getTime() === stored.currentAt.getTime();
    });
    const unchangedIds = new Set(unchanged.map(item => item.sourceId));
    const changed = candidates.filter(item => !unchangedIds.has(item.sourceId));

    // MongoDB's spherical validator is stricter than planar GeoJSON validity.
    // Repair only new/changed geometry; unchanged official perimeters stay cached.
    const repairedPerimeters = repairGeoJsonFeatures(changed.map(item => item.feature), {
      simplifyMeters: 0.1
    });
    const perimeters = repairedPerimeters.features.map(feature => {
      const properties = feature.properties || {};
      const incidentId = normalizeIncidentId(properties.poly_IRWINID || properties.attr_IrwinID);
      if (!incidentId || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) return null;
      const currentAt = dateValue(properties.poly_DateCurrent);
      return {
        sourceId: String(feature.id || properties.OBJECTID ||
          `${incidentId}:${currentAt?.toISOString() || 'current'}`),
        incidentId,
        source: 'NIFC_WFIGS',
        geometry: feature.geometry,
        acres: finiteNumber(properties.poly_GISAcres ?? properties.attr_IncidentSize),
        currentAt,
        synchronizedAt
      };
    }).filter(Boolean);
    const operations = perimeters.map(perimeter => ({
      updateOne: {
        filter: { sourceId: perimeter.sourceId },
        update: { $set: perimeter },
        upsert: true
      }
    })).concat(unchanged.map(perimeter => ({
      updateOne: {
        filter: { sourceId: perimeter.sourceId },
        update: { $set: {
          incidentId: perimeter.incidentId,
          acres: perimeter.acres,
          currentAt: perimeter.currentAt,
          synchronizedAt
        } }
      }
    })));
    if (operations.length) {
      await OfficialPerimeter.bulkWrite(operations, { ordered: false });
    }
    await OfficialPerimeter.deleteMany({ synchronizedAt: { $ne: synchronizedAt } });
    result.perimeters = operations.length;
  }

  return result;
}

async function persistFireEvents(events) {
  const synchronizedAt = new Date();
  const snapshotId = randomUUID();
  const documents = events.filter(event =>
    Number.isFinite(event.latitude) && Number.isFinite(event.longitude)
  ).map(event => ({
    snapshotId,
    eventId: event.eventId,
    status: event.status,
    location: { type: 'Point', coordinates: [event.longitude, event.latitude] },
    latitude: event.latitude,
    longitude: event.longitude,
    ...(Number.isFinite(event.representativeLatitude) && Number.isFinite(event.representativeLongitude)
      ? { representativeLocation: {
        type: 'Point',
        coordinates: [event.representativeLongitude, event.representativeLatitude]
      } }
      : {}),
    brightness: event.brightness,
    confidence: event.confidence == null ? null : String(event.confidence),
    lastObservedAt: dateValue(event.timestamp),
    firstObservedAt: dateValue(event.firstObservedAt),
    observationCount: event.observationCount,
    clusterGeometry: { type: 'MultiPoint', coordinates: event.cluster_coordinates || [] },
    sources: event.sources || [],
    incidentName: event.incidentName,
    officialIncidentId: event.officialIncidentId,
    incidentSizeAcres: finiteNumber(event.incidentSizeAcres),
    percentContained: finiteNumber(event.percentContained),
    hasOfficialPerimeter: Boolean(event.hasOfficialPerimeter),
    synchronizedAt
  }));

  if (documents.length) await FireEvent.insertMany(documents, { ordered: false });
  return { count: documents.length, snapshotId, synchronizedAt };
}

module.exports = {
  applySpatialContext,
  enrichObservations,
  geometryBbox,
  persistFireEvents,
  syncOfficialData
};
