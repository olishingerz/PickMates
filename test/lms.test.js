const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeLmsStandings } = require('../src/routes/lms');

test('locked week: pick that lost eliminates the player', () => {
  const participants = [{ user_id: 1, username: 'alice' }, { user_id: 2, username: 'bob' }];
  const weeks = [{ week_number: 1, results_locked: true, deadline: null }];
  const allPicks = [
    { user_id: 1, week_number: 1, result: 'win' },
    { user_id: 2, week_number: 1, result: 'loss' },
  ];
  const standings = computeLmsStandings(participants, allPicks, weeks, 1, weeks[0]);

  assert.equal(standings.find(s => s.user_id === 1).eliminated, false);
  const bob = standings.find(s => s.user_id === 2);
  assert.equal(bob.eliminated, true);
  assert.equal(bob.eliminatedWeek, 1);
  assert.equal(bob.eliminatedReason, 'loss');
});

test('locked week: no pick submitted eliminates the player', () => {
  const participants = [{ user_id: 2, username: 'bob' }];
  const weeks = [{ week_number: 1, results_locked: true, deadline: null }];
  const standings = computeLmsStandings(participants, [], weeks, 1, weeks[0]);

  const bob = standings[0];
  assert.equal(bob.eliminated, true);
  assert.equal(bob.eliminatedReason, 'no_pick');
});

test('unlocked current week: own match already graded as a loss eliminates immediately (regression for the bug where status stayed "alive" until the whole round locked)', () => {
  const participants = [{ user_id: 1, username: 'alice' }];
  const weeks = [{ week_number: 2, results_locked: false, deadline: new Date(Date.now() + 86400000) }];
  const allPicks = [{ user_id: 1, week_number: 2, result: 'loss' }];
  const standings = computeLmsStandings(participants, allPicks, weeks, 2, weeks[0]);

  const alice = standings[0];
  assert.equal(alice.eliminated, true);
  assert.equal(alice.eliminatedWeek, 2);
  assert.equal(alice.eliminatedReason, 'loss');
});

test('unlocked current week: pick still pending (match not finished) keeps player alive', () => {
  const participants = [{ user_id: 1, username: 'alice' }];
  const weeks = [{ week_number: 2, results_locked: false, deadline: new Date(Date.now() + 86400000) }];
  const allPicks = [{ user_id: 1, week_number: 2, result: 'pending' }];
  const standings = computeLmsStandings(participants, allPicks, weeks, 2, weeks[0]);

  assert.equal(standings[0].eliminated, false);
});

test('unlocked current week: deadline passed with no pick eliminates the player', () => {
  const participants = [{ user_id: 1, username: 'alice' }];
  const weeks = [{ week_number: 2, results_locked: false, deadline: new Date(Date.now() - 1000) }];
  const standings = computeLmsStandings(participants, [], weeks, 2, weeks[0]);

  const alice = standings[0];
  assert.equal(alice.eliminated, true);
  assert.equal(alice.eliminatedReason, 'no_pick');
});

test('survivor of a locked week who has not yet picked the new unlocked week stays alive', () => {
  const participants = [{ user_id: 1, username: 'alice' }];
  const weeks = [
    { week_number: 1, results_locked: true, deadline: null },
    { week_number: 2, results_locked: false, deadline: new Date(Date.now() + 86400000) },
  ];
  const allPicks = [{ user_id: 1, week_number: 1, result: 'win' }];
  const standings = computeLmsStandings(participants, allPicks, weeks, 2, weeks[1]);

  assert.equal(standings[0].eliminated, false);
});

test('locked week: a postponed fixture survives automatically (not a win, loss, or draw)', () => {
  const participants = [{ user_id: 1, username: 'alice' }];
  const weeks = [{ week_number: 1, results_locked: true, deadline: null }];
  const allPicks = [{ user_id: 1, week_number: 1, result: 'postponed' }];
  const standings = computeLmsStandings(participants, allPicks, weeks, 1, weeks[0]);

  assert.equal(standings[0].eliminated, false);
});

test('skipped week (round shrunk to <=5 fixtures): nobody is eliminated even with a genuine loss recorded', () => {
  const participants = [{ user_id: 1, username: 'alice' }, { user_id: 2, username: 'bob' }];
  const weeks = [{ week_number: 1, results_locked: true, skipped: true, deadline: null }];
  const allPicks = [
    { user_id: 1, week_number: 1, result: 'loss' },
    // bob didn't even pick — also shouldn't be eliminated for it in a skipped week
  ];
  const standings = computeLmsStandings(participants, allPicks, weeks, 1, weeks[0]);

  assert.equal(standings.find(s => s.user_id === 1).eliminated, false);
  assert.equal(standings.find(s => s.user_id === 2).eliminated, false);
});

test('skipped week does not block elimination in a later, non-skipped week', () => {
  const participants = [{ user_id: 1, username: 'alice' }];
  const weeks = [
    { week_number: 1, results_locked: true, skipped: true, deadline: null },
    { week_number: 2, results_locked: true, skipped: false, deadline: null },
  ];
  const allPicks = [
    { user_id: 1, week_number: 1, result: 'loss' },
    { user_id: 1, week_number: 2, result: 'loss' },
  ];
  const standings = computeLmsStandings(participants, allPicks, weeks, 2, weeks[1]);

  const alice = standings[0];
  assert.equal(alice.eliminated, true);
  assert.equal(alice.eliminatedWeek, 2);
});
