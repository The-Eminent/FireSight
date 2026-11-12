// src/components/MapComponent.jsx
import React, {
  useEffect,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef
} from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import {
  getDetectionPolygon,
  getWildfireData,
  predictFireSpread,
  requestWildfireRefresh
} from '../api';
import { confidenceToPercent } from './confidence';
import {
  canShowPerimeter,
  eventMarkerCoordinates,
  geoJsonBounds,
  parseClusterCoordinates,
  perimeterActionLabel,
  perimeterResultLabel
} from './perimeter';
import {
  detectionStatusLabel,
  predictionCoordinates
} from './detectionStatus';
import { filterDetectionEvents } from './eventFilters';
import { predictionErrorMessage, predictionSummary } from './prediction';
import {
  calculateSafeWaypoint,
  featureBounds,
  proximityAlert,
  safetyCircle
} from './evacuation';

mapboxgl.accessToken = process.env.REACT_APP_MAPBOX_TOKEN;
const R_EARTH = 3958.8;
const PERIMETER_SOURCE = 'current-fire-perimeter';
const PERIMETER_FILL_LAYER = 'current-fire-perimeter-fill';
const PERIMETER_LINE_LAYER = 'current-fire-perimeter-line';
const SAFETY_SOURCE = 'home-safety-radius';
const ROUTE_SOURCE = 'evacuation-route';
const BOUNDARY_CANDIDATE_MILES = 30;

// Helpers
function getBrightnessCategory(b) {
  if (!Number.isFinite(Number(b))) return 'Reported';
  if (b >= 375) return 'Extreme';
  if (b >= 350) return 'Severe';
  if (b >= 325) return 'Moderate';
  return 'Small';
}

