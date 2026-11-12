const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EARTH_RADIUS_KM,
  get_dynamic_wfigs_buffer,
  matchObservationsToWfigs
} = require('./wfigsMatching');

test('selects the requested WFIGS buffer from incident acreage', () => {
  assert.equal(get_dynamic_wfigs_buffer(499), 5);
  assert.equal(get_dynamic_wfigs_buffer(500), 10);
  assert.equal(get_dynamic_wfigs_buffer(10000), 10);
  assert.equal(get_dynamic_wfigs_buffer(10001), 15);
});

test('queries MongoDB with centerSphere radians and links the nearest incident', async () => {
  const queries = [];
  const model = {
    find(query) {
      queries.push(query);
      return {
        select() {
          return { lean: async () => [{ detectionId: 'fire-1' }] };
        }
      };
    }
  };
  const observations = [{ detectionId: 'fire-1', latitude: 37, longitude: -120 }];
  const incidents = [{
    geometry: { type: 'Point', coordinates: [-120, 37] },
    properties: { IrwinID: '{ABC}', IncidentSize: 400 }
  }];

  const matches = await matchObservationsToWfigs(observations, incidents, model);

  assert.equal(matches.get('fire-1'), 'abc');
  assert.deepEqual(
    queries[0].location.$geoWithin.$centerSphere,
    [[-120, 37], 5 / EARTH_RADIUS_KM]
  );
});
