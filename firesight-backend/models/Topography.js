const mongoose = require('mongoose');

const TopographySchema = new mongoose.Schema({
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  elevation: { type: Number, required: true },  // Meters
  slope: { type: Number, required: true },      // Degrees
  vegetationType: { type: String, required: false }, // Forest, Grassland, Urban, etc.
});

module.exports = mongoose.model('Topography', TopographySchema);