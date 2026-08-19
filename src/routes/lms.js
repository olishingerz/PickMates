const express = require('express');
const { pool } = require('../db');
const { getCurrentGameweekFixtures, processResults, LEAGUE_NAMES } = require('../services/football');

const router = express.Router({ mergeParams: true });

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
  const { rows } = await pool.query(
    'SELECT is_co_host FROM game_participants WHERE game_id = $1 AND user_id = $2',
    [gameId, req.session.user.id]
  );
  return rows[0]?.is_co_host === true;
}

// Fetch the pickable team list from ESPN once and store it for this round, so the
// picks page doesn't hit ESPN live on every view. Called when a round starts,
// auto-restarts, or advances to a new week — never on a plain page load.
async function refreshFixtureCache(gameId, week) {
  const { rows } = await pool.query('SELECT lms_leagues FROM games WHERE id = $1', [gameId]);
  const leagues = (rows[0]?.lms_leagues || 'eng.1').split(',').map(s => s.trim()).filter(Boolean);
  const { fixtures } = await getCurrentGameweekFixtures(leagues);
  await pool.query(
    `INSERT INTO lms_weeks (game_id, week_number, fixtures_cache)
     VALUES ($1,$2,$3)
     ON CONFLICT (game_id, week_number) DO UPDATE SET fixtures_cache=$3`,
    [gameId, week, JSON.stringify(fixtures)]
  );
  return fixtures;
}

async function getLmsData(gameId, userId) {
  const [gameRes, participantsRes, weeksRes, picksRes] = await Promise.all([
    pool.query(`
      SELECT g.id, g.name, g.lms_leagues, g.lms_current_week, g.is_complete, g.is_started, g.tournament_complete,
             g.host_user_id, g.invite_code, g.prize_individual, g.lms_continuous, hu.username AS host_username
      FROM games g
      LEFT JOIN users hu ON hu.id = g.host_user_id
      WHERE g.id = $1
    `, [gameId]),
    pool.query(`
      SELECT u.id AS user_id, u.username, gp.draft_position, gp.team_name, gp.is_co_host
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = $1
      ORDER BY gp.draft_position ASC NULLS LAST, u.username ASC
    `, [gameId]),
    pool.query(
      'SELECT * FROM lms_weeks WHERE game_id=$1 ORDER BY week_number ASC',
      [gameId]
    ),
    pool.query(
      'SELECT * FROM lms_picks WHERE game_id=$1 ORDER BY week_number ASC',
      [gameId]
    ),
  ]);

  const game        = gameRes.rows[0];
  const participants = participantsRes.rows;
  const weeks       = weeksRes.rows;
  const allPicks    = picksRes.rows;
  const currentWeek = game?.lms_current_week || 1;
  const weekObj     = weeks.find(w => w.week_number === currentWeek) || null;

  // Build per-participant pick history and alive status
  const standings = participants.map(p => {
    const picks = allPicks.filter(pk => pk.user_id === p.user_id);
    let eliminated     = false;
    let eliminatedWeek = null;
    let eliminatedReason = null; // 'no_pick' | 'loss' | 'draw'

    for (const w of weeks.filter(w => w.results_locked)) {
      const pick = picks.find(pk => pk.week_number === w.week_number);
      if (!pick || pick.result === 'loss' || pick.result === 'draw') {
        eliminated       = true;
        eliminatedWeek   = w.week_number;
        eliminatedReason = !pick ? 'no_pick' : pick.result;
        break;
      }
    }

    // Current week's deadline passed with no pick submitted — auto-eliminated,
    // even before the host processes results for that week.
    if (!eliminated && weekObj && !weekObj.results_locked && weekObj.deadline
        && new Date() > new Date(weekObj.deadline)
        && !picks.some(pk => pk.week_number === currentWeek)) {
      eliminated       = true;
      eliminatedWeek   = currentWeek;
      eliminatedReason = 'no_pick';
    }

    const myCurrentPick = picks.find(pk => pk.week_number === currentWeek) || null;
    return { ...p, picks, eliminated, eliminatedWeek, eliminatedReason, myCurrentPick };
  });

  // Teams already picked by current user across all weeks
  const myPicks  = allPicks.filter(pk => pk.user_id === userId);
  const usedTeamIds = new Set(myPicks.map(pk => pk.team_id));
  const myCurrentPick = myPicks.find(pk => pk.week_number === currentWeek) || null;

  const leagues = (game?.lms_leagues || 'eng.1').split(',').map(s => s.trim()).filter(Boolean);

  return { game, participants, weeks, allPicks, standings, currentWeek, weekObj, leagues, usedTeamIds, myCurrentPick };
}

