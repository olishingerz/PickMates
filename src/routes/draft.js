const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { PICKS_PER_PLAYER } = require('../constants');
const { fetchTournamentList, scrapeLeaderboard } = require('../services/scraper');
const { sendDraftTurnEmail } = require('../services/email');

// mergeParams so we can read :gameId set by the parent router in games.js
const router = express.Router({ mergeParams: true });

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

function getGameId(req) {
  return parseInt(req.params.gameId);
}

async function isHost(req, gameId) {
  if (!req.session.user) return false;
  if (req.session.user.isAdmin) return true;
  const { rows } = await pool.query('SELECT host_user_id FROM games WHERE id = $1', [gameId]);
  return rows[0]?.host_user_id === req.session.user.id;
}

async function getDraftData(userId, gameId) {
  const [participantsRes, picksRes, stateRes, lbRes] = await Promise.all([
    pool.query(`
      SELECT u.id, u.username, gp.draft_position, gp.team_name
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = $1
      ORDER BY gp.draft_position ASC NULLS LAST
    `, [gameId]),
    pool.query(`
      SELECT p.id, p.user_id, p.player_name, p.pick_slot, p.created_at,
             u.username, gp.draft_position
      FROM picks p
      JOIN users u ON u.id = p.user_id
      JOIN game_participants gp ON gp.user_id = p.user_id AND gp.game_id = p.game_id
      WHERE p.game_id = $1
      ORDER BY p.id ASC
    `, [gameId]),
    pool.query('SELECT id, name, tournament_id, tournament_name, current_pick_index, is_started, is_complete, player_source, game_type, invite_code FROM games WHERE id = $1', [gameId]),
    pool.query('SELECT player_name, world_rank FROM leaderboard WHERE game_id = $1 ORDER BY position ASC NULLS LAST, player_name ASC', [gameId]),
  ]);

  const participants = participantsRes.rows;
  const allPicks     = picksRes.rows;
  const state        = stateRes.rows[0] || { current_pick_index: 0, is_started: false, is_complete: false };
  const lbPlayers    = lbRes.rows; // [{ player_name, world_rank }, ...]
  const numPlayers   = participants.length;

  const snakeOrder = numPlayers > 0 ? generateSnakeOrder(numPlayers, PICKS_PER_PLAYER) : [];

  let currentTurnPos  = null;
  let currentTurnUser = null;
  let isMyTurn        = false;

  if (state.is_started && !state.is_complete && state.current_pick_index < snakeOrder.length) {
    currentTurnPos  = snakeOrder[state.current_pick_index];
    currentTurnUser = participants.find(p => p.draft_position === currentTurnPos) || null;
    isMyTurn        = currentTurnUser?.id === userId;
  }

  const takenSet  = new Set(allPicks.map(p => p.player_name.toLowerCase()));
  const available = lbPlayers.filter(p => !takenSet.has(p.player_name.toLowerCase()));

  // Board: one row per round, one column per player (always the same player per column).
  // For even rounds (forward 1→n) player at draft_position p picks at offset p-1.
  // For odd rounds (reverse n→1) player at draft_position p picks at offset n-p.
  const board = numPlayers > 0
    ? Array.from({ length: PICKS_PER_PLAYER }, (_, pickRound) =>
        participants.map(participant => {
          const p          = participant.draft_position; // 1-indexed
          const offsetInRound = pickRound % 2 === 0 ? p - 1 : numPlayers - p;
          const globalIdx  = pickRound * numPlayers + offsetInRound;
          const pick       = allPicks[globalIdx] || null;
          return {
            globalIdx,
            draftPos: participant.draft_position,
            user:     participant,
            pick,
            isCurrent: globalIdx === state.current_pick_index && state.is_started && !state.is_complete,
          };
        })
      )
    : [];

  const squads = participants.map(p => ({
    ...p,
    picks: allPicks.filter(pick => pick.user_id === p.id).sort((a, b) => a.pick_slot - b.pick_slot),
  }));

  return {
    gameId,
    participants, allPicks, state, snakeOrder, currentTurnUser, isMyTurn,
    board, squads, available, takenSet, PICKS_PER_PLAYER,
    playerSource: state.player_source || 'espn',
    playerListCount: lbPlayers.length,
    inviteCode: await (async () => {
      if (state.invite_code) return state.invite_code;
      // Generate one if missing (e.g. older game)
      const code = Math.random().toString(36).slice(2, 8).toUpperCase();
      await pool.query('UPDATE games SET invite_code = $1 WHERE id = $2 AND invite_code IS NULL', [code, gameId]);
      return code;
    })(),
    tournament: { id: state.tournament_id || null, name: state.tournament_name || null },
    draftRound: state.current_pick_index < snakeOrder.length
      ? Math.floor(state.current_pick_index / Math.max(numPlayers, 1)) + 1
      : PICKS_PER_PLAYER,
  };
}

