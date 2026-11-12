const mongoose = require('mongoose');
const connectDB = require('../db');
const Wildfire = require('../models/Wildfire');
const CityBoundary = require('../models/CityBoundary');
const IndustrialLocation = require('../models/IndustrialLocation');
const OfficialIncident = require('../models/OfficialIncident');
const OfficialPerimeter = require('../models/OfficialPerimeter');
const FireEvent = require('../models/FireEvent');
const DetectionSnapshot = require('../models/DetectionSnapshot');

async function main() {
  await connectDB();
  const validCoordinates = {
    latitude: { $gte: -90, $lte: 90 },
    longitude: { $gte: -180, $lte: 180 }
  };
  const backfill = await Wildfire.collection.updateMany(
    validCoordinates,
    [{
      $set: {
        location: { type: 'Point', coordinates: ['$longitude', '$latitude'] },
        acquiredAt: { $ifNull: ['$acquiredAt', '$timestamp'] },
        processedForMl: { $ifNull: ['$processedForMl', false] }
      }
    }]
  );

  const models = [
    Wildfire,
    CityBoundary,
    IndustrialLocation,
    OfficialIncident,
    OfficialPerimeter,
    FireEvent,
    DetectionSnapshot
  ];
  const fireEventIndexes = await FireEvent.collection.indexes();
  if (fireEventIndexes.some(index => index.name === 'eventId_1')) {
    await FireEvent.collection.dropIndex('eventId_1');
  }
  for (const model of models) await model.createIndexes();

  const missingLocation = await Wildfire.countDocuments({ location: { $exists: false } });
  console.log('=== GeoJSON migration report ===');
  console.log(`Wildfire documents matched: ${backfill.matchedCount}`);
  console.log(`Wildfire documents modified: ${backfill.modifiedCount}`);
  console.log(`Wildfire documents still missing location: ${missingLocation}`);
  console.log('GeoJSON indexes created for observations, reference data, and events.');
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(`GeoJSON migration failed: ${error.message}`);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
