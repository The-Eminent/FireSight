const path = require('path');
const { spawnSync } = require('child_process');

function repairGeoJsonFeatures(features, options = {}) {
  if (!features.length) return { features: [], skipped: 0 };
  const python = process.env.PYTHON_COMMAND || path.join(__dirname, '..', 'ml', 'venv', 'bin', 'python');
  const script = path.join(__dirname, '..', 'scripts', 'repairGeoJson.py');
  const result = spawnSync(python, [script], {
    input: JSON.stringify({
      features,
      simplify_meters: Number(options.simplifyMeters) || 0
    }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Geometry repair failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
  return JSON.parse(result.stdout);
}

module.exports = { repairGeoJsonFeatures };
