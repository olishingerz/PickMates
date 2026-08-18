const express = require('express');
const { pool } = require('../db');

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

// Net Stableford: 2 points for net par, +1 per shot better, -1 per shot worse, floored at 0
function strokesReceived(handicap, strokeIndex) {
  const h = Math.round(handicap || 0);
  return Math.floor(h / 18) + (strokeIndex <= (h % 18) ? 1 : 0);
}
function stablefordPoints(strokes, par, strokeIndex, handicap) {
  if (strokes === null || strokes === undefined) return null;
  const net = strokes - strokesReceived(handicap, strokeIndex);
  return Math.max(0, 2 - (net - par));
}

async function getScorecardData(gameId, userId) {
  const [gameRes, teamsRes, participantsRes, holesRes, scoresRes, ctpRes] = await Promise.all([
    pool.query(
      `SELECT id, name, game_type, is_started, tournament_complete, started_at, host_user_id, invite_code,
              scorecard_course_name, scorecard_course_par, scorecard_entry_fee, winner_username
       FROM games WHERE id = $1`,
      [gameId]
    ),
    pool.query('SELECT id, name FROM scorecard_teams WHERE game_id = $1 ORDER BY id ASC', [gameId]),
    pool.query(`
      SELECT gp.id AS participant_id, u.id AS user_id, u.username,
             gp.scorecard_team_id, gp.handicap, gp.is_captain, gp.is_co_host
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = $1
      ORDER BY u.username ASC
    `, [gameId]),
    pool.query('SELECT hole_number, par, stroke_index FROM scorecard_holes WHERE game_id = $1 ORDER BY hole_number ASC', [gameId]),
    pool.query('SELECT participant_id, hole_number, strokes FROM scorecard_scores WHERE game_id = $1', [gameId]),
    pool.query('SELECT hole_number, participant_id FROM scorecard_closest_to_pin WHERE game_id = $1', [gameId]),
  ]);

  const game         = gameRes.rows[0];
  const holes         = holesRes.rows;
  const participants   = participantsRes.rows;
  const scoresByParticipant = new Map();
  for (const s of scoresRes.rows) {
    if (!scoresByParticipant.has(s.participant_id)) scoresByParticipant.set(s.participant_id, new Map());
    scoresByParticipant.get(s.participant_id).set(s.hole_number, s.strokes);
  }

  const teamNameById = new Map(teamsRes.rows.map(t => [t.id, t.name]));

  const playersByTeam = new Map();
  const unassignedParticipants = [];
  const participantById = new Map();
  for (const p of participants) {
    const scores = scoresByParticipant.get(p.participant_id) || new Map();
    const holeScores = holes.map(h => {
      const strokes = scores.has(h.hole_number) ? scores.get(h.hole_number) : null;
      return {
        hole_number: h.hole_number,
        par: h.par,
        stroke_index: h.stroke_index,
        strokes,
        points: stablefordPoints(strokes, h.par, h.stroke_index, p.handicap),
      };
    });
    const player = { ...p, team_name: teamNameById.get(p.scorecard_team_id) || null, holeScores };
    participantById.set(p.participant_id, player);

    if (p.scorecard_team_id) {
      if (!playersByTeam.has(p.scorecard_team_id)) playersByTeam.set(p.scorecard_team_id, []);
      playersByTeam.get(p.scorecard_team_id).push(player);
    } else {
      unassignedParticipants.push(player);
    }
  }

  const teams = teamsRes.rows.map(t => {
    const players = playersByTeam.get(t.id) || [];
    const holeTotals = holes.map(h => {
      const pts = players
        .map(p => p.holeScores.find(hs => hs.hole_number === h.hole_number)?.points)
        .filter(v => v !== null && v !== undefined);
      return pts.length > 0 ? pts.reduce((s, v) => s + v, 0) : null;
    });
    const totalPoints = holeTotals.some(v => v !== null)
      ? holeTotals.reduce((s, v) => s + (v || 0), 0)
      : 0;
    const thru = holes.filter(h =>
      players.length > 0 && players.every(p => p.holeScores.find(hs => hs.hole_number === h.hole_number)?.strokes != null)
    ).length;
    return { ...t, players, holeTotals, totalPoints, thru };
  });

  const standings = [...teams].sort((a, b) => b.totalPoints - a.totalPoints);

  const ctpByHole = new Map(ctpRes.rows.map(r => [r.hole_number, r.participant_id]));
  const closestToPin = holes
    .filter(h => h.par === 3)
    .map(h => ({
      hole_number: h.hole_number,
      holder: participantById.get(ctpByHole.get(h.hole_number)) || null,
    }));

  const allParticipants = participants.map(p => participantById.get(p.participant_id));

  return { game, teams, standings, holes, unassignedParticipants, allParticipants, closestToPin, userId };
}

