const mongoose = require('mongoose');
const { pointField } = require('./geoJson');

const IndustrialLocationSchema = new mongoose.Schema({
  sourceId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  category: { type: String, required: true, default: 'persistent_heat_source' },
  source: { type: String, required: true },
  location: pointField(),
  radiusMeters: { type: Number, required: true, default: 100, min: 1 },
  active: { type: Boolean, default: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  synchronizedAt: { type: Date, required: true }
});

IndustrialLocationSchema.index({ location: '2dsphere' }, { name: 'location_2dsphere' });

module.exports = mongoose.model('IndustrialLocation', IndustrialLocationSchema);
