const axios = require('axios');
const express = require('express');

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8000';

function isBoundaryFeature(value) {
  return value?.type === 'Feature'
    && ['Polygon', 'MultiPolygon'].includes(value?.geometry?.type)
    && Array.isArray(value.geometry.coordinates);
}

function createPredictionHandler({ client, serviceUrl }) {
  const predictUrl = `${serviceUrl.replace(/\/+$/, '')}/predict`;
  return async (req, res) => {
    if (!isBoundaryFeature(req.body)) {
      return res.status(400).json({
        error: 'Prediction requires an EPSG:4326 GeoJSON Polygon or MultiPolygon Feature'
      });
    }

    try {
      const response = await client.post(predictUrl, req.body, { timeout: 20_000 });
      return res.json(response.data);
    } catch (error) {
      const upstreamStatus = error.response?.status;
      if (upstreamStatus === 422) {
        return res.status(422).json({
          error: error.response?.data?.detail || 'Prediction boundary was rejected'
        });
      }
      console.error('Prediction service request failed:', error.message);
      return res.status(502).json({ error: 'Prediction service is unavailable' });
    }
  };
}

function createRouter({
  client = axios,
  serviceUrl = process.env.PREDICTION_SERVICE_URL || DEFAULT_SERVICE_URL
} = {}) {
  const router = express.Router();
  router.post('/', createPredictionHandler({ client, serviceUrl }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.createPredictionHandler = createPredictionHandler;
module.exports.isBoundaryFeature = isBoundaryFeature;