// GET /game/:gameId/draft
router.get('/', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  try {
    const [data, hostFlag] = await Promise.all([
      getDraftData(req.session.user.id, gameId),
      isHost(req, gameId),
    ]);
    res.render('draft', {
      ...data,
      isHost:  hostFlag,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[draft GET]', err);
    res.redirect('/');
  }
});

// POST /game/:gameId/draft — make a pick
router.post('/', requireAuth, async (req, res) => {
  const gameId     = getGameId(req);
  const playerName = req.body.player_name?.trim();
  const base       = `/game/${gameId}/draft`;

  if (!playerName || playerName.length < 2) {
    return res.redirect(base + '?error=' + encodeURIComponent('Please enter a valid player name.'));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: participants } = await client.query(`
      SELECT u.id, u.username, gp.draft_position
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = $1
      ORDER BY gp.draft_position ASC
    `, [gameId]);

    const { rows: stateRows } = await client.query('SELECT * FROM games WHERE id = $1', [gameId]);
    const state = stateRows[0];

    if (!state?.is_started) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent('The draft has not started yet.'));
    }
    if (state.is_complete) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent('The draft is already complete.'));
    }

    const snakeOrder      = generateSnakeOrder(participants.length, PICKS_PER_PLAYER);
    const currentDraftPos = snakeOrder[state.current_pick_index];
    const currentUser     = participants.find(p => p.draft_position === currentDraftPos);

    const isAdminOverride = await isHost(req, gameId);
    if (!currentUser || (currentUser.id !== req.session.user.id && !isAdminOverride)) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent("It's not your turn."));
    }

    const pickingUserId = currentUser.id;

    const { rows: myPickCount } = await client.query(
      'SELECT COUNT(*) AS cnt FROM picks WHERE user_id = $1 AND game_id = $2',
      [pickingUserId, gameId]
    );
    const pickSlot = parseInt(myPickCount[0].cnt) + 1;

    await client.query(
      'INSERT INTO picks (game_id, user_id, player_name, pick_slot) VALUES ($1, $2, $3, $4)',
      [gameId, pickingUserId, playerName, pickSlot]
    );

    const newIndex   = state.current_pick_index + 1;
    const isComplete = newIndex >= participants.length * PICKS_PER_PLAYER;
    await client.query(
      'UPDATE games SET current_pick_index = $1, is_complete = $2 WHERE id = $3',
      [newIndex, isComplete, gameId]
    );

    await client.query('COMMIT');
    const msg = isComplete ? 'Draft complete! All squads locked in.' : `Picked ${playerName}!`;
    res.redirect(base + '?success=' + encodeURIComponent(msg));

    // After responding: email the next player (fire-and-forget)
    if (!isComplete) {
      const nextPos  = snakeOrder[newIndex];
      const nextUser = participants.find(p => p.draft_position === nextPos);
      if (nextUser) {
        pool.query('SELECT email FROM users WHERE id = $1', [nextUser.id])
          .then(r => {
            if (r.rows[0]?.email) {
              sendDraftTurnEmail(
                { email: r.rows[0].email, username: nextUser.username },
                { id: gameId, name: state.name }
              );
            }
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.redirect(base + '?error=' + encodeURIComponent(`${playerName} has already been picked.`));
    }
    console.error('[draft POST]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Something went wrong. Please try again.'));
  } finally {
    client.release();
  }
});

// POST /game/:gameId/draft/set-order — host: save a manually chosen pick order
router.post('/set-order', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  // ordered_ids is a comma-separated list of user IDs in desired draft order
  const ids = (req.body.ordered_ids || '')
    .split(',')
    .map(s => parseInt(s.trim()))
    .filter(n => !isNaN(n));

  if (ids.length === 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('No order provided.'));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: stateRows } = await client.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    if (stateRows[0]?.is_started) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent('Cannot change order after the draft has started.'));
    }

    // Null out first to avoid unique conflicts
    await client.query(
      'UPDATE game_participants SET draft_position = NULL WHERE game_id = $1',
      [gameId]
    );
    for (let i = 0; i < ids.length; i++) {
      await client.query(
        'UPDATE game_participants SET draft_position = $1 WHERE game_id = $2 AND user_id = $3',
        [i + 1, gameId, ids[i]]
      );
    }

    await client.query('COMMIT');
    res.redirect(base + '?success=' + encodeURIComponent('Draft order saved.'));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[set-order]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to save order.'));
  } finally {
    client.release();
  }
});

