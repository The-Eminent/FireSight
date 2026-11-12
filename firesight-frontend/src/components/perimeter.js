export function parseClusterCoordinates(value) {
  try {
    const coordinates = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(coordinates)
      ? coordinates.filter(coordinate =>
          Array.isArray(coordinate) &&
          coordinate.length >= 2 &&
          Number.isFinite(Number(coordinate[0])) &&
          Number.isFinite(Number(coordinate[1]))
        )
      : [];
  } catch {
    return [];
  }
}

export function eventMarkerCoordinates(event) {
  const cluster = parseClusterCoordinates(event?.cluster_coordinates);
  if (!cluster.length) return [event?.longitude, event?.latitude];
  const totals = cluster.reduce(
    ([longitude, latitude], point) => [longitude + Number(point[0]), latitude + Number(point[1])],
    [0, 0]
  );
  return [totals[0] / cluster.length, totals[1] / cluster.length];
}

export function perimeterActionLabel(hasOfficialPerimeter) {
  return hasOfficialPerimeter
    ? 'Show Current Perimeter'
    : 'Show Estimated Satellite Footprint';
}

export function canShowPerimeter(clusterCoordinates, hasOfficialPerimeter) {
  return Boolean(hasOfficialPerimeter || parseClusterCoordinates(clusterCoordinates).length);
}

export function perimeterResultLabel(source) {
  return source === 'wfigs'
    ? 'Official Perimeter Shown'
    : 'Estimated Satellite Footprint Shown';
}

export function geoJsonBounds(feature) {
  const geometry = feature?.geometry;
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = coordinates => {
    if (typeof coordinates?.[0] === 'number') {
      const [longitude, latitude] = coordinates;
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
      west = Math.min(west, longitude);
      south = Math.min(south, latitude);
      east = Math.max(east, longitude);
      north = Math.max(north, latitude);
      return;
    }
    coordinates?.forEach(visit);
  };
  visit(geometry.coordinates);

  return Number.isFinite(west) ? [[west, south], [east, north]] : null;
}
