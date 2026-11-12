const mongoose = require('mongoose');
const connectDB = require('../db');
const { refreshWildfireData } = require('../services/wildfireRefresh');
require('dotenv').config();

async function main() {
  await connectDB();
  const snapshot = await refreshWildfireData();
  console.log('=== Wildfire refresh report ===');
  console.log(`Events: ${snapshot.eventCount}`);
  console.log(`Observations: ${snapshot.observationCount}`);
  console.log(`Duration: ${snapshot.durationMs} ms`);
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(`Wildfire refresh failed: ${error.message}`);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