// POST /game/:gameId/draft/randomise
router.post('/randomise', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: stateRows } = await client.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    if (stateRows[0]?.is_started) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent('Cannot randomise after the draft has started.'));
    }

    const { rows: participants } = await client.query(
      'SELECT id FROM game_participants WHERE game_id = $1 ORDER BY draft_position ASC NULLS LAST',
      [gameId]
    );

    const positions = participants.map((_, i) => i + 1);
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }

    for (const p of participants) {
      await client.query(
        'UPDATE game_participants SET draft_position = NULL WHERE id = $1',
        [p.id]
      );
    }
    for (let i = 0; i < participants.length; i++) {
      await client.query(
        'UPDATE game_participants SET draft_position = $1 WHERE id = $2',
        [positions[i], participants[i].id]
      );
    }

    await client.query('COMMIT');
    res.redirect(base + '?success=' + encodeURIComponent('Draft order randomised!'));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[draft randomise]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Randomise failed.'));
  } finally {
    client.release();
  }
});

// POST /game/:gameId/draft/start
router.post('/start', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  try {
    const { rows: participants } = await pool.query(
      'SELECT id FROM game_participants WHERE game_id = $1',
      [gameId]
    );
    if (participants.length < 2) {
      return res.redirect(base + '?error=' + encodeURIComponent('Need at least 2 players to start the draft.'));
    }

    await pool.query(
      'UPDATE games SET is_started = TRUE, started_at = NOW() WHERE id = $1',
      [gameId]
    );
    res.redirect(base + '?success=' + encodeURIComponent(`Draft started with ${participants.length} players!`));
  } catch (err) {
    console.error('[draft start]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Could not start the draft.'));
  }
});

// POST /game/:gameId/draft/reset
router.post('/reset', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  try {
    await pool.query('DELETE FROM picks WHERE game_id = $1', [gameId]);
    await pool.query(
      'UPDATE games SET current_pick_index = 0, is_started = FALSE, is_complete = FALSE, started_at = NULL WHERE id = $1',
      [gameId]
    );
    res.redirect(base + '?success=' + encodeURIComponent('Draft has been reset.'));
  } catch (err) {
    console.error('[draft reset]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Reset failed.'));
  }
});

// POST /game/:gameId/draft/add-user
router.post('/add-user', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  const username = req.body.username?.trim();
  if (!username || username.length < 2 || username.length > 50) {
    return res.redirect(base + '?error=' + encodeURIComponent('Username must be between 2 and 50 characters.'));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: stateRows } = await client.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    if (stateRows[0]?.is_started) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent('Cannot add players after the draft has started.'));
    }

    // Create user account if they don't already exist
    let userId;
    let tempPassword = null;
    const { rows: existing } = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );
    if (existing.length > 0) {
      userId = existing[0].id;
    } else {
      // Generate a readable temp password: golf-XXXX
      const suffix = Math.random().toString(36).slice(2, 6);
      tempPassword = `golf-${suffix}`;
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      const { rows } = await client.query(
        'INSERT INTO users (username, password_hash, must_change_password) VALUES ($1, $2, TRUE) RETURNING id',
        [username, passwordHash]
      );
      userId = rows[0].id;
    }

    // Check not already in this game
    const { rows: alreadyIn } = await client.query(
      'SELECT id FROM game_participants WHERE game_id = $1 AND user_id = $2',
      [gameId, userId]
    );
    if (alreadyIn.length > 0) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent(`${username} is already in this game.`));
    }

    const { rows: taken } = await client.query(
      'SELECT COUNT(*) AS cnt FROM game_participants WHERE game_id = $1',
      [gameId]
    );
    const draftPosition = parseInt(taken[0].cnt) + 1;

    await client.query(
      'INSERT INTO game_participants (game_id, user_id, draft_position) VALUES ($1, $2, $3)',
      [gameId, userId, draftPosition]
    );
    await client.query('COMMIT');

    const msg = tempPassword
      ? `${username} added at position #${draftPosition}. Temp password: ${tempPassword}`
      : `${username} added at position #${draftPosition}.`;
    res.redirect(base + '?success=' + encodeURIComponent(msg));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.redirect(base + '?error=' + encodeURIComponent(`"${username}" is already taken.`));
    }
    console.error('[add-user]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to add player.'));
  } finally {
    client.release();
  }
});

// POST /game/:gameId/draft/remove-user — host: remove a player from the game pre-draft
router.post('/remove-user', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  const userId = parseInt(req.body.user_id);
  if (!userId) return res.redirect(base + '?error=' + encodeURIComponent('Invalid user.'));

  try {
    const { rows: stateRows } = await pool.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    if (stateRows[0]?.is_started) {
      return res.redirect(base + '?error=' + encodeURIComponent('Cannot remove players after the draft has started.'));
    }

    await pool.query(
      'DELETE FROM game_participants WHERE game_id = $1 AND user_id = $2',
      [gameId, userId]
    );
    res.redirect(base + '?success=' + encodeURIComponent('Player removed from game.'));
  } catch (err) {
    console.error('[remove-user]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to remove player.'));
  }
});

