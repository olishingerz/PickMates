const express = require('express');
const { pool } = require('../db');
const { fetchFixtures, processResults } = require('../services/football');

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

async function getLmsData(gameId, userId) {
  const [gameRes, participantsRes, weeksRes, picksRes] = await Promise.all([
    pool.query(
      'SELECT id, name, lms_leagues, lms_current_week, is_complete, is_started, tournament_complete, host_user_id, invite_code FROM games WHERE id = $1',
      [gameId]
    ),
    pool.query(`
      SELECT u.id AS user_id, u.username, gp.draft_position
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
    let eliminated    = false;
    let eliminatedWeek = null;

    for (const w of weeks.filter(w => w.results_locked)) {
      const pick = picks.find(pk => pk.week_number === w.week_number);
      if (!pick || pick.result === 'loss' || pick.result === 'draw') {
        eliminated     = true;
        eliminatedWeek = w.week_number;
        break;
      }
    }

    const myCurrentPick = picks.find(pk => pk.week_number === currentWeek) || null;
    return { ...p, picks, eliminated, eliminatedWeek, myCurrentPick };
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
    const hostFlag = await isHost(req, gameId);
    if (!data.game) return res.redirect('/');

    // Fetch live fixtures
    let fixtures = [];
    try { fixtures = await fetchFixtures(data.leagues); }
    catch (err) { console.warn('[lms picks] fixture fetch failed:', err.message); }

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
  if (!await isHost(req, gameId)) return res.redirect(`/game/${gameId}`);

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

// POST /game/:gameId/lms/process-results — host: fetch ESPN results and mark wins/losses
router.post('/process-results', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await isHost(req, gameId)) return res.redirect(`/game/${gameId}`);

  try {
    const { rows: game } = await pool.query('SELECT lms_current_week FROM games WHERE id=$1', [gameId]);
    const week = game[0]?.lms_current_week || 1;
    const { updated } = await processResults(pool, gameId, week);

    // Lock results for this week
    await pool.query(
      `INSERT INTO lms_weeks (game_id, week_number, results_locked)
       VALUES ($1,$2,TRUE)
       ON CONFLICT (game_id, week_number) DO UPDATE SET results_locked=TRUE`,
      [gameId, week]
    );

    res.redirect(`/game/${gameId}?success=` + encodeURIComponent(`Results processed for week ${week} — ${updated} picks updated.`));
  } catch (err) {
    console.error('[lms process-results]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to process results.'));
  }
});

// POST /game/:gameId/lms/advance-week — host: move to next week
router.post('/advance-week', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await isHost(req, gameId)) return res.redirect(`/game/${gameId}`);

  try {
    const { rows: game } = await pool.query('SELECT lms_current_week FROM games WHERE id=$1', [gameId]);
    const nextWeek = (game[0]?.lms_current_week || 1) + 1;
    await pool.query('UPDATE games SET lms_current_week=$1 WHERE id=$2', [nextWeek, gameId]);
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent(`Advanced to week ${nextWeek}.`));
  } catch (err) {
    console.error('[lms advance-week]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to advance week.'));
  }
});

// POST /game/:gameId/lms/override-result — host: manually set a pick result
router.post('/override-result', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  if (!await isHost(req, gameId)) return res.redirect(`/game/${gameId}`);

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

module.exports = { router, getLmsData, isHost };
