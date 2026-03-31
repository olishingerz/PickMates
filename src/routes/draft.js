const express = require('express');
const { pool } = require('../db');
const { MAX_PLAYERS, PICKS_PER_PLAYER } = require('../constants');

const router = express.Router();

// Generates the full snake pick order as an array of draft positions (1-based).
// e.g. 6 players, 6 picks → [1,2,3,4,5,6, 6,5,4,3,2,1, 1,2,3,4,5,6, ...]
function generateSnakeOrder(numPlayers, picksEach) {
  const order = [];
  for (let round = 0; round < picksEach; round++) {
    const positions = Array.from({ length: numPlayers }, (_, i) => i + 1);
    if (round % 2 === 1) positions.reverse();
    order.push(...positions);
  }
  return order;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  next();
}

async function getDraftData(userId) {
  const [participantsRes, picksRes, stateRes, lbRes] = await Promise.all([
    pool.query('SELECT id, username, draft_position FROM users WHERE draft_position IS NOT NULL ORDER BY draft_position'),
    pool.query(`
      SELECT p.id, p.user_id, p.player_name, p.pick_slot, p.created_at,
             u.username, u.draft_position
      FROM picks p
      JOIN users u ON u.id = p.user_id
      ORDER BY p.id ASC
    `),
    pool.query('SELECT * FROM draft_state WHERE id = 1'),
    pool.query('SELECT player_name FROM leaderboard ORDER BY position ASC NULLS LAST'),
  ]);

  const participants  = participantsRes.rows;
  const allPicks      = picksRes.rows;
  const state         = stateRes.rows[0] || { current_pick_index: 0, is_complete: false };
  const lbPlayers     = lbRes.rows.map(r => r.player_name);

  const numPlayers    = participants.length;
  const snakeOrder    = generateSnakeOrder(numPlayers, PICKS_PER_PLAYER);
  const totalPicks    = numPlayers * PICKS_PER_PLAYER;

  // Whose turn is it?
  let currentTurnPos  = null;
  let currentTurnUser = null;
  let isMyTurn        = false;

  if (!state.is_complete && state.current_pick_index < snakeOrder.length && numPlayers >= MAX_PLAYERS) {
    currentTurnPos  = snakeOrder[state.current_pick_index];
    currentTurnUser = participants.find(p => p.draft_position === currentTurnPos) || null;
    isMyTurn        = currentTurnUser?.id === userId;
  }

  // Taken players set
  const takenSet = new Set(allPicks.map(p => p.player_name.toLowerCase()));

  // Available players (from leaderboard, minus taken)
  const available = lbPlayers.filter(name => !takenSet.has(name.toLowerCase()));

  // Build the draft board: one row per "pick number" (1–PICKS_PER_PLAYER),
  // one column per draft position
  const board = Array.from({ length: PICKS_PER_PLAYER }, (_, pickRound) =>
    Array.from({ length: numPlayers }, (_, posIdx) => {
      const globalIdx = pickRound * numPlayers + posIdx;
      const draftPos  = snakeOrder[globalIdx];
      const user      = participants.find(p => p.draft_position === draftPos);
      const pick      = allPicks[globalIdx] || null;
      return {
        globalIdx,
        draftPos,
        user,
        pick,
        isCurrent: globalIdx === state.current_pick_index && !state.is_complete,
      };
    })
  );

  // Each user's squad so far
  const squads = participants.map(p => ({
    ...p,
    picks: allPicks
      .filter(pick => pick.user_id === p.id)
      .sort((a, b) => a.pick_slot - b.pick_slot),
  }));

  const draftNotStarted = numPlayers < MAX_PLAYERS;
  const picksRemaining  = Math.max(0, totalPicks - state.current_pick_index);
  const draftRound      = state.current_pick_index < snakeOrder.length
    ? Math.floor(state.current_pick_index / Math.max(numPlayers, 1)) + 1
    : PICKS_PER_PLAYER;

  return {
    participants,
    allPicks,
    state,
    snakeOrder,
    currentTurnUser,
    isMyTurn,
    board,
    squads,
    available,
    takenSet,
    draftNotStarted,
    picksRemaining,
    draftRound,
    MAX_PLAYERS,
    PICKS_PER_PLAYER,
  };
}

