const { pool } = require('../db');

// Fire-and-forget by design — a failed activity log write should never break
// the action that triggered it (a pick, a join, a result). Same pattern as
// the fixture-cache refresh calls elsewhere: awaited so callers can `await`
// it if they want ordering, but errors are only warned, never thrown.
async function logActivity(gameId, message) {
  try {
    await pool.query('INSERT INTO activity_log (game_id, message) VALUES ($1, $2)', [gameId, message]);
  } catch (err) {
    console.warn('[activity] failed to log:', err.message);
  }
}

module.exports = { logActivity };