function getSeverityIcon(cat) {
  if (cat === 'Reported') return '📍';
  if (cat === 'Extreme') return '🔥🔥🔥';
  if (cat === 'Severe')  return '🔴🔥';
  if (cat === 'Moderate') return '⚠️';
  return '🌡️';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function reverseGeocode(lat, lon, token) {
  try {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?access_token=${token}&limit=1`;
    const resp = await fetch(url);
    const { features } = await resp.json();
    return features?.[0]?.place_name || 'Unknown';
  } catch {
    return 'Unknown';
  }
}

const MapComponent = forwardRef(({
  eventTypes,
  recencyHours,
  boundaryFilter,
  onFiresUpdated,
  setIsFetching,
  mapStyle,
  userLocation,
  onUserLocationChange,
  range,
  onNearbyFiresUpdate
}, ref) => {
  const mapContainerRef = useRef();
  const mapRef          = useRef();
  const clickHandlerRef = useRef();
  const activePopupRef  = useRef();
  const perimeterRequestRef = useRef(0);
  const predictionInFlightRef = useRef(false);
  const currentPerimeterRef = useRef(null);
  const currentPredictionRef = useRef(null);
  const homeLocationRef = useRef(userLocation);
  const homeMarkerRef = useRef(null);
  const safeZoneMarkerRef = useRef(null);
  const routeFeatureRef = useRef(null);
  const nearbyBoundariesRef = useRef([]);
  const boundaryCacheRef = useRef(new Map());
  const boundaryRequestRef = useRef(0);
  const locationChangeRef = useRef(onUserLocationChange);
  const [wildfires, setWildfires] = useState([]);
  const [alertTier, setAlertTier] = useState(null);
  const [isPlacingHome, setIsPlacingHome] = useState(false);
  const [isRouting, setIsRouting] = useState(false);
  const [routeError, setRouteError] = useState('');
  homeLocationRef.current = userLocation;
  locationChangeRef.current = onUserLocationChange;

  const emptyFeatureCollection = () => ({
    type: 'FeatureCollection',
    features: []
  });

  const removeEvacuationRoute = () => {
    routeFeatureRef.current = null;
    safeZoneMarkerRef.current?.remove();
    safeZoneMarkerRef.current = null;
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer(ROUTE_SOURCE)) map.removeLayer(ROUTE_SOURCE);
    if (map.getSource(ROUTE_SOURCE)) map.removeSource(ROUTE_SOURCE);
  };

  const updateProximityAlert = (
    location = homeLocationRef.current,
    boundaries = nearbyBoundariesRef.current,
    prediction = currentPredictionRef.current
  ) => {
    const activeBoundaries = currentPerimeterRef.current
      ? [currentPerimeterRef.current, ...boundaries]
      : boundaries;
    const nextTier = proximityAlert(location, activeBoundaries, prediction);
    setAlertTier(nextTier);
    if (nextTier !== 'evacuation') removeEvacuationRoute();
  };

  const updateSafetyRadius = (location = homeLocationRef.current) => {
    const source = mapRef.current?.getSource(SAFETY_SOURCE);
    if (!source) return;
    source.setData(location ? safetyCircle(location) : emptyFeatureCollection());
  };

  const syncHomeMarker = (location = homeLocationRef.current) => {
    const map = mapRef.current;
    if (!map) return;
    if (!location) {
      homeMarkerRef.current?.remove();
      homeMarkerRef.current = null;
      return;
    }
    if (!homeMarkerRef.current) {
      const element = document.createElement('div');
      element.textContent = '🏠';
      element.title = 'User/Home — drag to move';
      Object.assign(element.style, {
        fontSize: '26px', cursor: 'grab', filter: 'drop-shadow(0 1px 2px white)'
      });
      homeMarkerRef.current = new mapboxgl.Marker({ element, draggable: true })
        .setLngLat([location.lng, location.lat])
        .addTo(map);
      homeMarkerRef.current.on('dragend', () => {
        const point = homeMarkerRef.current.getLngLat();
        locationChangeRef.current?.({ lng: point.lng, lat: point.lat });
      });
    } else {
      homeMarkerRef.current.setLngLat([location.lng, location.lat]);
    }
  };

  const displayEvacuationRoute = routeFeature => {
    const map = mapRef.current;
    if (!map) return;
    removeEvacuationRoute();
    routeFeatureRef.current = routeFeature;
    map.addSource(ROUTE_SOURCE, { type: 'geojson', data: routeFeature });
    map.addLayer({
      id: ROUTE_SOURCE,
      type: 'line',
      source: ROUTE_SOURCE,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#15803d', 'line-width': 5, 'line-opacity': 0.9 }
    });
    const element = document.createElement('div');
    element.title = 'Calculated Safe Zone';
    Object.assign(element.style, {
      width: '20px', height: '20px', borderRadius: '50%',
      background: '#16a34a', border: '3px solid white',
      boxShadow: '0 1px 5px rgba(0,0,0,0.5)'
    });
    const routeCoordinates = routeFeature.geometry.coordinates;
    const routeEndpoint = routeCoordinates[routeCoordinates.length - 1];
    safeZoneMarkerRef.current = new mapboxgl.Marker({ element })
      .setLngLat(routeEndpoint)
      .setPopup(new mapboxgl.Popup({ offset: 18 }).setText('Calculated Safe Zone'))
      .addTo(map);
    map.fitBounds(featureBounds(routeFeature), { padding: 80, duration: 1000 });
  };

  const cancelPendingPerimeterRequest = () => {
    perimeterRequestRef.current += 1;
  };

  const removeDetectionPerimeter = () => {
    cancelPendingPerimeterRequest();
    currentPerimeterRef.current = null;
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer(PERIMETER_LINE_LAYER)) map.removeLayer(PERIMETER_LINE_LAYER);
    if (map.getLayer(PERIMETER_FILL_LAYER)) map.removeLayer(PERIMETER_FILL_LAYER);
    if (map.getSource(PERIMETER_SOURCE)) map.removeSource(PERIMETER_SOURCE);
  };

  const trackPopup = popup => {
    activePopupRef.current = popup;
    popup.on('close', () => {
      if (activePopupRef.current === popup) activePopupRef.current = null;
      cancelPendingPerimeterRequest();
    });
  };

  const closeActivePopup = () => {
    if (activePopupRef.current) activePopupRef.current.remove();
  };

  // 1) Fetch & cache data
  const fetchWildfires = async (requestRefresh = false) => {
    setIsFetching(true);
    try {
      if (requestRefresh) await requestWildfireRefresh();
      const { data } = await getWildfireData();
      const arr = data.data || [];
      setWildfires(arr);
      onFiresUpdated?.(arr.length);
      updateWildfireSource(arr);
    } finally {
      setIsFetching(false);
    }
  };
  useImperativeHandle(ref, () => ({
    refreshWildfires: () => fetchWildfires(true)
  }), []);

  // 2) Update wildfire layer source
  const updateWildfireSource = (dataArray = wildfires) => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource('wildfires-source');
    if (!src) return;

    const filtered = filterDetectionEvents(dataArray, {
      eventTypes,
      recencyHours,
      boundaryFilter
    });
    onFiresUpdated?.(filtered.length);

    src.setData({
      type: 'FeatureCollection',
      features: filtered.map(f => {
        const clusterCoordinates = parseClusterCoordinates(f.cluster_coordinates);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: eventMarkerCoordinates(f) },
          properties: {
          brightnessCat:  getBrightnessCategory(f.brightness),
          confidenceRaw:  f.confidence,
          timestamp:      f.timestamp,
          brightness:     f.brightness,
          representativeLatitude: f.representativeLatitude,
          representativeLongitude: f.representativeLongitude,
          latitude:       f.latitude,
          longitude:      f.longitude,
          status:         f.status,
          incidentName:   f.incidentName || '',
          officialIncidentId: f.officialIncidentId || '',
          observationCount: f.observationCount,
          sources:        (f.sources || []).join(', '),
          incidentSizeAcres: f.incidentSizeAcres,
          percentContained: f.percentContained,
          hasOfficialPerimeter: Boolean(f.hasOfficialPerimeter),
          firstObservedAt: f.firstObservedAt,
          clusterCoordinates: JSON.stringify(clusterCoordinates)
          }
        }
      })
    });
  };

  // Helper to convert degrees to cardinal direction
  const getDirectionName = (degrees) => {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const index = Math.round(((degrees % 360) / 45)) % 8;
    return directions[index];
  };

  // Handle fire spread prediction
  const handlePredictFireSpread = async (
    fireProps, clusterCoordinates, officialIncidentId, button
  ) => {
    if (predictionInFlightRef.current) return;
    predictionInFlightRef.current = true;
    const errorElement = button.closest('.wildfire-popup')
      ?.querySelector('[data-prediction-error]');
    button.disabled = true;
    button.textContent = 'Predicting...';
    if (errorElement) errorElement.textContent = '';

    try {
      const boundary = currentPerimeterRef.current || await getDetectionPolygon({
        clusterCoordinates, officialIncidentId
      });
      currentPerimeterRef.current = boundary;
      displayDetectionPerimeter(boundary);
      const prediction = await predictFireSpread(boundary);
      displayFirePrediction(prediction);

      // Show prediction results in a new popup
      closeActivePopup();
      showPredictionPopup(fireProps, prediction);
    } catch (error) {
      console.error('Failed to predict fire spread:', error);
      if (errorElement?.isConnected) {
        errorElement.textContent = predictionErrorMessage(error);
      }
    } finally {
      predictionInFlightRef.current = false;
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = 'Predict 24h Spread';
      }
    }
  };

  const displayDetectionPerimeter = feature => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer(PERIMETER_LINE_LAYER)) map.removeLayer(PERIMETER_LINE_LAYER);
    if (map.getLayer(PERIMETER_FILL_LAYER)) map.removeLayer(PERIMETER_FILL_LAYER);
    if (map.getSource(PERIMETER_SOURCE)) map.removeSource(PERIMETER_SOURCE);

    map.addSource(PERIMETER_SOURCE, { type: 'geojson', data: feature });
    map.addLayer({
      id: PERIMETER_FILL_LAYER,
      type: 'fill',
      source: PERIMETER_SOURCE,
      paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.4 }
    });
    map.addLayer({
      id: PERIMETER_LINE_LAYER,
      type: 'line',
      source: PERIMETER_SOURCE,
      paint: { 'line-color': '#b91c1c', 'line-width': 2 }
    });
    updateProximityAlert(homeLocationRef.current);

    const bounds = geoJsonBounds(feature);
    if (bounds) map.fitBounds(bounds, { padding: 60, duration: 1000, maxZoom: 14 });
  };

  const handleShowCurrentPerimeter = async (clusterCoordinates, officialIncidentId, button) => {
    const errorElement = button.closest('.wildfire-popup')
      ?.querySelector('[data-perimeter-error]');
    const requestId = ++perimeterRequestRef.current;
    button.disabled = true;
    button.textContent = 'Loading Perimeter...';
    if (errorElement) errorElement.textContent = '';

    try {
      const feature = await getDetectionPolygon({ clusterCoordinates, officialIncidentId });
      if (requestId !== perimeterRequestRef.current) return;
      currentPerimeterRef.current = feature;
      displayDetectionPerimeter(feature);
      if (button.isConnected) {
        button.textContent = perimeterResultLabel(feature?.properties?.source);
      }
    } catch (error) {
      if (requestId !== perimeterRequestRef.current) return;
      console.error('Failed to load current fire perimeter:', error);
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = button.dataset.defaultLabel || 'Show Current Perimeter';
      }
      if (errorElement?.isConnected) errorElement.textContent = 'Unable to load perimeter. Please try again.';
    }
  };

  // Display fire prediction on map
  const displayFirePrediction = (prediction) => {
    const map = mapRef.current;
    if (!map) return;
    
    // Remove any existing prediction layers
    if (map.getSource('fire-spread-prediction')) {
      if (map.getLayer('fire-spread-direction')) map.removeLayer('fire-spread-direction');
      if (map.getLayer('fire-spread-area')) map.removeLayer('fire-spread-area');
      if (map.getLayer('fire-spread-points')) map.removeLayer('fire-spread-points');
      map.removeSource('fire-spread-prediction');
    }
    
    // Add the prediction source
    map.addSource('fire-spread-prediction', {
      type: 'geojson',
      data: prediction
    });
    
    // Add the spread area layer
    map.addLayer({
      id: 'fire-spread-area',
      type: 'fill',
      source: 'fire-spread-prediction',
      paint: {
        'fill-color': '#f97316',
        'fill-opacity': 0.3,
        'fill-outline-color': '#c2410c'
      }
    });
    
    // Add a clear outline around the predicted boundary.
    map.addLayer({
      id: 'fire-spread-direction',
      type: 'line',
      source: 'fire-spread-prediction',
      paint: {
        'line-color': '#c2410c',
        'line-width': 3,
        'line-dasharray': [2, 2]
      }
    });
    currentPredictionRef.current = prediction;
    updateProximityAlert(homeLocationRef.current, nearbyBoundariesRef.current, prediction);

    const bounds = geoJsonBounds(prediction);
    if (bounds) map.fitBounds(bounds, { padding: 60, duration: 1000, maxZoom: 14 });
  };

  // Show prediction results in popup
  const showPredictionPopup = (fireProps, prediction) => {
    const map = mapRef.current;
    if (!map) return;
    
    const summary = predictionSummary(prediction);
    const popupContent = `
      <div class="wildfire-popup">
        <h4>${getSeverityIcon(fireProps.brightnessCat)} ${fireProps.brightnessCat} Fire</h4>
        <div class="prediction-results">
          <h5>24-Hour Spread Prediction</h5>
          <p><strong>Will spread:</strong> ${summary.willSpread ? 'Yes' : 'No'}</p>
          <p><strong>Mean boundary probability:</strong> ${summary.probabilityPercent}%</p>
          <p><strong>Maximum displacement:</strong> ${summary.distanceKm.toFixed(2)} km</p>
          <p><strong>Main direction:</strong> ${getDirectionName(summary.directionDegrees)}</p>
          <div class="env-data">
            <h6>Live Environmental Factors:</h6>
            <p>Wind: ${summary.windSpeedMps.toFixed(1)} m/s ${getDirectionName(summary.windDirectionDegrees)}</p>
            <p>Temp: ${summary.temperatureC.toFixed(1)}°C, Humidity: ${summary.humidityPercent.toFixed(0)}%</p>
            <p>Data source: Open-Meteo + Copernicus GLO-90</p>
          </div>
        </div>
      </div>
    `;
    
    const popup = new mapboxgl.Popup()
      .setLngLat([fireProps.longitude, fireProps.latitude])
      .setHTML(popupContent)
      .addTo(map);
    trackPopup(popup);
  };

  // 4) Create sources/layers + click handler
  const setupLayers = () => {
    const map = mapRef.current;
    if (!map) return;

    // Wildfires layer
    if (map.getLayer('wildfires-layer'))  map.removeLayer('wildfires-layer');
    if (map.getSource('wildfires-source')) map.removeSource('wildfires-source');
    map.addSource('wildfires-source', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] }
    });
    map.addLayer({
      id: 'wildfires-layer',
      type: 'circle',
      source: 'wildfires-source',
      paint: {
        'circle-radius':       4,
        'circle-color': [
          'match', ['get', 'status'],
          'confirmed_wildfire', '#d7191c',
          'satellite_detected_active_fire', '#ff7f00',
          'unverified_thermal_anomaly', '#f6c344',
          'reported_incident_no_recent_satellite_detection', '#2c7bb6',
          '#777777'
        ],
        'circle-stroke-width': 1,
        'circle-stroke-color': '#fff'
      }
    });

    // Click handler for popups
    if (clickHandlerRef.current) {
      map.off('click','wildfires-layer', clickHandlerRef.current);
    }
    clickHandlerRef.current = async e => {
      const f = e.features[0];
      if (!f) return;
      const {
        brightnessCat, confidenceRaw, timestamp, brightness, status, incidentName,
        observationCount, sources, incidentSizeAcres, percentContained,
        hasOfficialPerimeter, officialIncidentId, representativeLatitude, representativeLongitude,
        clusterCoordinates
      } = f.properties;
      const coords = f.geometry.coordinates;
      const timeStr = timestamp
        ? new Date(timestamp).toLocaleString()
        : 'Unknown';

      // raw percent for the popup
      closeActivePopup();
      removeDetectionPerimeter();

      const pct = confidenceToPercent(confidenceRaw);
      const address = await reverseGeocode(coords[1], coords[0], mapboxgl.accessToken);
      const icon    = getSeverityIcon(brightnessCat);
      const hasObservation = Number(observationCount) > 0;
      const eventClusterCoordinates = parseClusterCoordinates(clusterCoordinates);
      const hasOfficialBoundary = hasOfficialPerimeter === true || hasOfficialPerimeter === 'true';
      const perimeterButtonText = perimeterActionLabel(hasOfficialBoundary);
      const officialDetails = incidentName
        ? `<p><strong>Official incident:</strong> ${escapeHtml(incidentName)}</p>
           <p><strong>Size:</strong> ${incidentSizeAcres ?? 'Unknown'} acres; <strong>contained:</strong> ${percentContained ?? 'Unknown'}%</p>`
        : '';
      const satelliteDetails = hasObservation
        ? `<p><strong>Confidence:</strong> ${pct}%</p>
           <p><strong>Satellite observations:</strong> ${observationCount} (${escapeHtml(sources)})</p>
           <p><strong>Last observed:</strong> ${timeStr}</p>`
        : '<p>No FIRMS observation was found in the current two-day window.</p>';

      // Create fire properties object for prediction
      const predictionLocation = predictionCoordinates({
        status,
        representativeLatitude,
        representativeLongitude
      }, coords);
      const fireProps = {
        brightnessCat,
        brightness,
        ...predictionLocation
      };

      const popup = new mapboxgl.Popup()
        .setLngLat(coords)
        .setHTML(`
          <div class="wildfire-popup">
            <h4>${icon} ${detectionStatusLabel(status)}</h4>
            <p><strong>Address:</strong> ${address}</p>
            ${officialDetails}
            ${satelliteDetails}
            ${canShowPerimeter(eventClusterCoordinates, hasOfficialBoundary) ? `${!hasOfficialBoundary ? `<p class="perimeter-note">
              No official WFIGS perimeter is available. This draws an estimated footprint around the recent satellite detections.
            </p>` : ''}<button id="show-current-perimeter-btn" class="perimeter-btn" data-default-label="${perimeterButtonText}">
              ${perimeterButtonText}
            </button>
            <p class="perimeter-error" data-perimeter-error></p>` : ''}
            ${hasObservation ? `<button id="predict-spread-btn" class="predict-spread-btn">
              Predict 24h Spread
            </button>
            <p class="prediction-error" data-prediction-error></p>` : ''}
          </div>
        `)
        .addTo(map);
      
      trackPopup(popup);

      const perimeterBtn = document.getElementById('show-current-perimeter-btn');
      if (perimeterBtn) {
        perimeterBtn.addEventListener('click', () =>
          handleShowCurrentPerimeter(eventClusterCoordinates, officialIncidentId, perimeterBtn));
      }
      
      // Add event listener to the predict button
      const predictBtn = document.getElementById('predict-spread-btn');
      if (predictBtn) {
        predictBtn.addEventListener('click', () => handlePredictFireSpread(
          fireProps, eventClusterCoordinates, officialIncidentId, predictBtn
        ));
      }
    };
    map.on('click','wildfires-layer', clickHandlerRef.current);

    // Home safety radius. The draggable home itself is a Mapbox Marker.
    if (map.getLayer(`${SAFETY_SOURCE}-line`)) map.removeLayer(`${SAFETY_SOURCE}-line`);
    if (map.getLayer(`${SAFETY_SOURCE}-fill`)) map.removeLayer(`${SAFETY_SOURCE}-fill`);
    if (map.getSource(SAFETY_SOURCE)) map.removeSource(SAFETY_SOURCE);
    map.addSource(SAFETY_SOURCE, {
      type: 'geojson',
      data: homeLocationRef.current
        ? safetyCircle(homeLocationRef.current)
        : emptyFeatureCollection()
    });
    map.addLayer({
      id: `${SAFETY_SOURCE}-fill`,
      type: 'fill',
      source: SAFETY_SOURCE,
      paint: {
        'fill-color': '#f59e0b',
        'fill-opacity': 0.12
      }
    });
    map.addLayer({
      id: `${SAFETY_SOURCE}-line`,
      type: 'line',
      source: SAFETY_SOURCE,
      paint: { 'line-color': '#d97706', 'line-width': 2, 'line-dasharray': [2, 2] }
    });

    if (routeFeatureRef.current) {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data: routeFeatureRef.current });
      map.addLayer({
        id: ROUTE_SOURCE,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#15803d', 'line-width': 5, 'line-opacity': 0.9 }
      });
    }
  };

  // 5) Initialize map once
  useEffect(() => {
    const m = new mapboxgl.Map({
      container: mapContainerRef.current,
      style:     mapStyle,
      center:    [-98, 38],
      zoom:      4,
      maxBounds: [[-130,22],[-66,50]]
    });
    m.addControl(new mapboxgl.NavigationControl());
    mapRef.current = m;

    m.on('load', () => {
      setupLayers();
      fetchWildfires();
      updateWildfireSource();
      syncHomeMarker();
    });
    return () => {
      homeMarkerRef.current?.remove();
      safeZoneMarkerRef.current?.remove();
      m.remove();
    };
  }, []);

  // 6) Reapply on style change
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setStyle(mapStyle);
    map.once('styledata', () => {
      setupLayers();
      updateWildfireSource();
      updateSafetyRadius();
      syncHomeMarker();
    });
  }, [mapStyle]);

  // 7) Refresh layer when filters/data change
  useEffect(() => {
    updateWildfireSource();
  }, [wildfires, eventTypes, recencyHours, boundaryFilter]);

  // 8) Update the draggable home marker, radius and alert.
  useEffect(() => {
    removeEvacuationRoute();
    setRouteError('');
    updateSafetyRadius(userLocation);
    syncHomeMarker(userLocation);
    updateProximityAlert(userLocation);
  }, [userLocation]);

  // Place the home pin with the next map click, then allow normal dragging.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !isPlacingHome) return;
    map.getCanvas().style.cursor = 'crosshair';
    const placePin = event => {
      locationChangeRef.current?.({ lng: event.lngLat.lng, lat: event.lngLat.lat });
      setIsPlacingHome(false);
    };
    map.once('click', placePin);
    return () => {
      map.off('click', placePin);
      map.getCanvas().style.cursor = '';
    };
  }, [isPlacingHome]);

  // Resolve only nearby event boundaries, cache them, then run Turf locally.
  useEffect(() => {
    const requestId = ++boundaryRequestRef.current;
    if (!userLocation) {
      nearbyBoundariesRef.current = [];
      updateProximityAlert(null, []);
      return;
    }
    const timer = setTimeout(async () => {
      const candidates = wildfires.filter(event => {
        const cluster = parseClusterCoordinates(event.cluster_coordinates);
        if (!canShowPerimeter(cluster, event.hasOfficialPerimeter)) return false;
        const [longitude, latitude] = eventMarkerCoordinates(event);
        return haversineDistance(
          userLocation.lat, userLocation.lng, latitude, longitude
        ) <= BOUNDARY_CANDIDATE_MILES;
      });
      const settled = await Promise.allSettled(candidates.map(async event => {
        const key = event.eventId || event.officialIncidentId || JSON.stringify(event.cluster_coordinates);
        if (boundaryCacheRef.current.has(key)) return boundaryCacheRef.current.get(key);
        const boundary = await getDetectionPolygon({
          clusterCoordinates: parseClusterCoordinates(event.cluster_coordinates),
          officialIncidentId: event.officialIncidentId
        });
        boundaryCacheRef.current.set(key, boundary);
        return boundary;
      }));
      if (requestId !== boundaryRequestRef.current) return;
      nearbyBoundariesRef.current = settled
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);
      updateProximityAlert(userLocation, nearbyBoundariesRef.current);
    }, 300);
    return () => clearTimeout(timer);
  }, [userLocation, wildfires]);

  const handleFindEvacuationRoute = async () => {
    const location = homeLocationRef.current;
    const waypoint = calculateSafeWaypoint(location, currentPredictionRef.current);
    if (!waypoint || !mapboxgl.accessToken) {
      setRouteError('A home pin, prediction and Mapbox token are required.');
      return;
    }
    setIsRouting(true);
    setRouteError('');
    try {
      const coordinates = `${location.lng},${location.lat};${waypoint.lng},${waypoint.lat}`;
      const response = await fetch(
        `https://api.mapbox.com/directions/v5/mapbox/driving/${coordinates}` +
        `?geometries=geojson&overview=full&access_token=${encodeURIComponent(mapboxgl.accessToken)}`
      );
      if (!response.ok) throw new Error(`Mapbox Directions returned ${response.status}`);
      const data = await response.json();
      if (!data.routes?.[0]?.geometry) throw new Error('No driving route was found');
      displayEvacuationRoute({
        type: 'Feature',
        properties: {
          distance_m: data.routes[0].distance,
          duration_s: data.routes[0].duration
        },
        geometry: data.routes[0].geometry
      });
    } catch (error) {
      console.error('Failed to calculate evacuation route:', error);
      setRouteError('Unable to calculate a driving route. Please try again.');
    } finally {
      setIsRouting(false);
    }
  };

  // 9) Compute & send all in-range fires
  useEffect(() => {
    if (!onNearbyFiresUpdate) return;
    const t = setTimeout(async () => {
      if (!userLocation || wildfires.length === 0 || range <= 0) {
        onNearbyFiresUpdate([]);
        return;
      }
      // Use the exact same filtered events and coordinates as the visible map layer.
      const visibleEvents = filterDetectionEvents(wildfires, {
        eventTypes,
        recencyHours,
        boundaryFilter
      });
      const inRange = visibleEvents
        .map(f => {
          const [longitude, latitude] = eventMarkerCoordinates(f);
          const d = haversineDistance(
            userLocation.lat, userLocation.lng,
            latitude, longitude
          );
          return {
            ...f,
            distance:      d,
            markerLatitude: latitude,
            markerLongitude: longitude
          };
        })
        .filter(f => f.distance <= range);

      // Reverse-geocode the same coordinate used to draw and measure the marker.
      const enriched = await Promise.all(
        inRange.map(async f => {
          const cityName = await reverseGeocode(
            f.markerLatitude,
            f.markerLongitude,
            mapboxgl.accessToken
          );
          return {
            eventId: f.eventId || f.officialIncidentId || `${f.markerLongitude},${f.markerLatitude}`,
            cityName,
            distance:      f.distance,
            statusLabel: detectionStatusLabel(f.status),
            incidentName: f.incidentName
          };
        })
      );
      onNearbyFiresUpdate(enriched);
    }, 500);
    return () => clearTimeout(t);
  }, [userLocation, range, wildfires, eventTypes, recencyHours, boundaryFilter, onNearbyFiresUpdate]);

  // Add CSS for the prediction button and environmental data
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      .predict-spread-btn {
        background-color: #4CAF50;
        color: white;
        padding: 8px 12px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        margin-top: 10px;
        width: 100%;
        font-weight: bold;
      }
      .perimeter-btn {
        background-color: #2563eb;
        color: white;
        padding: 8px 12px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        margin-top: 10px;
        width: 100%;
        font-weight: bold;
      }
      .perimeter-btn:hover:not(:disabled) { background-color: #1d4ed8; }
      .perimeter-btn:disabled { cursor: wait; opacity: 0.75; }
      .perimeter-error { color: #b91c1c; margin: 6px 0 0; }
      .perimeter-note { color: #555; font-size: 0.9em; margin: 8px 0 0; }
      .predict-spread-btn:hover {
        background-color: #45a049;
      }
      .predict-spread-btn:disabled { cursor: wait; opacity: 0.75; }
      .prediction-error { color: #b91c1c; margin: 6px 0 0; }
      .prediction-results {
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid #ddd;
      }
      .prediction-results h5 {
        margin-top: 0;
        margin-bottom: 8px;
        color: #FF4500;
      }
      .env-data {
        margin-top: 8px;
        padding: 8px;
        background-color: #f8f8f8;
        border-radius: 4px;
        font-size: 0.9em;
      }
      .env-data h6 {
        margin: 0 0 5px 0;
        color: #666;
      }
      .env-data p {
        margin: 3px 0;
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
    };
  }, []);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div
        ref={mapContainerRef}
        style={{ position: 'absolute', inset: 0 }}
      />

      <div style={styles.homeControls}>
        <button
          style={styles.homeButton}
          onClick={() => setIsPlacingHome(value => !value)}
        >
          {isPlacingHome ? 'Click Map to Place Home' : 'Drop User/Home Pin'}
        </button>
        {userLocation && (
          <button
            style={{ ...styles.homeButton, ...styles.clearButton }}
            onClick={() => {
              setIsPlacingHome(false);
              nearbyBoundariesRef.current = [];
              setAlertTier(null);
              removeEvacuationRoute();
              locationChangeRef.current?.(null);
            }}
          >
            Clear Home &amp; Route
          </button>
        )}
      </div>

      {alertTier && (
        <div style={styles.alertPosition}>
          <div
            role="alert"
            style={{
              ...styles.alertBanner,
              ...(alertTier === 'evacuation' ? styles.criticalAlert : styles.nearbyAlert)
            }}
          >
            <div>
              {alertTier === 'evacuation'
                ? '🚨 EVACUATION WARNING: Predicted fire spread has breached your safety radius.'
                : '⚠️ Active Fire Nearby: A fire is currently burning within your 10-mile safety radius.'}
            </div>
            {alertTier === 'evacuation' && (
              <button
                style={styles.routeButton}
                onClick={handleFindEvacuationRoute}
                disabled={isRouting}
              >
                {isRouting ? 'Finding Route...' : 'Find Evacuation Route'}
              </button>
            )}
            {routeError && <div style={styles.routeError}>{routeError}</div>}
          </div>
        </div>
      )}
    </div>
  );
});

