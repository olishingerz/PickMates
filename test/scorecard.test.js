const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stablefordPoints } = require('../src/routes/scorecard');

test('net par scores 2 points', () => {
  // handicap 9, stroke index 5 (<=9 so gets 1 shot): strokes 5, net 4 = par
  assert.equal(stablefordPoints(5, 4, 5, 9), 2);
});

test('a shot receives no stroke on a hard hole outside the handicap allowance', () => {
  // handicap 9, stroke index 15 (>9 so no shot): strokes 5, net 5, par 4 -> net bogey = 1 point
  assert.equal(stablefordPoints(5, 4, 15, 9), 1);
});

test('score floors at 0 rather than going negative', () => {
  assert.equal(stablefordPoints(8, 4, 15, 9), 0);
});

test('missing strokes (hole not played) returns null, not 0', () => {
  assert.equal(stablefordPoints(null, 4, 5, 9), null);
});

test('high handicap gives two shots on the lowest-index holes', () => {
  // handicap 25: floor(25/18)=1 base shot everywhere, plus a 2nd shot on stroke index <= 7
  assert.equal(stablefordPoints(6, 4, 3, 25), 2); // net = 6-2 = 4 = par
});