// GET /draft
router.get('/', requireAuth, async (req, res) => {
  try {
    const data = await getDraftData(req.session.user.id);
    res.render('draft', {
      ...data,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[draft GET]', err);
    res.redirect('/');
  }
});

// POST /draft — make a pick
router.post('/', requireAuth, async (req, res) => {
  const playerName = req.body.player_name?.trim();

  if (!playerName || playerName.length < 2) {
    return res.redirect('/draft?error=' + encodeURIComponent('Please enter a valid player name.'));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load state inside transaction for consistency
    const { rows: participants } = await client.query(
      'SELECT id, username, draft_position FROM users WHERE draft_position IS NOT NULL ORDER BY draft_position'
    );
    const { rows: stateRows } = await client.query('SELECT * FROM draft_state WHERE id = 1');
    const state = stateRows[0];

    if (!state || state.is_complete) {
      await client.query('ROLLBACK');
      return res.redirect('/draft?error=' + encodeURIComponent('The draft is already complete.'));
    }

    if (participants.length < MAX_PLAYERS) {
      await client.query('ROLLBACK');
      return res.redirect('/draft?error=' + encodeURIComponent('Waiting for all players to register before drafting.'));
    }

    const snakeOrder     = generateSnakeOrder(participants.length, PICKS_PER_PLAYER);
    const currentDraftPos = snakeOrder[state.current_pick_index];
    const currentUser    = participants.find(p => p.draft_position === currentDraftPos);

    if (!currentUser || currentUser.id !== req.session.user.id) {
      await client.query('ROLLBACK');
      return res.redirect('/draft?error=' + encodeURIComponent("It's not your turn."));
    }

    // How many picks has this user already made? pick_slot = that + 1
    const { rows: myPickCount } = await client.query(
      'SELECT COUNT(*) AS cnt FROM picks WHERE user_id = $1',
      [req.session.user.id]
    );
    const pickSlot = parseInt(myPickCount[0].cnt) + 1;

    await client.query(
      'INSERT INTO picks (user_id, player_name, pick_slot) VALUES ($1, $2, $3)',
      [req.session.user.id, playerName, pickSlot]
    );

    const newIndex   = state.current_pick_index + 1;
    const isComplete = newIndex >= participants.length * PICKS_PER_PLAYER;
    await client.query(
      'UPDATE draft_state SET current_pick_index = $1, is_complete = $2 WHERE id = 1',
      [newIndex, isComplete]
    );

    await client.query('COMMIT');

    const msg = isComplete
      ? 'Draft complete! All squads are locked in.'
      : `Picked ${playerName}!`;
    res.redirect('/draft?success=' + encodeURIComponent(msg));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.redirect('/draft?error=' + encodeURIComponent(`${playerName} has already been picked by another team.`));
    }
    console.error('[draft POST]', err);
    res.redirect('/draft?error=' + encodeURIComponent('Something went wrong. Please try again.'));
  } finally {
    client.release();
  }
});

// POST /draft/reset — admin only, resets the entire draft
router.post('/reset', requireAuth, async (req, res) => {
  if (!req.session.user.isAdmin) return res.redirect('/draft');

  try {
    await pool.query('DELETE FROM picks');
    await pool.query('UPDATE draft_state SET current_pick_index = 0, is_complete = FALSE, started_at = NULL WHERE id = 1');
    res.redirect('/draft?success=' + encodeURIComponent('Draft has been reset.'));
  } catch (err) {
    console.error('[draft reset]', err);
    res.redirect('/draft?error=' + encodeURIComponent('Reset failed.'));
  }
});

// POST /draft/randomise — admin only, shuffles draft positions
router.post('/randomise', requireAuth, async (req, res) => {
  if (!req.session.user.isAdmin) return res.redirect('/draft');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Make sure draft hasn't started
    const { rows: state } = await client.query('SELECT current_pick_index FROM draft_state WHERE id = 1');
    if (state[0]?.current_pick_index > 0) {
      await client.query('ROLLBACK');
      return res.redirect('/draft?error=' + encodeURIComponent('Cannot randomise after the draft has started.'));
    }

    const { rows: participants } = await client.query(
      'SELECT id FROM users WHERE draft_position IS NOT NULL ORDER BY draft_position'
    );

    // Fisher-Yates shuffle of positions
    const positions = participants.map((_, i) => i + 1);
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }

    // Temporarily null out positions (to avoid unique constraint conflicts)
    for (const p of participants) {
      await client.query('UPDATE users SET draft_position = NULL WHERE id = $1', [p.id]);
    }
    for (let i = 0; i < participants.length; i++) {
      await client.query('UPDATE users SET draft_position = $1 WHERE id = $2', [positions[i], participants[i].id]);
    }

    await client.query('COMMIT');
    res.redirect('/draft?success=' + encodeURIComponent('Draft order randomised!'));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[draft randomise]', err);
    res.redirect('/draft?error=' + encodeURIComponent('Randomise failed.'));
  } finally {
    client.release();
  }
});

module.exports = router;
