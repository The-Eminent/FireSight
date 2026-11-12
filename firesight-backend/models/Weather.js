const mongoose = require('mongoose');

const WeatherSchema = new mongoose.Schema({
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  temperature: { type: Number, required: true },  // Celsius
  humidity: { type: Number, required: false, default: null },     // Percentage
  windSpeed: { type: Number, required: false, default: null },    // m/s
  precipitation: { type: Number, required: false, default: 0}, // mm
  forecast: { type: String, required: false, default: "No forecast available" }, // ✅ Default if missing
  //fireRiskIndex: { type: Number, required: false }, // Custom calculated risk
  timestamp: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Weather', WeatherSchema);