const mongoose = require('mongoose');
const { pointField } = require('./geoJson');

const FireEventSchema = new mongoose.Schema({
  snapshotId: { type: String, required: true },
  eventId: { type: String, required: true },
  status: { type: String, required: true },
  location: pointField(),
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  representativeLocation: pointField(false),
  brightness: { type: Number, default: null },
  confidence: { type: String, default: null },
  lastObservedAt: { type: Date, default: null },
  firstObservedAt: { type: Date, default: null },
  observationCount: { type: Number, required: true },
  clusterGeometry: {
    type: { type: String, enum: ['MultiPoint'], default: 'MultiPoint' },
    coordinates: { type: [[Number]], default: [] }
  },
  sources: { type: [String], default: [] },
  incidentName: { type: String, default: null },
  officialIncidentId: { type: String, default: null },
  incidentSizeAcres: { type: Number, default: null },
  percentContained: { type: Number, default: null },
  hasOfficialPerimeter: { type: Boolean, default: false },
  synchronizedAt: { type: Date, required: true }
});

FireEventSchema.index({ location: '2dsphere' }, { name: 'location_2dsphere' });
FireEventSchema.index({ status: 1, lastObservedAt: -1 }, { name: 'status_lastObservedAt' });
FireEventSchema.index(
  { snapshotId: 1, eventId: 1 },
  { unique: true, name: 'snapshot_event_unique' }
);

module.exports = mongoose.model('FireEvent', FireEventSchema);