// Called from draft.js when game_type === 'golf_scorecard'
async function renderLobby(req, res, gameId) {
  try {
    const [data, hostFlag, manageFlag] = await Promise.all([
      getScorecardData(gameId, req.session.user.id),
      isHost(req, gameId),
      canManage(req, gameId),
    ]);
    if (!data.game) return res.redirect('/');

    if (data.game.is_started) {
      return res.redirect(`/game/${gameId}`);
    }

    // Unlike golf_draft/LMS, viewing this lobby is itself how a new player joins
    // (picking a team creates their game_participants row) — any logged-in user
    // may view it, not just existing participants.
    res.render('scorecard-lobby', {
      ...data,
      isHost: hostFlag,
      canManage: manageFlag,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[scorecard lobby]', err);
    res.redirect('/');
  }
}

// POST /game/:gameId/scorecard/join-team — join the game (if needed) and pick a team
router.post('/join-team', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const userId = req.session.user.id;
  const teamId = parseInt(req.body.team_id);
  const base = `/game/${gameId}/draft`;

  try {
    const { rows: gameRows } = await pool.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    if (!gameRows[0]) return res.redirect('/');
    if (gameRows[0].is_started) {
      return res.redirect(`/game/${gameId}?error=` + encodeURIComponent('The game has already started — teams are locked in.'));
    }

    const { rows: teamRows } = await pool.query('SELECT id FROM scorecard_teams WHERE id = $1 AND game_id = $2', [teamId, gameId]);
    if (!teamRows[0]) {
      return res.redirect(base + '?error=' + encodeURIComponent('Invalid team.'));
    }

    const { rows: existing } = await pool.query(
      'SELECT id FROM game_participants WHERE game_id = $1 AND user_id = $2',
      [gameId, userId]
    );
    if (existing[0]) {
      await pool.query('UPDATE game_participants SET scorecard_team_id = $1 WHERE id = $2', [teamId, existing[0].id]);
    } else {
      await pool.query(
        'INSERT INTO game_participants (game_id, user_id, scorecard_team_id) VALUES ($1, $2, $3)',
        [gameId, userId, teamId]
      );
    }
    res.redirect(base + '?success=' + encodeURIComponent("You've joined the team!"));
  } catch (err) {
    console.error('[scorecard join-team]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to join team.'));
  }
});

// POST /game/:gameId/scorecard/handicap — host/co-host: set a participant's handicap
router.post('/handicap', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}/draft`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  const participantId = parseInt(req.body.participant_id);
  const handicap = req.body.handicap === '' ? null : parseFloat(req.body.handicap);

  try {
    const { rows: gameRows } = await pool.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    if (gameRows[0]?.is_started) {
      return res.redirect(`/game/${gameId}?error=` + encodeURIComponent('The game has already started — handicaps are locked in.'));
    }
    if (handicap !== null && (isNaN(handicap) || handicap < 0 || handicap > 54)) {
      return res.redirect(base + '?error=' + encodeURIComponent('Handicap must be between 0 and 54.'));
    }
    await pool.query(
      'UPDATE game_participants SET handicap = $1 WHERE id = $2 AND game_id = $3',
      [handicap, participantId, gameId]
    );
    res.redirect(base + '?success=' + encodeURIComponent('Handicap saved.'));
  } catch (err) {
    console.error('[scorecard handicap]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to save handicap.'));
  }
});

// POST /game/:gameId/scorecard/captain — host/co-host: toggle captain status
router.post('/captain', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}/draft`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  const participantId = parseInt(req.body.participant_id);
  const make = req.body.make === '1';

  try {
    const { rows: gameRows } = await pool.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    if (gameRows[0]?.is_started) {
      return res.redirect(`/game/${gameId}?error=` + encodeURIComponent('The game has already started — captains are locked in.'));
    }
    await pool.query(
      'UPDATE game_participants SET is_captain = $1 WHERE id = $2 AND game_id = $3',
      [make, participantId, gameId]
    );
    res.redirect(base + '?success=' + encodeURIComponent(make ? 'Captain assigned.' : 'Captain removed.'));
  } catch (err) {
    console.error('[scorecard captain]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to update captain.'));
  }
});

// POST /game/:gameId/scorecard/start — host/co-host: lock teams/handicaps/captains and begin
router.post('/start', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}/draft`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  try {
    const { rows: unassigned } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_participants WHERE game_id = $1 AND scorecard_team_id IS NULL',
      [gameId]
    );
    if (unassigned[0].cnt > 0) {
      return res.redirect(base + '?error=' + encodeURIComponent(
        `${unassigned[0].cnt} player(s) haven't joined a team yet — everyone needs a team before you can start.`
      ));
    }
    const { rows: total } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_participants WHERE game_id = $1',
      [gameId]
    );
    if (total[0].cnt < 2) {
      return res.redirect(base + '?error=' + encodeURIComponent('You need at least 2 players to start.'));
    }

    await pool.query('UPDATE games SET is_started = TRUE, started_at = NOW() WHERE id = $1', [gameId]);
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent('The game has started — good luck!'));
  } catch (err) {
    console.error('[scorecard start]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to start game.'));
  }
});