// GET /game/:gameId/lms/picks — pick submission form
router.get('/picks', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  try {
    const data    = await getLmsData(gameId, req.session.user.id);
    const hostFlag = await canManage(req, gameId);
    if (!data.game) return res.redirect('/');
    if (!data.game.is_started) {
      return res.redirect(`/game/${gameId}?error=` + encodeURIComponent("The host hasn't started the game yet."));
    }

    // Use the fixture list cached at round-start; only hit ESPN live if that
    // fetch never happened (e.g. it failed) — this also re-populates the cache.
    let fixtures = data.weekObj?.fixtures_cache || [];
    if (fixtures.length === 0) {
      try { fixtures = await refreshFixtureCache(gameId, data.currentWeek); }
      catch (err) { console.warn('[lms picks] fixture fetch failed:', err.message); }
    }

    // Filter out teams already used by this player
    const availableFixtures = fixtures.map(f => ({
      ...f,
      homeAvailable: !data.usedTeamIds.has(f.homeTeam.id),
      awayAvailable: !data.usedTeamIds.has(f.awayTeam.id),
    }));

    res.render('lms-picks', {
      ...data,
      fixtures: availableFixtures,
      isHost: hostFlag,
      LEAGUE_NAMES,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[lms picks GET]', err);
    res.redirect(`/game/${gameId}`);
  }
});

// POST /game/:gameId/lms/picks — submit a pick
router.post('/picks', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const userId = req.session.user.id;
  const base   = `/game/${gameId}/lms/picks`;

  const { team_id, team_name } = req.body;
  if (!team_id || !team_name) {
    return res.redirect(base + '?error=' + encodeURIComponent('Please select a team.'));
  }

  try {
    const data = await getLmsData(gameId, userId);
    if (!data.game) return res.redirect('/');

    // Check the game has actually started
    if (!data.game.is_started) {
      return res.redirect(base + '?error=' + encodeURIComponent("The host hasn't started the game yet."));
    }

    // Check not already picked this week
    if (data.myCurrentPick) {
      return res.redirect(base + '?error=' + encodeURIComponent('You have already picked this week.'));
    }

    // Check deadline
    if (data.weekObj?.deadline && new Date() > new Date(data.weekObj.deadline)) {
      return res.redirect(base + '?error=' + encodeURIComponent('The deadline for this week has passed.'));
    }

    // Check results not locked
    if (data.weekObj?.results_locked) {
      return res.redirect(base + '?error=' + encodeURIComponent('Results for this week are already locked.'));
    }

    // Check not already used this team
    if (data.usedTeamIds.has(team_id)) {
      return res.redirect(base + '?error=' + encodeURIComponent(`You have already used ${team_name} this season.`));
    }

    await pool.query(
      'INSERT INTO lms_picks (game_id, user_id, week_number, team_id, team_name) VALUES ($1,$2,$3,$4,$5)',
      [gameId, userId, data.currentWeek, team_id, team_name]
    );
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent(`Pick submitted: ${team_name}`));
  } catch (err) {
    console.error('[lms picks POST]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to submit pick.'));
  }
});

