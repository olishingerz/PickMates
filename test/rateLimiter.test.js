const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/services/rateLimiter');

test('a fresh key is never limited', () => {
  const limiter = createRateLimiter(3, 60000);
  assert.equal(limiter.isLimited('a'), false);
});

test('becomes limited once attempts reach the max', () => {
  const limiter = createRateLimiter(3, 60000);
  limiter.recordAttempt('a');
  limiter.recordAttempt('a');
  assert.equal(limiter.isLimited('a'), false, 'still under the limit after 2 of 3');
  limiter.recordAttempt('a');
  assert.equal(limiter.isLimited('a'), true, 'limited once the 3rd attempt is recorded');
});

test('keys are independent — hammering one key does not limit another', () => {
  const limiter = createRateLimiter(2, 60000);
  limiter.recordAttempt('attacker');
  limiter.recordAttempt('attacker');
  assert.equal(limiter.isLimited('attacker'), true);
  assert.equal(limiter.isLimited('real-user'), false);
});

test('reset() clears a key immediately, even mid-window', () => {
  const limiter = createRateLimiter(1, 60000);
  limiter.recordAttempt('a');
  assert.equal(limiter.isLimited('a'), true);
  limiter.reset('a');
  assert.equal(limiter.isLimited('a'), false);
});

test('the window expires and the key becomes unlimited again', async () => {
  const limiter = createRateLimiter(1, 20); // 20ms window
  limiter.recordAttempt('a');
  assert.equal(limiter.isLimited('a'), true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(limiter.isLimited('a'), false);
});

test('recording after the window expired starts a fresh window, not an accumulating count', async () => {
  const limiter = createRateLimiter(2, 20); // 20ms window
  limiter.recordAttempt('a');
  await new Promise(resolve => setTimeout(resolve, 40));
  limiter.recordAttempt('a'); // this should be attempt 1 of a new window, not attempt 2
  assert.equal(limiter.isLimited('a'), false);
});
