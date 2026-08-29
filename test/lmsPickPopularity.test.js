const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computePickPopularity } = require('../src/routes/lms');

test('normal split: counts and percentages per team for the given week', () => {
  const picks = [
    { week_number: 1, team_name: 'Arsenal' },
    { week_number: 1, team_name: 'Arsenal' },
    { week_number: 1, team_name: 'Liverpool' },
    { week_number: 2, team_name: 'Chelsea' }, // different week — ignored
  ];
  const result = computePickPopularity(picks, 1);
  assert.deepEqual(result, [
    { team_name: 'Arsenal', count: 2, pct: 67 },
    { team_name: 'Liverpool', count: 1, pct: 33 },
  ]);
});

test('a tie keeps both teams, sorted by insertion order among equals', () => {
  const picks = [
    { week_number: 1, team_name: 'Arsenal' },
    { week_number: 1, team_name: 'Chelsea' },
  ];
  const result = computePickPopularity(picks, 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].count, 1);
  assert.equal(result[1].count, 1);
  assert.equal(result[0].pct, 50);
  assert.equal(result[1].pct, 50);
});

test('a week with no picks at all returns an empty array, not NaN percentages', () => {
  assert.deepEqual(computePickPopularity([], 1), []);
  assert.deepEqual(computePickPopularity([{ week_number: 2, team_name: 'Arsenal' }], 1), []);
});

test('a single pick is always 100%', () => {
  const result = computePickPopularity([{ week_number: 1, team_name: 'Arsenal' }], 1);
  assert.deepEqual(result, [{ team_name: 'Arsenal', count: 1, pct: 100 }]);
});