// POST /game/:gameId/lms/set-deadline — host: set deadline for current week
router.post('/set-deadline', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await canManage(req, gameId)) return res.redirect(`/game/${gameId}`);

  const { deadline } = req.body;
  try {
    const { rows: game } = await pool.query('SELECT lms_current_week FROM games WHERE id=$1', [gameId]);
    const week = game[0]?.lms_current_week || 1;
    await pool.query(
      `INSERT INTO lms_weeks (game_id, week_number, deadline)
       VALUES ($1,$2,$3)
       ON CONFLICT (game_id, week_number) DO UPDATE SET deadline=$3`,
      [gameId, week, deadline || null]
    );
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent('Deadline saved.'));
  } catch (err) {
    console.error('[lms set-deadline]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to set deadline.'));
  }
});

// Wipe picks/weeks and send the game back to the lobby for a new round
async function resetToLobby(gameId) {
  await pool.query('DELETE FROM lms_picks WHERE game_id = $1', [gameId]);
  await pool.query('DELETE FROM lms_weeks WHERE game_id = $1', [gameId]);
  await pool.query(
    'UPDATE games SET is_started = FALSE, is_complete = FALSE, lms_current_week = 1 WHERE id = $1',
    [gameId]
  );
}

// Wipe picks/weeks but keep the game live at week 1 — used when continuous mode
// is on, so the host doesn't have to click Start Game again after every round
async function restartRound(gameId) {
  await pool.query('DELETE FROM lms_picks WHERE game_id = $1', [gameId]);
  await pool.query('DELETE FROM lms_weeks WHERE game_id = $1', [gameId]);
  await pool.query(
    'UPDATE games SET is_complete = FALSE, lms_current_week = 1 WHERE id = $1',
    [gameId]
  );
  try { await refreshFixtureCache(gameId, 1); }
  catch (err) { console.warn(`[lms] fixture cache refresh failed on restart for game ${gameId}:`, err.message); }
}

// Fetch ESPN results, lock the week, and resolve the game if it concluded (winner or
// rollover). Shared by the host's manual button and the auto-process cron.
async function processGameResults(gameId) {
  const { rows: game } = await pool.query('SELECT lms_current_week, prize_individual, lms_continuous, lms_leagues FROM games WHERE id=$1', [gameId]);
  const week = game[0]?.lms_current_week || 1;
  const continuous = game[0]?.lms_continuous === true;
  const leagues = (game[0]?.lms_leagues || 'eng.1').split(',').map(s => s.trim()).filter(Boolean);
  const { fixtures } = await getCurrentGameweekFixtures(leagues);
  const { updated } = await processResults(pool, gameId, week, fixtures);

  // Lock results for this week
  await pool.query(
    `INSERT INTO lms_weeks (game_id, week_number, results_locked)
     VALUES ($1,$2,TRUE)
     ON CONFLICT (game_id, week_number) DO UPDATE SET results_locked=TRUE`,
    [gameId, week]
  );

  // Check whether this result locks the game: exactly one survivor wins,
  // zero survivors is a rollover (prize carries over, doubled).
  const data  = await getLmsData(gameId, null);
  const alive = data.standings.filter(s => !s.eliminated);

  if (data.standings.length > 0 && alive.length === 1) {
    const winner = alive[0];
    await pool.query(
      `INSERT INTO lms_winners (game_id, user_id, username, is_rollover, final_week, prize_amount)
       VALUES ($1,$2,$3,FALSE,$4,$5)`,
      [gameId, winner.user_id, winner.username, week, game[0]?.prize_individual || 0]
    );
    if (continuous) {
      await restartRound(gameId);
      return { week, updated, concluded: 'winner', continuous: true,
        message: `🏆 ${winner.username} won! A new round has started automatically — Week 1.` };
    }
    await resetToLobby(gameId);
    return { week, updated, concluded: 'winner', continuous: false,
      message: `🏆 ${winner.username} won! The game is back in the lobby — add players and start again when ready.` };
  }

  if (data.standings.length > 0 && alive.length === 0) {
    const oldPrize = parseFloat(game[0]?.prize_individual) || 0;
    const newPrize = oldPrize * 2;
    await pool.query('UPDATE games SET prize_individual = $1 WHERE id = $2', [newPrize, gameId]);
    await pool.query(
      `INSERT INTO lms_winners (game_id, user_id, username, is_rollover, final_week, prize_amount)
       VALUES ($1,NULL,NULL,TRUE,$2,$3)`,
      [gameId, week, newPrize]
    );
    if (continuous) {
      await restartRound(gameId);
      return { week, updated, concluded: 'rollover', continuous: true,
        message: `😱 Everyone was eliminated in week ${week} — rollover! Prize is now £${newPrize}. A new round has started automatically — Week 1.` };
    }
    await resetToLobby(gameId);
    return { week, updated, concluded: 'rollover', continuous: false,
      message: `😱 Everyone was eliminated in week ${week} — rollover! Prize is now £${newPrize}. The game is back in the lobby — start again when ready.` };
  }

  return { week, updated, concluded: null, continuous,
    message: `Results processed for week ${week} — ${updated} picks updated.` };
}

