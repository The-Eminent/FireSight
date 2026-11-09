const mongoose = require('mongoose');
const { polygonField } = require('./geoJson');

const CityBoundarySchema = new mongoose.Schema({
  sourceId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  source: { type: String, required: true, default: 'US_CENSUS_TIGERWEB' },
  geometry: polygonField(),
  bbox: {
    type: [Number],
    required: true,
    validate: value => Array.isArray(value) && value.length === 4
  },
  synchronizedAt: { type: Date, required: true }
});

CityBoundarySchema.index({ geometry: '2dsphere' }, { name: 'geometry_2dsphere' });

module.exports = mongoose.model('CityBoundary', CityBoundarySchema);
