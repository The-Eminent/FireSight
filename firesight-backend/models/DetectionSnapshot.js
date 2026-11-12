const mongoose = require('mongoose');

const DetectionSnapshotSchema = new mongoose.Schema({
  _id: { type: String, default: 'current' },
  status: { type: String, enum: ['ready', 'failed'], required: true },
  refreshedAt: { type: Date, required: true },
  durationMs: { type: Number, required: true },
  eventSnapshotId: { type: String, default: null },
  eventSynchronizedAt: { type: Date, default: null },
  eventCount: { type: Number, default: 0 },
  observationCount: { type: Number, default: 0 },
  fetchedObservationCount: { type: Number, default: 0 },
  sourceCounts: { type: mongoose.Schema.Types.Mixed, default: {} },
  failedSources: { type: [String], default: [] },
  wfigs: { type: mongoose.Schema.Types.Mixed, default: {} },
  metrics: { type: mongoose.Schema.Types.Mixed, default: {} },
  spatialContext: { type: mongoose.Schema.Types.Mixed, default: {} },
  database: { type: mongoose.Schema.Types.Mixed, default: {} },
  error: { type: String, default: null }
}, { versionKey: false });

module.exports = mongoose.model('DetectionSnapshot', DetectionSnapshotSchema);