// POST /game/:gameId/lms/process-results — host: fetch ESPN results and mark wins/losses
router.post('/process-results', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await canManage(req, gameId)) return res.redirect(`/game/${gameId}`);

  try {
    const result = await processGameResults(gameId);
    const base = (result.concluded && !result.continuous) ? `/game/${gameId}/draft` : `/game/${gameId}`;
    res.redirect(`${base}?success=` + encodeURIComponent(result.message));
  } catch (err) {
    console.error('[lms process-results]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to process results.'));
  }
});

// POST /game/:gameId/lms/stop — host: turn off continuous auto-restart.
// The round in progress still plays out normally; once it concludes the game
// returns to the lobby instead of starting another round automatically.
router.post('/stop', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await canManage(req, gameId)) return res.redirect(`/game/${gameId}`);

  try {
    await pool.query('UPDATE games SET lms_continuous = FALSE WHERE id = $1', [gameId]);
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent('Auto-restart turned off — the game will return to the lobby once this round ends.'));
  } catch (err) {
    console.error('[lms stop]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to stop auto-restart.'));
  }
});

// POST /game/:gameId/lms/advance-week — host: move to next week
router.post('/advance-week', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await canManage(req, gameId)) return res.redirect(`/game/${gameId}`);

  try {
    const { rows: game } = await pool.query('SELECT lms_current_week FROM games WHERE id=$1', [gameId]);
    const nextWeek = (game[0]?.lms_current_week || 1) + 1;
    await pool.query('UPDATE games SET lms_current_week=$1 WHERE id=$2', [nextWeek, gameId]);
    try { await refreshFixtureCache(gameId, nextWeek); }
    catch (err) { console.warn(`[lms] fixture cache refresh failed on advance-week for game ${gameId}:`, err.message); }
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent(`Advanced to week ${nextWeek}.`));
  } catch (err) {
    console.error('[lms advance-week]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to advance week.'));
  }
});

// POST /game/:gameId/lms/override-result — host: manually set a pick result
router.post('/override-result', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await canManage(req, gameId)) return res.redirect(`/game/${gameId}`);

  const { pick_id, result } = req.body;
  if (!pick_id || !['win','loss','draw','pending'].includes(result)) {
    return res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Invalid override.'));
  }
  try {
    await pool.query('UPDATE lms_picks SET result=$1 WHERE id=$2 AND game_id=$3', [result, pick_id, gameId]);
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent('Result updated.'));
  } catch (err) {
    console.error('[lms override-result]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to update result.'));
  }
});

module.exports = { router, getLmsData, isHost, canManage, processGameResults, refreshFixtureCache };
