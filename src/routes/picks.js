const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// Masters 2026 first tee time — picks lock at this point
const PICKS_LOCK_DATE = new Date('2026-04-09T15:00:00Z');

function picksLocked() {
  return new Date() > PICKS_LOCK_DATE;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  next();
}

// GET /picks
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT player_name FROM picks WHERE user_id = $1',
      [req.session.user.id]
    );
    const currentPick = rows[0]?.player_name || null;

    // Get available players from the leaderboard (if already populated)
    const { rows: players } = await pool.query(
      'SELECT player_name FROM leaderboard ORDER BY position ASC NULLS LAST'
    );

    res.render('pick', {
      currentPick,
      players: players.map(p => p.player_name),
      locked: picksLocked(),
      lockDate: PICKS_LOCK_DATE,
      error: null,
      success: null,
    });
  } catch (err) {
    console.error(err);
    res.redirect('/');
  }
});

// POST /picks
router.post('/', requireAuth, async (req, res) => {
  if (picksLocked()) {
    return res.redirect('/picks');
  }

  const playerName = req.body.player_name?.trim();

  if (!playerName || playerName.length < 2) {
    return res.render('pick', {
      currentPick: null,
      players: [],
      locked: false,
      lockDate: PICKS_LOCK_DATE,
      error: 'Please enter a valid player name.',
      success: null,
    });
  }

  try {
    await pool.query(
      `INSERT INTO picks (user_id, player_name, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET player_name = $2, updated_at = NOW()`,
      [req.session.user.id, playerName]
    );

    const { rows: players } = await pool.query(
      'SELECT player_name FROM leaderboard ORDER BY position ASC NULLS LAST'
    );

    res.render('pick', {
      currentPick: playerName,
      players: players.map(p => p.player_name),
      locked: picksLocked(),
      lockDate: PICKS_LOCK_DATE,
      error: null,
      success: `Your pick has been saved: ${playerName}`,
    });
  } catch (err) {
    console.error(err);
    res.render('pick', {
      currentPick: null,
      players: [],
      locked: false,
      lockDate: PICKS_LOCK_DATE,
      error: 'Something went wrong. Please try again.',
      success: null,
    });
  }
});

module.exports = router;
