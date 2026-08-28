const { pool } = require('../db');

// Shared by every game-type route file (draft.js, lms.js, scorecard.js,
// games.js) — this used to be copy-pasted verbatim into each one, which let
// scorecard.js's canManage silently drift out of sync with the multi-entry
// fix applied to the other two (see the bool_or comment below).

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  next();
}

function getGameId(req) {
  return parseInt(req.params.gameId);
}

async function isHost(req, gameId) {
  if (!req.session.user) return false;
  if (req.session.user.isAdmin) return true;
  const { rows } = await pool.query('SELECT host_user_id FROM games WHERE id = $1', [gameId]);
  return rows[0]?.host_user_id === req.session.user.id;
}

// Host or co-host — can manage the game day-to-day, but not delete it (that's isHost-only)
async function canManage(req, gameId) {
  if (await isHost(req, gameId)) return true;
  if (!req.session.user) return false;
  // Aggregate rather than reading an arbitrary row — a user can hold multiple
  // entries (game_participants rows) in the same game (LMS today), and a
  // freshly added extra entry defaults to is_co_host=FALSE regardless of the
  // user's existing co-host status on their other entry.
  const { rows } = await pool.query(
    'SELECT bool_or(is_co_host) AS is_co_host FROM game_participants WHERE game_id = $1 AND user_id = $2',
    [gameId, req.session.user.id]
  );
  return rows[0]?.is_co_host === true;
}

module.exports = { requireAuth, getGameId, isHost, canManage };
