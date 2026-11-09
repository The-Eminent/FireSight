const test = require('node:test');
const assert = require('node:assert/strict');
const { clustersFromLabels } = require('./densityClustering');

test('groups DBSCAN labels and ignores noise points', () => {
  const observations = ['one', 'two', 'noise', 'three'];
  assert.deepEqual(clustersFromLabels(observations, [0, 0, -1, 1]), [
    ['one', 'two'],
    ['three']
  ]);
});
