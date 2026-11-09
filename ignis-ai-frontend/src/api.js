import axios from 'axios';

// ——— OLD (local-only) config ———
// const api = axios.create({
//   baseURL: 'http://localhost:5000/api',
// });
// ————————————————————————————

/**
 * In production we’ll read REACT_APP_API_BASE_URL (e.g.
 * https://your-backend.onrender.com/api) from the environment.
 * Locally it will fallback to http://localhost:5000/api.
 */
const baseURL =
  process.env.REACT_APP_API_BASE_URL /* e.g. "https://…/api" */ ||
  'http://localhost:5000/api';

const api = axios.create({ baseURL });

export const getWildfireData = () => api.get('/wildfires');
export const requestWildfireRefresh = () => api.post('/wildfires/refresh');

export const getDetectionPolygon = async ({ clusterCoordinates, officialIncidentId }) => {
  const response = await api.post('/detection-polygon', {
    fire_event_cluster: clusterCoordinates,
    official_incident_id: officialIncidentId || null
  });
  return response.data;
};

export const predictFireSpread = async (boundaryFeature) => {
  try {
    const response = await api.post('/predict-fire-spread', boundaryFeature);
    return response.data;
  } catch (error) {
    console.error('Error predicting fire spread:', error);
    throw error;
  }
};
