const axios = require('axios');
const mongoose = require('mongoose');
const connectDB = require('../db');
const CityBoundary = require('../models/CityBoundary');
const IndustrialLocation = require('../models/IndustrialLocation');
const { geometryBbox } = require('../services/spatialData');
const { repairGeoJsonFeatures } = require('../services/geometryRepair');
require('dotenv').config();

const DEFAULT_CENSUS_URL =
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Urban/MapServer/8/query';

async function syncUrbanBoundaries() {
  const synchronizedAt = new Date();
  const url = process.env.CENSUS_URBAN_URL || DEFAULT_CENSUS_URL;
  const features = [];
  let skippedGeometryCount = 0;
  const pageSize = 200;
  for (let resultOffset = 0; ; resultOffset += pageSize) {
    const { data } = await axios.get(url, {
      params: {
        where: '1=1',
        outFields: 'GEOID,NAME',
        returnGeometry: true,
        outSR: 4326,
        orderByFields: 'GEOID',
        resultOffset,
        resultRecordCount: pageSize,
        f: 'geojson'
      },
      timeout: 120000,
      headers: { 'User-Agent': 'firesight' }
    });
    if (data.error) throw new Error(`Census query failed: ${data.error.message}`);
    const page = data.features || [];
    const repaired = repairGeoJsonFeatures(page, { simplifyMeters: 250 });
    features.push(...repaired.features);
    skippedGeometryCount += repaired.skipped;
    if (page.length < pageSize) break;
  }
  const documents = features.map(feature => {
    const bbox = geometryBbox(feature.geometry);
    if (!bbox || !['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)) return null;
    return {
      sourceId: String(feature.properties?.GEOID || feature.id),
      name: feature.properties?.NAME || 'Unnamed urban area',
      source: 'US_CENSUS_TIGERWEB',
      geometry: feature.geometry,
      bbox,
      synchronizedAt
    };
  }).filter(Boolean);
  if (!documents.length) throw new Error('Census returned no usable urban boundaries');
  await CityBoundary.bulkWrite(documents.map(boundary => ({
    updateOne: {
      filter: { sourceId: boundary.sourceId },
      update: { $set: boundary },
      upsert: true
    }
  })), { ordered: false });
  await CityBoundary.deleteMany({
    source: 'US_CENSUS_TIGERWEB',
    synchronizedAt: { $ne: synchronizedAt }
  });
  return { count: documents.length, skippedGeometryCount };
}

async function syncIndustrialBlacklist() {
  if (!process.env.INDUSTRIAL_BLACKLIST_URL) return { skipped: true, count: 0 };
  const synchronizedAt = new Date();
  const { data } = await axios.get(process.env.INDUSTRIAL_BLACKLIST_URL, {
    timeout: 120000,
    headers: { 'User-Agent': 'firesight' }
  });
  const documents = (data.features || []).map(feature => {
    if (feature.geometry?.type !== 'Point') return null;
    const properties = feature.properties || {};
    const sourceId = feature.id || properties.sourceId || properties.id;
    if (sourceId == null) return null;
    return {
      sourceId: String(sourceId),
      name: properties.name || properties.NAME || `Industrial source ${sourceId}`,
      category: properties.category || 'persistent_heat_source',
      source: properties.source || 'CONFIGURED_GEOJSON',
      location: feature.geometry,
      radiusMeters: Number(properties.radiusMeters) || 100,
      active: properties.active !== false,
      metadata: properties,
      synchronizedAt
    };
  }).filter(Boolean);
  if (!documents.length) throw new Error('Industrial GeoJSON returned no usable Point features');
  await IndustrialLocation.bulkWrite(documents.map(location => ({
    updateOne: {
      filter: { sourceId: location.sourceId },
      update: { $set: location },
      upsert: true
    }
  })), { ordered: false });
  await IndustrialLocation.deleteMany({
    source: 'CONFIGURED_GEOJSON',
    synchronizedAt: { $ne: synchronizedAt }
  });
  return { skipped: false, count: documents.length };
}

async function main() {
  await connectDB();
  const urban = await syncUrbanBoundaries();
  const industrial = await syncIndustrialBlacklist();
  await Promise.all([CityBoundary.createIndexes(), IndustrialLocation.createIndexes()]);
  console.log('=== Spatial reference-data report ===');
  console.log(`Census urban boundaries synchronized: ${urban.count}`);
  console.log(`Census geometries skipped after repair: ${urban.skippedGeometryCount}`);
  console.log(industrial.skipped
    ? 'Industrial blacklist: skipped (INDUSTRIAL_BLACKLIST_URL is not configured)'
    : `Industrial blacklist locations synchronized: ${industrial.count}`);
  await mongoose.disconnect();
}

main().catch(async error => {
  console.error(`Spatial reference-data synchronization failed: ${error.message}`);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
