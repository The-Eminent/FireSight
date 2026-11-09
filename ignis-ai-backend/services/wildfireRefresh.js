const axios = require('axios');
const Wildfire = require('../models/Wildfire');
const FireEvent = require('../models/FireEvent');
const DetectionSnapshot = require('../models/DetectionSnapshot');
const { fuseDetections } = require('./detectionFusion');
const { clusterUnmatchedObservations } = require('./densityClustering');
const { matchObservationsToWfigs } = require('./wfigsMatching');
const {
  enrichObservations,
  persistFireEvents,
  syncOfficialData
} = require('./spatialData');

const FIRMS_SOURCES = [
  'VIIRS_NOAA21_NRT',
  'VIIRS_NOAA20_NRT'
];
const NOAA_SATELLITES = new Set(['N20', 'N21', 'NOAA-20', 'NOAA-21']);
const FIRMS_AREA = '-125.0,24.0,-66.0,49.0';
const FIRMS_DAY_RANGE = '2';
const SPATIAL_CONTEXT_VERSION = 'spatial-context-v2-industrial';
const WFIGS_LAYERS = {
  incidents: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query',
  perimeters: 'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query'
};

function parseCSV(csvText, source) {
  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(value => value.trim());
  const column = name => headers.indexOf(name);
  const brightnessColumn = column('bright_ti4') >= 0
    ? column('bright_ti4')
    : column('brightness');

  return lines.slice(1).map(line => {
    const cols = line.split(',').map(value => value.trim());
    const get = name => cols[column(name)];
    const lat = get('latitude');
    const lon = get('longitude');
    const acqDate = get('acq_date');
    const acqTime = get('acq_time');
    const satellite = get('satellite');
    const instrument = get('instrument');
    if (!lat || !lon || !acqDate || !acqTime || brightnessColumn < 0) return null;
    const hhmm = acqTime.padStart(4, '0');
    const timestamp = new Date(`${acqDate}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00Z`);
    const latitude = Number(lat);
    const longitude = Number(lon);
    return {
      detectionId: [source, satellite, instrument, acqDate, hhmm, lat, lon].join(':'),
      source,
      latitude,
      longitude,
      location: { type: 'Point', coordinates: [longitude, latitude] },
      brightness: Number(cols[brightnessColumn]),
      confidence: get('confidence'),
      satellite,
      instrument,
      frp: Number(get('frp')),
      daynight: get('daynight'),
      timestamp,
      acquiredAt: timestamp,
      processedForMl: false
    };
  }).filter(fire => fire && Number.isFinite(fire.latitude) &&
    Number.isFinite(fire.longitude) && Number.isFinite(fire.brightness) &&
    fire.confidence && fire.satellite && fire.instrument &&
    Number.isFinite(fire.timestamp.getTime()));
}

function deduplicateObservations(observations) {
  return [...new Map(observations.map(fire => [fire.detectionId, fire])).values()];
}

function sortObservationsChronologically(observations) {
  return [...observations].sort((first, second) =>
    new Date(first.acquiredAt ?? first.timestamp) - new Date(second.acquiredAt ?? second.timestamp));
}

function isAllowedNoaaObservation(observation) {
  return FIRMS_SOURCES.includes(observation.source) &&
    NOAA_SATELLITES.has(String(observation.satellite).toUpperCase());
}

function partitionSpatialContext(observations, storedObservations) {
  const storedById = new Map(storedObservations.map(item => [item.detectionId, item]));
  const reusable = new Map();
  const needingContext = [];
  observations.forEach(observation => {
    const stored = storedById.get(observation.detectionId);
    if (stored?.processing?.contextVersion === SPATIAL_CONTEXT_VERSION) {
      reusable.set(observation.detectionId, stored.processing);
    } else {
      needingContext.push(observation);
    }
  });
  return { reusable, needingContext };
}

async function fetchWfigsLayer(url, where, outFields) {
  const { data } = await axios.get(url, {
    params: {
      where,
      outFields: outFields.join(','),
      returnGeometry: true,
      outSR: 4326,
      f: 'geojson'
    },
    timeout: 120000,
    headers: { 'User-Agent': 'ignis-ai' }
  });
  return data.features || [];
}

async function fetchFirms() {
  const results = await Promise.allSettled(FIRMS_SOURCES.map(async source => {
    const url = [
      'https://firms.modaps.eosdis.nasa.gov/api/area/csv',
      process.env.NASA_API_KEY,
      source,
      FIRMS_AREA,
      FIRMS_DAY_RANGE
    ].join('/');
    const { data } = await axios.get(url, {
      timeout: 120000,
      headers: { 'User-Agent': 'ignis-ai' },
      responseType: 'text'
    });
    return { source, fires: parseCSV(data, source).filter(isAllowedNoaaObservation) };
  }));
  const successful = results.filter(result => result.status === 'fulfilled')
    .map(result => result.value);
  return {
    observations: sortObservationsChronologically(
      deduplicateObservations(successful.flatMap(item => item.fires))
    ),
    sourceCounts: Object.fromEntries(successful.map(item => [item.source, item.fires.length])),
    failedSources: results.map((result, index) =>
      result.status === 'rejected' ? FIRMS_SOURCES[index] : null).filter(Boolean)
  };
}

