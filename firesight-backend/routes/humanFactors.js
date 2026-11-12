const express = require('express');
const router = express.Router();
const axios = require('axios');
require('dotenv').config();

// Define the Human Factors API endpoint (example placeholder)
const HUMAN_FACTORS_API = process.env.HUMAN_FACTORS_API;

router.get('/human-factors', async (req, res) => {
  try {
    const response = await axios.get(HUMAN_FACTORS_API);

    if (!response.data) {
      return res.status(500).json({ error: 'No human factors data received' });
    }

    res.json({
      message: 'Human factors data fetched successfully',
      data: response.data
    });

  } catch (error) {
    console.error('❌ Error fetching human factors data:', error.message);
    res.status(500).json({ error: 'Failed to fetch human factors data', details: error.message });
  }
});

module.exports = router;