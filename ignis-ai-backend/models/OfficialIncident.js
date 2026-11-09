const mongoose = require('mongoose');
const { pointField } = require('./geoJson');

const OfficialIncidentSchema = new mongoose.Schema({
  incidentId: { type: String, required: true, unique: true },
  uniqueFireIdentifier: { type: String, default: null },
  name: { type: String, required: true },
  source: { type: String, required: true, default: 'NIFC_WFIGS' },
  location: pointField(),
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  discoveryAt: { type: Date, default: null },
  modifiedAt: { type: Date, default: null },
  sizeAcres: { type: Number, default: null },
  percentContained: { type: Number, default: null },
  state: { type: String, default: null },
  synchronizedAt: { type: Date, required: true }
});

OfficialIncidentSchema.index({ location: '2dsphere' }, { name: 'location_2dsphere' });

module.exports = mongoose.model('OfficialIncident', OfficialIncidentSchema);
