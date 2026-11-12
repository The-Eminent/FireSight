// /routes/topography.js
const express = require('express');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas'); // Used to process PNG
const Topography = require('../models/Topography'); // MongoDB Model
require('dotenv').config();

const router = express.Router();
const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN; // Backend API Token

router.get('/', async (req, res) => {
  try {
    const latitude = parseFloat(req.query.lat) || 34.0522;
    const longitude = parseFloat(req.query.lon) || -118.2437;

    const zoom = 14;
    const x = Math.floor((longitude + 180) / 360 * Math.pow(2, zoom));
    const y = Math.floor((1 - Math.log(Math.tan(latitude * Math.PI / 180) + 1 / Math.cos(latitude * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom));

    const tileURL = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${zoom}/${x}/${y}.pngraw?access_token=${MAPBOX_TOKEN}`;
    const image = await loadImage(tileURL);

    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const imgData = ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data;
    console.log("🖼️ RGB Values:", imgData);
    const elevation = ((imgData[0] * 256 * 256) + (imgData[1] * 256) + imgData[2]) * 0.1 - 10000;
    console.log(`📏 Elevation Calculated: ${elevation} meters`);
    const topoData = new Topography({
      latitude,
      longitude,
      elevation,
      slope: Math.random() * 45,
      vegetationType: "Unknown"
    });

    await topoData.save();
    console.log("🌄 Topography data saved.");

    res.json({
      message: "Topography data stored",
      data: topoData
    });

  } catch (error) {
    console.error('❌ Error fetching topography data:', error.message);
    res.status(500).json({ error: "Failed to fetch topography data", details: error.message });
  }
});

module.exports = router;