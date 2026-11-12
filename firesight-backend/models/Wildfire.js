const mongoose = require('mongoose');
const { pointField } = require('./geoJson');

const WildfireSchema = new mongoose.Schema({
  detectionId: { type: String, required: true },
  source: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  location: pointField(),
  brightness: { type: Number, required: true },
  confidence: { type: String, required: true }, // Accepts both numeric & text values
  satellite: { type: String, required: true },
  instrument: { type: String, required: true },
  frp: Number,
  daynight: String,
  timestamp: { type: Date, default: Date.now },
  acquiredAt: { type: Date, required: true },
  processing: {
    contextVersion: { type: String, default: null },
    industrialBlacklistChecked: { type: Boolean, default: false },
    industrialMatch: { type: Boolean, default: false },
    industrialSourceId: { type: String, default: null },
    excludedFromFusion: { type: Boolean, default: false },
    urbanBoundaryChecked: { type: Boolean, default: false },
    intersectsUrbanArea: { type: Boolean, default: false },
    urbanAreaId: { type: String, default: null },
    urbanAreaName: { type: String, default: null }
  },
  processedForMl: { type: Boolean, default: false }
});

// Ignore legacy rows without detectionId while preventing new duplicates.
WildfireSchema.index(
  { detectionId: 1 },
  { unique: true, partialFilterExpression: { detectionId: { $type: 'string' } } }
);
WildfireSchema.index({ location: '2dsphere' }, { name: 'location_2dsphere' });
WildfireSchema.index({ acquiredAt: -1 }, { name: 'acquiredAt_desc' });

module.exports = mongoose.model('Wildfire', WildfireSchema);
