const express = require('express');
const router = express.Router();
const axios = require('axios');
const Weather = require('../models/Weather'); // Import Weather Model
require('dotenv').config();

// **Fetch NOAA Weather Data**
router.get('/', async (req, res) => {  // ✅ Use `/` because app.js already maps it to `/api/weather`
  try {
    const latitude = 34.0522; // Change to user input later
    const longitude = -118.2437;

    // Step 1: Get NOAA Grid ID & Coordinates
    const gridResponse = await axios.get(`https://api.weather.gov/points/${latitude},${longitude}`, {
      headers: { 'User-Agent': 'ignis-ai (chrisjuarez1596@gmail.com)' }
    });

    if (!gridResponse.data || !gridResponse.data.properties) {
      console.error("❌ Failed to fetch NOAA grid data.");
      return res.status(500).json({ error: "NOAA grid data unavailable." });
    }

    const { gridId, gridX, gridY } = gridResponse.data.properties;

    // Step 2: Fetch Weather Forecast using Grid ID
    const forecastURL = `https://api.weather.gov/gridpoints/${gridId}/${gridX},${gridY}/forecast`;
    console.log(`Fetching NOAA forecast from: ${forecastURL}`);

    const forecastResponse = await axios.get(forecastURL, {
      headers: { 'User-Agent': 'ignis-ai (chrisjuarez1596@gmail.com)' }
    });

    if (!forecastResponse.data || !forecastResponse.data.properties) {
      console.error("❌ No forecast data received from NOAA.");
      return res.status(500).json({ error: "No forecast data available." });
    }

    // Step 3: Extract Weather Data
    const weatherData = forecastResponse.data.properties.periods.map(period => ({
      latitude,
      longitude,
      temperature: period.temperature,
      humidity: period.relativeHumidity?.value || null,
      windSpeed: period.windSpeed.split(" ")[0], // Extract numeric part
      precipitation: period.probabilityOfPrecipitation?.value || 0,
      forecast: period.shortForecast,
      timestamp: new Date(period.startTime)
    }));

    // Step 4: Store Weather Data in MongoDB
    await Weather.insertMany(weatherData);
    console.log("🌤 NOAA Weather data saved to MongoDB.");

    res.json({
      message: "NOAA Weather data stored successfully",
      count: weatherData.length,
      data: weatherData
    });

  } catch (error) {
    console.error('❌ Error fetching NOAA weather data:', error.message);
    res.status(500).json({ error: "Failed to fetch weather data", details: error.message });
  }
});

module.exports = router;