// POST /game/:gameId/scorecard/scores — captain (their own team) or host/co-host: save hole scores
router.post('/scores', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}`;
  const teamId = parseInt(req.body.team_id);

  try {
    const { rows: gameRows } = await pool.query('SELECT is_started, tournament_complete FROM games WHERE id = $1', [gameId]);
    if (!gameRows[0]) return res.redirect('/');
    if (!gameRows[0].is_started) {
      return res.redirect(base + '?error=' + encodeURIComponent("The host hasn't started the game yet."));
    }
    if (gameRows[0].tournament_complete) {
      return res.redirect(base + '?error=' + encodeURIComponent('This game is already complete — scores are locked.'));
    }

    const manageFlag = await canManage(req, gameId);
    if (!manageFlag) {
      const { rows: captainRows } = await pool.query(
        'SELECT id FROM game_participants WHERE game_id = $1 AND user_id = $2 AND is_captain = TRUE AND scorecard_team_id = $3',
        [gameId, req.session.user.id, teamId]
      );
      if (!captainRows[0]) {
        return res.redirect(base + '?error=' + encodeURIComponent('Only that team\'s captain (or the host) can enter its scores.'));
      }
    }

    const { rows: teamPlayers } = await pool.query(
      'SELECT id FROM game_participants WHERE game_id = $1 AND scorecard_team_id = $2',
      [gameId, teamId]
    );
    const validParticipantIds = new Set(teamPlayers.map(p => p.id));

    const updates = [];
    for (const key of Object.keys(req.body)) {
      const match = key.match(/^strokes_(\d+)_(\d+)$/);
      if (!match) continue;
      const participantId = parseInt(match[1]);
      const holeNumber = parseInt(match[2]);
      const raw = req.body[key];
      if (raw === '' || raw === undefined || raw === null) continue;
      if (!validParticipantIds.has(participantId)) continue;
      const strokes = parseInt(raw);
      if (isNaN(strokes) || strokes < 1 || strokes > 15) continue;
      if (holeNumber < 1 || holeNumber > 18) continue;
      updates.push({ participantId, holeNumber, strokes });
    }

    for (const u of updates) {
      await pool.query(
        `INSERT INTO scorecard_scores (game_id, participant_id, hole_number, strokes)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (participant_id, hole_number) DO UPDATE SET strokes = $4, updated_at = NOW()`,
        [gameId, u.participantId, u.holeNumber, u.strokes]
      );
    }

    res.redirect(base + '?success=' + encodeURIComponent(`Saved ${updates.length} score(s).`));
  } catch (err) {
    console.error('[scorecard scores]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to save scores.'));
  }
});

// POST /game/:gameId/scorecard/closest-to-pin — captain (any team) or host/co-host:
// nominate a player as closest-to-the-pin on a par-3 hole, replacing any previous holder
router.post('/closest-to-pin', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}`;
  const holeNumber = parseInt(req.body.hole_number);
  const participantId = parseInt(req.body.participant_id);

  try {
    const { rows: gameRows } = await pool.query('SELECT is_started, tournament_complete FROM games WHERE id = $1', [gameId]);
    if (!gameRows[0]) return res.redirect('/');
    if (!gameRows[0].is_started) {
      return res.redirect(base + '?error=' + encodeURIComponent("The host hasn't started the game yet."));
    }
    if (gameRows[0].tournament_complete) {
      return res.redirect(base + '?error=' + encodeURIComponent('This game is already complete — locked.'));
    }

    const manageFlag = await canManage(req, gameId);
    if (!manageFlag) {
      const { rows: captainRows } = await pool.query(
        'SELECT id FROM game_participants WHERE game_id = $1 AND user_id = $2 AND is_captain = TRUE',
        [gameId, req.session.user.id]
      );
      if (!captainRows[0]) {
        return res.redirect(base + '?error=' + encodeURIComponent('Only a captain or the host can set closest to the pin.'));
      }
    }

    const { rows: holeRows } = await pool.query(
      'SELECT par FROM scorecard_holes WHERE game_id = $1 AND hole_number = $2',
      [gameId, holeNumber]
    );
    if (!holeRows[0] || holeRows[0].par !== 3) {
      return res.redirect(base + '?error=' + encodeURIComponent('Closest to the pin only applies to par-3 holes.'));
    }

    const { rows: participantRows } = await pool.query(
      'SELECT id FROM game_participants WHERE id = $1 AND game_id = $2',
      [participantId, gameId]
    );
    if (!participantRows[0]) {
      return res.redirect(base + '?error=' + encodeURIComponent('Invalid player.'));
    }

    await pool.query(
      `INSERT INTO scorecard_closest_to_pin (game_id, hole_number, participant_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (game_id, hole_number) DO UPDATE SET participant_id = $3, created_at = NOW()`,
      [gameId, holeNumber, participantId]
    );
    res.redirect(base + '?success=' + encodeURIComponent(`Closest to the pin on hole ${holeNumber} updated.`));
  } catch (err) {
    console.error('[scorecard closest-to-pin]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to save closest to the pin.'));
  }
});

module.exports = { router, getScorecardData, isHost, canManage, renderLobby, stablefordPoints };
