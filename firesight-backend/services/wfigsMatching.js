const Wildfire = require('../models/Wildfire');
const { haversineKm } = require('./detectionFusion');

const EARTH_RADIUS_KM = 6378.1;

function get_dynamic_wfigs_buffer(acres) {
  const size = Number(acres);
  if (Number.isFinite(size) && size < 500) return 5.0;
  if (Number.isFinite(size) && size <= 10000) return 10.0;
  return 15.0;
}

function parseIncident(feature) {
  const properties = feature.properties || {};
  const coordinates = feature.geometry?.coordinates || [];
  return {
    id: String(properties.IrwinID || properties.UniqueFireIdentifier || '')
      .replace(/[{}]/g, '').toLowerCase(),
    latitude: Number(properties.InitialLatitude ?? coordinates[1]),
    longitude: Number(properties.InitialLongitude ?? coordinates[0]),
    acres: properties.IncidentSize
  };
}

async function matchObservationsToWfigs(observations, incidentFeatures, model = Wildfire) {
  const observationsById = new Map(observations.map(item => [item.detectionId, item]));
  const candidates = new Map();
  const incidents = incidentFeatures.map(parseIncident).filter(incident => incident.id &&
    Number.isFinite(incident.latitude) && Number.isFinite(incident.longitude));
  const detectionIds = [...observationsById.keys()];

  for (let offset = 0; offset < incidents.length; offset += 8) {
    const batch = incidents.slice(offset, offset + 8);
    const results = await Promise.all(batch.map(async incident => {
      const radiusKm = get_dynamic_wfigs_buffer(incident.acres);
      const rows = await model.find({
        detectionId: { $in: detectionIds },
        location: {
          $geoWithin: {
            $centerSphere: [
              [incident.longitude, incident.latitude],
              radiusKm / EARTH_RADIUS_KM
            ]
          }
        }
      }).select('detectionId').lean();
      return { incident, rows };
    }));

    results.forEach(({ incident, rows }) => rows.forEach(row => {
      const observation = observationsById.get(row.detectionId);
      if (!observation) return;
      const distance = haversineKm(observation, incident);
      const current = candidates.get(row.detectionId);
      if (!current || distance < current.distance) {
        candidates.set(row.detectionId, { incidentId: incident.id, distance });
      }
    }));
  }

  return new Map([...candidates].map(([id, match]) => [id, match.incidentId]));
}

module.exports = {
  EARTH_RADIUS_KM,
  get_dynamic_wfigs_buffer,
  matchObservationsToWfigs
};
