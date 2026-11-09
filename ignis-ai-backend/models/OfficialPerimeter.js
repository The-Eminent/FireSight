const mongoose = require('mongoose');
const { polygonField } = require('./geoJson');

const OfficialPerimeterSchema = new mongoose.Schema({
  sourceId: { type: String, required: true, unique: true },
  incidentId: { type: String, required: true, index: true },
  source: { type: String, required: true, default: 'NIFC_WFIGS' },
  geometry: polygonField(),
  acres: { type: Number, default: null },
  currentAt: { type: Date, default: null },
  synchronizedAt: { type: Date, required: true }
});

OfficialPerimeterSchema.index({ geometry: '2dsphere' }, { name: 'geometry_2dsphere' });

module.exports = mongoose.model('OfficialPerimeter', OfficialPerimeterSchema);
