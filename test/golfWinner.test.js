const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pickGolfDraftWinners } = require('../src/services/golfWinner');

test('team winner is lowest sum of best 3 among players with 3+ cut makers', () => {
  const rows = [
    { username: 'alice', scores: [-5, -3, -2, -1], cut_makers: 4 },
    { username: 'bob',   scores: [-10, 1, 2],       cut_makers: 1 }, // best single score, but too few cut makers to count as a team
    { username: 'carol', scores: [-1, -1, -1],       cut_makers: 3 },
  ];
  const { teamWinner, indivWinner } = pickGolfDraftWinners(rows, 3);

  assert.equal(teamWinner, 'alice'); // -5-3-2 = -10, beats carol's -3
  assert.equal(indivWinner, 'bob');  // -10 is the single best score regardless of cut makers
});

test('no team winner when nobody has enough cut makers, individual winner still picked', () => {
  const rows = [
    { username: 'alice', scores: [-2], cut_makers: 1 },
    { username: 'bob',   scores: [-1], cut_makers: 1 },
  ];
  const { teamWinner, indivWinner } = pickGolfDraftWinners(rows, 3);

  assert.equal(teamWinner, null);
  assert.equal(indivWinner, 'alice');
});

test('players with no scores at all are ignored', () => {
  const rows = [
    { username: 'alice', scores: [], cut_makers: 0 },
    { username: 'bob',   scores: [-4, -2, -1], cut_makers: 3 },
  ];
  const { teamWinner, indivWinner } = pickGolfDraftWinners(rows, 3);

  assert.equal(teamWinner, 'bob');
  assert.equal(indivWinner, 'bob');
});
