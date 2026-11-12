const path = require('path');
const { spawn } = require('child_process');

function clustersFromLabels(observations, labels) {
  const groups = new Map();
  observations.forEach((observation, index) => {
    const label = labels[index];
    if (!Number.isInteger(label) || label < 0) return;
    const group = groups.get(label) || [];
    group.push(observation);
    groups.set(label, group);
  });
  return [...groups.values()];
}

function clusterUnmatchedObservations(observations) {
  if (!observations.length) return Promise.resolve({ clusters: [], noiseCount: 0 });
  const script = path.join(__dirname, '..', 'ml', 'cluster_unmatched.py');
  const python = process.env.PYTHON_COMMAND || 'python3';
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `DBSCAN exited with ${code}`));
      try {
        const { labels } = JSON.parse(stdout);
        if (!Array.isArray(labels) || labels.length !== observations.length) {
          throw new Error('DBSCAN returned an invalid label count');
        }
        resolve({
          clusters: clustersFromLabels(observations, labels),
          noiseCount: labels.filter(label => label === -1).length
        });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({
      coordinates: observations.map(item => [item.longitude, item.latitude])
    }));
  });
}

module.exports = { clustersFromLabels, clusterUnmatchedObservations };
