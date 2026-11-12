const path = require('path');
const { spawn } = require('child_process');

let activeChild = null;
let activeRefresh = null;

function runWildfireRefresh() {
  if (activeRefresh) return activeRefresh;
  const script = path.join(__dirname, '..', 'scripts', 'refreshWildfires.js');
  activeRefresh = new Promise((resolve, reject) => {
    activeChild = spawn(process.execPath, [script], {
      env: process.env,
      stdio: 'inherit'
    });
    activeChild.once('error', reject);
    activeChild.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Wildfire refresh worker stopped (${signal || `exit ${code}`})`));
    });
  }).finally(() => {
    activeChild = null;
    activeRefresh = null;
  });
  return activeRefresh;
}

function startWildfireScheduler() {
  if (process.env.WILDFIRE_REFRESH_ENABLED === 'false') return null;
  const minutes = Math.max(1, Number(process.env.WILDFIRE_REFRESH_INTERVAL_MINUTES) || 15);
  if (process.env.WILDFIRE_REFRESH_ON_START !== 'false') {
    setImmediate(() => runWildfireRefresh().catch(error => console.error(error.message)));
  }
  const timer = setInterval(() => {
    runWildfireRefresh().catch(error => console.error(error.message));
  }, minutes * 60 * 1000);
  timer.unref();
  console.log(`🕒 Wildfire refresh worker scheduled every ${minutes} minutes`);
  return {
    stop() {
      clearInterval(timer);
      if (activeChild && !activeChild.killed) activeChild.kill('SIGTERM');
    }
  };
}

module.exports = { runWildfireRefresh, startWildfireScheduler };
