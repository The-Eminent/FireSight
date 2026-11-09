const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPredictionHandler } = require('./predictFireSpread');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

const boundary = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'Polygon',
    coordinates: [[[-120, 37], [-119.99, 37], [-119.99, 37.01], [-120, 37]]]
  }
};

test('forwards boundary GeoJSON to FastAPI', async () => {
  let forwarded;
  const handler = createPredictionHandler({
    serviceUrl: 'http://ml:8000',
    client: {
    post: async (target, body, options) => {
      forwarded = { target, body, options };
      return { data: { type: 'Feature', geometry: body.geometry, properties: {} } };
    }
  }});
  const res = response();

  await handler({ body: boundary }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.type, 'Feature');
  assert.equal(forwarded.target, 'http://ml:8000/predict');
  assert.deepEqual(forwarded.body, boundary);
  assert.equal(forwarded.options.timeout, 20_000);
});

test('rejects point-only prediction input without calling FastAPI', async () => {
  let called = false;
  const handler = createPredictionHandler({
    serviceUrl: 'http://ml:8000', client: { post: async () => { called = true; } }
  });
  const res = response();

  await handler({
    body: { type: 'Feature', geometry: { type: 'Point', coordinates: [-120, 37] } }
  }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('returns 502 when FastAPI is unavailable', async () => {
  const handler = createPredictionHandler({
    serviceUrl: 'http://ml:8000',
    client: { post: async () => { throw new Error('connection refused'); } }
  });
  const res = response();

  await handler({ body: boundary }, res);

  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { error: 'Prediction service is unavailable' });
});