// POST /game/:gameId/draft/clear-scores — host: wipe all scores but keep player names
router.post('/clear-scores', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);
  try {
    await pool.query(
      'UPDATE leaderboard SET position=NULL, score_to_par=NULL, made_cut=NULL, thru=NULL, r1=NULL, r2=NULL, r3=NULL, r4=NULL, updated_at=NOW() WHERE game_id=$1',
      [gameId]
    );
    res.redirect(base + '?success=' + encodeURIComponent('Scores cleared — player list kept intact.'));
  } catch (err) {
    console.error('[clear-scores]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to clear scores.'));
  }
});

// POST /game/:gameId/draft/player-source — host: switch between espn and custom
router.post('/player-source', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  const source = req.body.player_source === 'custom' ? 'custom' : 'espn';
  try {
    await pool.query('UPDATE games SET player_source = $1 WHERE id = $2', [source, gameId]);
    res.redirect(base + '?success=' + encodeURIComponent(`Player source set to ${source === 'custom' ? 'custom list' : 'ESPN'}.`));
  } catch (err) {
    console.error('[player-source]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to update player source.'));
  }
});

// POST /game/:gameId/draft/player-list — host: load custom player list into leaderboard
router.post('/player-list', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  const raw = req.body.player_names || '';
  const names = raw
    .split('\n')
    .map(n => n.trim())
    .filter(n => n.length >= 2);

  if (names.length === 0) {
    return res.redirect(base + '?error=' + encodeURIComponent('No valid player names found.'));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE games SET player_source = $1 WHERE id = $2',
      ['custom', gameId]
    );
    await client.query('DELETE FROM leaderboard WHERE game_id = $1', [gameId]);
    for (const name of names) {
      await client.query(
        'INSERT INTO leaderboard (game_id, player_name) VALUES ($1, $2)',
        [gameId, name]
      );
    }
    await client.query('COMMIT');
    res.redirect(base + '?success=' + encodeURIComponent(`${names.length} players loaded from custom list.`));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[player-list]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to load player list.'));
  } finally {
    client.release();
  }
});

// GET /game/:gameId/draft/tournaments
router.get('/tournaments', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await isHost(req, gameId)) return res.redirect(`/game/${gameId}/draft`);
  try {
    const tournaments = await fetchTournamentList();
    res.render('tournaments', {
      gameId,
      tournaments,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[tournaments]', err);
    res.redirect(`/game/${gameId}/draft?error=` + encodeURIComponent('Could not load tournament list from ESPN.'));
  }
});

// POST /game/:gameId/draft/tournaments
router.post('/tournaments', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  const { tournament_id, tournament_name, tournament_start_date, tournament_end_date } = req.body;
  if (!tournament_id || !tournament_name) {
    return res.redirect(`${base}/tournaments?error=` + encodeURIComponent('Please select a tournament.'));
  }

  try {
    await pool.query(
      'UPDATE games SET tournament_id=$1, tournament_name=$2, tournament_start_date=$3, tournament_end_date=$4 WHERE id=$5',
      [tournament_id, tournament_name, tournament_start_date || null, tournament_end_date || null, gameId]
    );

    let playerCount = 0;
    try {
      const players = await scrapeLeaderboard(gameId);
      playerCount = players.length;
    } catch (err) {
      console.warn('[tournaments] Initial scrape failed:', err.message);
    }

    const msg = playerCount > 0
      ? `Tournament set: ${tournament_name} — ${playerCount} players loaded`
      : `Tournament set: ${tournament_name} — player list will load shortly`;
    res.redirect(base + '?success=' + encodeURIComponent(msg));
  } catch (err) {
    console.error('[tournaments POST]', err);
    res.redirect(`${base}/tournaments?error=` + encodeURIComponent('Failed to save tournament.'));
  }
});

// POST /game/:gameId/draft/team-name — player: set their own team name
router.post('/team-name', requireAuth, async (req, res) => {
  const gameId  = getGameId(req);
  const userId  = req.session.user.id;
  const rawName = req.body.team_name?.trim() || null;

  if (rawName && (rawName.length < 2 || rawName.length > 50)) {
    return res.redirect(`/game/${gameId}/draft?error=` + encodeURIComponent('Team name must be between 2 and 50 characters.'));
  }

  try {
    await pool.query(
      'UPDATE game_participants SET team_name = $1 WHERE game_id = $2 AND user_id = $3',
      [rawName, gameId, userId]
    );
    const msg = rawName ? `Team name set to "${rawName}"!` : 'Team name cleared.';
    res.redirect(`/game/${gameId}/draft?success=` + encodeURIComponent(msg));
  } catch (err) {
    console.error('[team-name]', err);
    res.redirect(`/game/${gameId}/draft?error=` + encodeURIComponent('Failed to save team name.'));
  }
});

module.exports = router;
