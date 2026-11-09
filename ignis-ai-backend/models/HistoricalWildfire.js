const mongoose = require('mongoose');

const HistoricalWildfireSchema = new mongoose.Schema({
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  fireSize: { type: Number, required: true }, // Acres burned
  cause: { type: String, required: false }, // Human, Lightning, Unknown
  duration: { type: Number, required: false }, // Days
  year: { type: Number, required: true }
});

module.exports = mongoose.model('HistoricalWildfire', HistoricalWildfireSchema);