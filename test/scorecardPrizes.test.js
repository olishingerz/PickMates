const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeScorecardPrizeSplit } = require('../src/services/scorecardPrizes');

test('team format: 50/40/10 split, CTP as the remainder', () => {
  const split = computeScorecardPrizeSplit(10, 9, 'team'); // pot = 90
  assert.equal(split.pot, 90);
  assert.equal(split.teamPrize, 45);
  assert.equal(split.indivPrize, 36);
  assert.equal(split.ctpPrize, 9);
  assert.equal(split.teamPrize + split.indivPrize + split.ctpPrize, split.pot, 'the three parts always sum to the pot');
});

test('individual format: 70/30 split, no team prize', () => {
  const split = computeScorecardPrizeSplit(10, 9, 'individual'); // pot = 90
  assert.equal(split.pot, 90);
  assert.equal(split.teamPrize, 0);
  assert.equal(split.indivPrize, 63);
  assert.equal(split.ctpPrize, 27);
  assert.equal(split.indivPrize + split.ctpPrize, split.pot, 'the two parts always sum to the pot');
});

test('rounding: parts still sum exactly to the pot even when percentages do not divide evenly', () => {
  const split = computeScorecardPrizeSplit(7, 5, 'team'); // pot = 35
  assert.equal(split.pot, 35);
  assert.equal(split.teamPrize + split.indivPrize + split.ctpPrize, 35);
});

test('zero entry fee or zero players gives an all-zero split, not NaN', () => {
  assert.deepEqual(computeScorecardPrizeSplit(0, 9, 'team'), { pot: 0, teamPrize: 0, indivPrize: 0, ctpPrize: 0 });
  assert.deepEqual(computeScorecardPrizeSplit(10, 0, 'team'), { pot: 0, teamPrize: 0, indivPrize: 0, ctpPrize: 0 });
});
