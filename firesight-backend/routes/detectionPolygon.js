const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const OfficialPerimeter = require('../models/OfficialPerimeter');

const router = express.Router();
const PYTHON = process.env.PYTHON_COMMAND || 'python3';
const SCRIPT_PATH = path.join(__dirname, '../ml/detection_polygon.py');
const ML_DIRECTORY = path.join(__dirname, '../ml');
const TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

function officialPerimeterFeature(perimeter) {
  return {
    type: 'Feature',
    properties: {
      source: 'wfigs',
      incidentId: perimeter.incidentId,
      currentAt: perimeter.currentAt
    },
    geometry: perimeter.geometry
  };
}

router.post('/', async (req, res) => {
  const fireEventCluster = req.body?.fire_event_cluster;
  const officialIncidentId = typeof req.body?.official_incident_id === 'string'
    ? req.body.official_incident_id.trim()
    : '';
  const hasCluster = Array.isArray(fireEventCluster) && fireEventCluster.length > 0;
  if (!officialIncidentId && !hasCluster) {
    return res.status(400).json({
      error: 'official_incident_id or a non-empty fire_event_cluster is required'
    });
  }

  if (officialIncidentId) {
    try {
      const perimeter = await OfficialPerimeter.findOne({ incidentId: officialIncidentId })
        .sort({ currentAt: -1 })
        .lean();
      if (perimeter?.geometry) return res.json(officialPerimeterFeature(perimeter));
    } catch (error) {
      console.error('Official perimeter lookup failed:', error.message);
      return res.status(500).json({ error: 'Unable to read the official perimeter' });
    }
  }

  if (!hasCluster) {
    return res.status(404).json({ error: 'No saved official perimeter was found for this incident' });
  }

  const child = spawn(PYTHON, [SCRIPT_PATH], {
    cwd: ML_DIRECTORY,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  let finished = false;
  let outputTooLarge = false;

  const finish = (status, payload) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    res.status(status).json(payload);
  };
  const timeout = setTimeout(() => {
    child.kill('SIGKILL');
    finish(504, { error: 'Detection polygon generation timed out' });
  }, TIMEOUT_MS);

  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
      outputTooLarge = true;
      child.kill('SIGKILL');
    }
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', error => {
    console.error('Detection polygon process failed:', error.message);
    finish(500, { error: 'Unable to start detection polygon service' });
  });
  child.on('close', code => {
    if (finished) return;
    if (outputTooLarge) {
      return finish(502, { error: 'Detection polygon output exceeded the safety limit' });
    }
    if (code !== 0) {
      console.error('Detection polygon script failed:', stderr.trim());
      return finish(code === 2 ? 400 : 502, { error: 'Detection polygon generation failed' });
    }
    try {
      finish(200, JSON.parse(stdout));
    } catch (error) {
      console.error('Detection polygon returned invalid JSON:', error.message);
      finish(502, { error: 'Detection polygon service returned invalid output' });
    }
  });

  child.stdin.end(JSON.stringify({ fire_event_cluster: fireEventCluster }));
});

module.exports = router;
module.exports.officialPerimeterFeature = officialPerimeterFeature;
