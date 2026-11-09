const mongoose = require('mongoose');

const HumanFactorsSchema = new mongoose.Schema({
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  populationDensity: { type: Number, required: false }, // People per km²
  roadProximity: { type: Number, required: false }, // Distance in meters
  fireStationsNearby: { type: Number, required: false }, // Count of fire stations
  urbanizationIndex: { type: Number, required: false }, // 0-1 scale
});

module.exports = mongoose.model('HumanFactors', HumanFactorsSchema);