const styles = {
  homeControls: {
    position: 'absolute',
    top: 105,
    right: 10,
    zIndex: 5,
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  },
  homeButton: {
    border: 0,
    borderRadius: 5,
    padding: '9px 12px',
    background: '#1d4ed8',
    color: 'white',
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(0,0,0,0.3)'
  },
  clearButton: { background: '#475569' },
  alertPosition: {
    position: 'absolute',
    top: 16,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'min(680px, calc(100% - 32px))',
    zIndex: 6,
    pointerEvents: 'none'
  },
  alertBanner: {
    borderRadius: 8,
    padding: '12px 16px',
    color: '#111827',
    fontWeight: 700,
    boxShadow: '0 3px 12px rgba(0,0,0,0.35)',
    pointerEvents: 'auto'
  },
  nearbyAlert: { background: '#fbbf24', border: '2px solid #d97706' },
  criticalAlert: { background: '#dc2626', border: '2px solid #7f1d1d', color: 'white' },
  routeButton: {
    marginTop: 10,
    padding: '8px 12px',
    border: 0,
    borderRadius: 5,
    background: 'white',
    color: '#991b1b',
    fontWeight: 800,
    cursor: 'pointer'
  },
  routeError: { marginTop: 8, fontSize: '0.85rem' }
};

export default MapComponent;