async function refreshWildfireData() {
  const startedAt = Date.now();
  try {
    const firms = await fetchFirms();
    if (!firms.observations.length) throw new Error('No valid FIRMS observations available');

    const stored = await Wildfire.find({
      detectionId: { $in: firms.observations.map(item => item.detectionId) }
    }).select('detectionId processing').lean();
    const { reusable, needingContext } = partitionSpatialContext(firms.observations, stored);
    const enriched = await enrichObservations(needingContext, SPATIAL_CONTEXT_VERSION);
    const enrichedById = new Map(enriched.map(item => [item.detectionId, item]));
    const fires = firms.observations.map(observation => enrichedById.get(observation.detectionId) || {
      ...observation,
      processing: reusable.get(observation.detectionId)
    });
    const eligibleFires = fires.filter(fire => !fire.processing.excludedFromFusion);

    let writeResult = { upsertedCount: 0, modifiedCount: 0, matchedCount: 0 };
    if (enriched.length) {
      writeResult = await Wildfire.bulkWrite(enriched.map(fire => ({
        updateOne: {
          filter: { detectionId: fire.detectionId },
          update: { $set: fire },
          upsert: true
        }
      })), { ordered: false });
    }

    const wfigsResults = await Promise.allSettled([
      fetchWfigsLayer(WFIGS_LAYERS.incidents,
        "IncidentTypeCategory='WF' AND FireOutDateTime IS NULL",
        ['IrwinID', 'UniqueFireIdentifier', 'IncidentName', 'InitialLatitude',
          'InitialLongitude', 'FireDiscoveryDateTime', 'ModifiedOnDateTime_dt',
          'IncidentSize', 'PercentContained', 'POOState']),
      fetchWfigsLayer(WFIGS_LAYERS.perimeters, "attr_IncidentTypeCategory='WF'",
        ['poly_IRWINID', 'attr_IrwinID', 'poly_GISAcres', 'attr_IncidentSize',
          'poly_DateCurrent'])
    ]);
    const incidentsAvailable = wfigsResults[0].status === 'fulfilled';
    const perimetersAvailable = wfigsResults[1].status === 'fulfilled';
    const incidentFeatures = incidentsAvailable ? wfigsResults[0].value : [];
    const perimeterFeatures = perimetersAvailable ? wfigsResults[1].value : [];
    const failedWfigsLayers = ['incidents', 'perimeters'].filter((name, index) =>
      wfigsResults[index].status === 'rejected');
    const officialDatabase = await syncOfficialData(incidentFeatures, perimeterFeatures, {
      incidentsAvailable,
      perimetersAvailable
    });
    const incidentMatches = await matchObservationsToWfigs(eligibleFires, incidentFeatures);
    const unmatched = eligibleFires.filter(fire => !incidentMatches.has(fire.detectionId));
    const density = await clusterUnmatchedObservations(unmatched);
    const { events, metrics } = fuseDetections(
      eligibleFires,
      incidentFeatures,
      perimeterFeatures,
      {
        incidentMatches,
        unmatchedClusters: density.clusters,
        ignoredNoiseObservationCount: density.noiseCount
      }
    );
    const storedEvents = await persistFireEvents(events);
    const refreshedAt = new Date();
    const snapshot = {
      status: 'ready',
      refreshedAt,
      durationMs: Date.now() - startedAt,
      eventSnapshotId: storedEvents.snapshotId,
      eventSynchronizedAt: storedEvents.synchronizedAt,
      eventCount: storedEvents.count,
      observationCount: eligibleFires.length,
      fetchedObservationCount: fires.length,
      sourceCounts: firms.sourceCounts,
      failedSources: firms.failedSources,
      wfigs: {
        incidentCount: incidentFeatures.length,
        perimeterCount: perimeterFeatures.length,
        failedLayers: failedWfigsLayers
      },
      metrics,
      spatialContext: {
        newlyClassified: enriched.length,
        reusedClassification: reusable.size,
        industrialBlacklistExcluded: fires.length - eligibleFires.length,
        urbanObservationCount: fires.filter(fire => fire.processing.intersectsUrbanArea).length
      },
      database: {
        inserted: writeResult.upsertedCount,
        updated: writeResult.modifiedCount,
        matched: writeResult.matchedCount,
        officialIncidents: officialDatabase.incidents,
        officialPerimeters: officialDatabase.perimeters,
        fireEvents: storedEvents.count
      },
      error: null
    };
    await DetectionSnapshot.findByIdAndUpdate('current', { $set: snapshot }, { upsert: true });
    await FireEvent.deleteMany({ snapshotId: { $ne: storedEvents.snapshotId } });
    console.log(`🔥 Background refresh completed: ${events.length} events in ${snapshot.durationMs} ms`);
    return snapshot;
  } catch (error) {
    console.error(`❌ Background wildfire refresh failed: ${error.message}`);
    throw error;
  }
}

module.exports = {
  deduplicateObservations,
  FIRMS_SOURCES,
  isAllowedNoaaObservation,
  parseCSV,
  partitionSpatialContext,
  refreshWildfireData,
  sortObservationsChronologically,
  SPATIAL_CONTEXT_VERSION
};
