const express = require('express');
const FireEvent = require('../models/FireEvent');
const DetectionSnapshot = require('../models/DetectionSnapshot');
const { runWildfireRefresh } = require('../services/wildfireScheduler');
const { parseCSV, deduplicateObservations } = require('../services/wildfireRefresh');

const router = express.Router();
const REFRESH_LOCK_MS = 20 * 60 * 1000;

function isRefreshLocked(refreshedAt, now = Date.now()) {
  return Boolean(refreshedAt) && now - new Date(refreshedAt).getTime() < REFRESH_LOCK_MS;
}

function toApiEvent(event) {
  return {
    eventId: event.eventId,
    status: event.status,
    latitude: event.latitude,
    longitude: event.longitude,
    representativeLatitude: event.representativeLocation?.coordinates?.[1] ?? null,
    representativeLongitude: event.representativeLocation?.coordinates?.[0] ?? null,
    brightness: event.brightness,
    confidence: event.confidence,
    timestamp: event.lastObservedAt,
    firstObservedAt: event.firstObservedAt,
    observationCount: event.observationCount,
    cluster_coordinates: event.clusterGeometry?.coordinates || [],
    sources: event.sources || [],
    incidentName: event.incidentName,
    officialIncidentId: event.officialIncidentId,
    incidentSizeAcres: event.incidentSizeAcres,
    percentContained: event.percentContained,
    hasOfficialPerimeter: event.hasOfficialPerimeter
  };
}

router.get('/wildfires', async (req, res) => {
  try {
    const snapshot = await DetectionSnapshot.findById('current').lean();
    if (!snapshot?.eventSnapshotId) {
      return res.status(503).json({
        error: 'Wildfire data is initializing',
        message: 'No completed detection snapshot is available yet',
        data: []
      });
    }
    const events = await FireEvent.find({ snapshotId: snapshot.eventSnapshotId }).lean();
    res.json({
      message: 'Latest completed wildfire detection snapshot',
      count: events.length,
      observationCount: snapshot.observationCount,
      fetchedObservationCount: snapshot.fetchedObservationCount,
      refreshedAt: snapshot.refreshedAt,
      refreshDurationMs: snapshot.durationMs,
      sourceCounts: snapshot.sourceCounts,
      failedSources: snapshot.failedSources,
      wfigs: snapshot.wfigs,
      metrics: snapshot.metrics,
      spatialContext: snapshot.spatialContext,
      database: snapshot.database,
      data: events.map(toApiEvent)
    });
  } catch (error) {
    console.error(`❌ Error reading wildfire snapshot: ${error.message}`);
    res.status(500).json({ error: 'Unable to read wildfire data' });
  }
});

router.post('/wildfires/refresh', async (req, res) => {
  try {
    const snapshot = await DetectionSnapshot.findById('current').select('refreshedAt').lean();
    if (isRefreshLocked(snapshot?.refreshedAt)) {
      return res.json({ refreshStarted: false, reason: 'time_lock', refreshedAt: snapshot.refreshedAt });
    }
    runWildfireRefresh().catch(error => console.error(error.message));
    res.status(202).json({ refreshStarted: true, refreshedAt: snapshot?.refreshedAt || null });
  } catch (error) {
    console.error(`❌ Error requesting wildfire refresh: ${error.message}`);
    res.status(500).json({ error: 'Unable to request wildfire refresh' });
  }
});

module.exports = router;
module.exports.toApiEvent = toApiEvent;
module.exports.isRefreshLocked = isRefreshLocked;
module.exports.parseCSV = parseCSV;
module.exports.deduplicateObservations = deduplicateObservations;
