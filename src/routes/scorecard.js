const express = require('express');
const bcrypt = require('bcrypt');
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

// Gross score vs par, for colour-coding each hole cell — deliberately not
// handicap-adjusted, so it matches traditional eagle/birdie/par/bogey terms.
function scoreColorClass(strokes, par) {
  if (strokes === null || strokes === undefined) return null;
  const diff = strokes - par;
  if (diff <= -2) return 'score-eagle';
  if (diff === -1) return 'score-birdie';
  if (diff === 0)  return 'score-par';
  if (diff === 1)  return 'score-bogey';
  if (diff === 2)  return 'score-double';
  return 'score-other';
}

// Only the team's best N Stableford scores count on each hole (a "best-ball"-style
// counting format), not every player's — keeps bigger teams from being penalised.
const TEAM_COUNTING_SCORES = 3;

function sumField(holeScores, field) {
  const vals = holeScores.map(hs => hs[field]).filter(v => v !== null && v !== undefined);
  return vals.length > 0 ? vals.reduce((s, v) => s + v, 0) : null;
}

async function getScorecardData(gameId, userId) {
  const [gameRes, teamsRes, teeTimesRes, participantsRes, holesRes, scoresRes, ctpRes] = await Promise.all([
    pool.query(
      `SELECT g.id, g.name, g.game_type, g.is_started, g.tournament_complete, g.started_at, g.host_user_id, g.invite_code,
              g.scorecard_course_name, g.scorecard_course_par, g.scorecard_entry_fee, g.winner_username,
              hu.username AS host_username
       FROM games g
       LEFT JOIN users hu ON hu.id = g.host_user_id
       WHERE g.id = $1`,
      [gameId]
    ),
    pool.query('SELECT id, name FROM scorecard_teams WHERE game_id = $1 ORDER BY id ASC', [gameId]),
    pool.query('SELECT id, label FROM scorecard_tee_times WHERE game_id = $1 ORDER BY id ASC', [gameId]),
    pool.query(`
      SELECT gp.id AS participant_id, u.id AS user_id, u.username,
             gp.scorecard_team_id, gp.scorecard_tee_time_id, gp.handicap, gp.is_co_host
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = $1
      ORDER BY u.username ASC
    `, [gameId]),
    pool.query('SELECT hole_number, par, stroke_index, is_ctp FROM scorecard_holes WHERE game_id = $1 ORDER BY hole_number ASC', [gameId]),
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
  const teeTimeLabelById = new Map(teeTimesRes.rows.map(tt => [tt.id, tt.label]));

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
        scoreClass: scoreColorClass(strokes, h.par),
      };
    });
    const frontNine = holeScores.filter(hs => hs.hole_number <= 9);
    const backNine  = holeScores.filter(hs => hs.hole_number > 9);
    const player = {
      ...p,
      team_name: teamNameById.get(p.scorecard_team_id) || null,
      tee_time_label: teeTimeLabelById.get(p.scorecard_tee_time_id) || null,
      holeScores,
      front9:  { strokes: sumField(frontNine, 'strokes'), points: sumField(frontNine, 'points') },
      back9:   { strokes: sumField(backNine,  'strokes'), points: sumField(backNine,  'points') },
      total18: { strokes: sumField(holeScores, 'strokes'), points: sumField(holeScores, 'points') },
      thru: holeScores.filter(hs => hs.strokes !== null).length,
    };
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
      if (pts.length === 0) return null;
      const counting = [...pts].sort((a, b) => b - a).slice(0, TEAM_COUNTING_SCORES);
      return counting.reduce((s, v) => s + v, 0);
    });
    const totalPoints = holeTotals.some(v => v !== null)
      ? holeTotals.reduce((s, v) => s + (v || 0), 0)
      : 0;
    const frontTotals = holeTotals.slice(0, 9);
    const backTotals  = holeTotals.slice(9, 18);
    const frontPoints = frontTotals.some(v => v !== null) ? frontTotals.reduce((s, v) => s + (v || 0), 0) : null;
    const backPoints  = backTotals.some(v => v !== null)  ? backTotals.reduce((s, v) => s + (v || 0), 0)  : null;
    const thru = holes.filter(h =>
      players.length > 0 && players.every(p => p.holeScores.find(hs => hs.hole_number === h.hole_number)?.strokes != null)
    ).length;
    return { ...t, players, holeTotals, totalPoints, frontPoints, backPoints, thru };
  });

  const standings = [...teams].sort((a, b) => b.totalPoints - a.totalPoints);

  const ctpByHole = new Map(ctpRes.rows.map(r => [r.hole_number, r.participant_id]));
  const parThreeHoles = holes.filter(h => h.par === 3);
  const closestToPin = parThreeHoles
    .filter(h => h.is_ctp)
    .map(h => ({
      hole_number: h.hole_number,
      holder: participantById.get(ctpByHole.get(h.hole_number)) || null,
    }));

  const allParticipants = participants.map(p => participantById.get(p.participant_id));

  const individualStandings = [...allParticipants].sort((a, b) => {
    const bp = b.total18.points ?? -1;
    const ap = a.total18.points ?? -1;
    return bp - ap;
  });

  // Tee times are a second, independent grouping from teams (who plays together
  // on the course, not who's on the same competitive team) — same player objects,
  // just filtered differently. Purely optional; empty if the host never sets any up.
  const teeTimes = teeTimesRes.rows.map(tt => ({
    ...tt,
    players: allParticipants.filter(p => p.scorecard_tee_time_id === tt.id),
  }));

  return { game, teams, standings, holes, parThreeHoles, teeTimes, unassignedParticipants, allParticipants, individualStandings, closestToPin, userId };
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

    // Pre-start, this lobby is itself how a new player joins (picking a team
    // creates their game_participants row) — any logged-in user may view it.
    // Once started it's a read-only view of teams/handicaps, so it's
    // restricted to participants/host/co-host, same as the golf_draft/LMS lobby.
    if (data.game.is_started) {
      const isParticipant = data.allParticipants.some(p => p.user_id === req.session.user.id);
      if (!isParticipant && !manageFlag) {
        return res.redirect(`/game/${gameId}`);
      }
    }

    // Suggestions for the host's "add player" search box — only relevant pre-start
    let suggestedUsernames = [];
    if (manageFlag && !data.game.is_started) {
      const { rows } = await pool.query(
        `SELECT username FROM users
         WHERE id NOT IN (SELECT user_id FROM game_participants WHERE game_id = $1)
         ORDER BY username ASC`,
        [gameId]
      );
      suggestedUsernames = rows.map(r => r.username);
    }

    res.render('scorecard-lobby', {
      ...data,
      isHost: hostFlag,
      canManage: manageFlag,
      suggestedUsernames,
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

// POST /game/:gameId/scorecard/add-player — host/co-host: add a player to a team by
// username, without requiring them to join themselves. Creates a lightweight account
// with a temp password if that username doesn't exist yet — teammates/tee-time
// partners do the scoring, so most added players never need to log in at all.
router.post('/add-player', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  const username = req.body.username?.trim();
  const teamId   = parseInt(req.body.team_id);
  if (!username || username.length < 2 || username.length > 50) {
    return res.redirect(base + '?error=' + encodeURIComponent('Username must be between 2 and 50 characters.'));
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: stateRows } = await client.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    if (stateRows[0]?.is_started) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent('The game has already started — teams are locked in.'));
    }

    const { rows: teamRows } = await client.query('SELECT id FROM scorecard_teams WHERE id = $1 AND game_id = $2', [teamId, gameId]);
    if (!teamRows[0]) {
      await client.query('ROLLBACK');
      return res.redirect(base + '?error=' + encodeURIComponent('Invalid team.'));
    }

    // Create the account if it doesn't already exist
    let userId;
    let tempPassword = null;
    const { rows: existingUser } = await client.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existingUser.length > 0) {
      userId = existingUser[0].id;
    } else {
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

    await client.query(
      'INSERT INTO game_participants (game_id, user_id, scorecard_team_id) VALUES ($1, $2, $3)',
      [gameId, userId, teamId]
    );
    await client.query('COMMIT');

    const msg = tempPassword
      ? `${username} added to the team. Temp password (only needed if they want to log in themselves): ${tempPassword}`
      : `${username} added to the team.`;
    res.redirect(base + '?success=' + encodeURIComponent(msg));
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.redirect(base + '?error=' + encodeURIComponent(`"${username}" is already taken.`));
    }
    console.error('[scorecard add-player]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to add player.'));
  } finally {
    client.release();
  }
});

// POST /game/:gameId/scorecard/remove-player — host/co-host: remove a player from the game
router.post('/remove-player', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base   = `/game/${gameId}/draft`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  const participantId = parseInt(req.body.participant_id);
  if (!participantId) return res.redirect(base + '?error=' + encodeURIComponent('Invalid player.'));

  try {
    const { rows: gameRows } = await pool.query('SELECT is_started, host_user_id FROM games WHERE id = $1', [gameId]);
    if (!gameRows[0]) return res.redirect('/');
    if (gameRows[0].is_started) {
      return res.redirect(base + '?error=' + encodeURIComponent('The game has already started — teams are locked in.'));
    }

    const { rows: participantRows } = await pool.query(
      'SELECT user_id FROM game_participants WHERE id = $1 AND game_id = $2',
      [participantId, gameId]
    );
    if (!participantRows[0]) {
      return res.redirect(base + '?error=' + encodeURIComponent('Player not found.'));
    }
    if (participantRows[0].user_id === gameRows[0].host_user_id) {
      return res.redirect(base + '?error=' + encodeURIComponent('Cannot remove the host from the game.'));
    }

    await pool.query('DELETE FROM game_participants WHERE id = $1 AND game_id = $2', [participantId, gameId]);
    res.redirect(base + '?success=' + encodeURIComponent('Player removed.'));
  } catch (err) {
    console.error('[scorecard remove-player]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to remove player.'));
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

// POST /game/:gameId/scorecard/tee-times/add — host/co-host: create a new tee time.
// Unlike teams/handicaps, tee times aren't locked at start — a host may
// well only want to set them up once the game is already underway.
router.post('/tee-times/add', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}/draft`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  const label = req.body.label?.trim();
  if (!label || label.length < 1 || label.length > 50) {
    return res.redirect(base + '?error=' + encodeURIComponent('Tee time name must be between 1 and 50 characters.'));
  }

  try {
    await pool.query('INSERT INTO scorecard_tee_times (game_id, label) VALUES ($1, $2)', [gameId, label]);
    res.redirect(base + '?success=' + encodeURIComponent(`Tee time "${label}" added.`));
  } catch (err) {
    console.error('[scorecard tee-times add]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to add tee time.'));
  }
});

// POST /game/:gameId/scorecard/tee-times/remove — host/co-host: delete an empty tee time
router.post('/tee-times/remove', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}/draft`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  const teeTimeId = parseInt(req.body.tee_time_id);
  if (!teeTimeId) return res.redirect(base + '?error=' + encodeURIComponent('Invalid tee time.'));

  try {
    const { rows: assigned } = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM game_participants WHERE game_id = $1 AND scorecard_tee_time_id = $2',
      [gameId, teeTimeId]
    );
    if (assigned[0].cnt > 0) {
      return res.redirect(base + '?error=' + encodeURIComponent('Move everyone out of this tee time before removing it.'));
    }
    await pool.query('DELETE FROM scorecard_tee_times WHERE id = $1 AND game_id = $2', [teeTimeId, gameId]);
    res.redirect(base + '?success=' + encodeURIComponent('Tee time removed.'));
  } catch (err) {
    console.error('[scorecard tee-times remove]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to remove tee time.'));
  }
});

// POST /game/:gameId/scorecard/tee-time — host/co-host: assign a participant to a tee time
router.post('/tee-time', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}/draft`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  const participantId = parseInt(req.body.participant_id);
  const teeTimeId = req.body.tee_time_id === '' ? null : parseInt(req.body.tee_time_id);

  try {
    if (teeTimeId !== null) {
      const { rows: teeTimeRows } = await pool.query('SELECT id FROM scorecard_tee_times WHERE id = $1 AND game_id = $2', [teeTimeId, gameId]);
      if (!teeTimeRows[0]) {
        return res.redirect(base + '?error=' + encodeURIComponent('Invalid tee time.'));
      }
    }
    await pool.query(
      'UPDATE game_participants SET scorecard_tee_time_id = $1 WHERE id = $2 AND game_id = $3',
      [teeTimeId, participantId, gameId]
    );
    res.redirect(base + '?success=' + encodeURIComponent('Tee time updated.'));
  } catch (err) {
    console.error('[scorecard tee-time]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to update tee time.'));
  }
});

// POST /game/:gameId/scorecard/start — host/co-host: lock teams/handicaps and begin
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

// POST /game/:gameId/scorecard/scores — save hole scores. Authorized per player, not
// per form: host/co-host can edit anyone; anyone can edit a fellow member of their
// own tee-time group. This lets one submission span multiple teams (needed for the
// tee-time view).
router.post('/scores', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}`;

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
    const { rows: allParts } = await pool.query(
      'SELECT id, user_id, scorecard_team_id, scorecard_tee_time_id FROM game_participants WHERE game_id = $1',
      [gameId]
    );
    const partsById = new Map(allParts.map(p => [p.id, p]));
    const me = allParts.find(p => p.user_id === req.session.user.id) || null;

    function canEdit(participant) {
      if (manageFlag) return true;
      if (!me) return false;
      if (me.scorecard_tee_time_id && me.scorecard_tee_time_id === participant.scorecard_tee_time_id) return true;
      return false;
    }

    const updates = [];
    for (const key of Object.keys(req.body)) {
      const match = key.match(/^strokes_(\d+)_(\d+)$/);
      if (!match) continue;
      const participantId = parseInt(match[1]);
      const holeNumber = parseInt(match[2]);
      const raw = req.body[key];
      if (raw === '' || raw === undefined || raw === null) continue;
      const participant = partsById.get(participantId);
      if (!participant || !canEdit(participant)) continue;
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

// POST /game/:gameId/scorecard/closest-to-pin — anyone in a tee time, or host/co-host:
// nominate a player as closest-to-the-pin on the designated hole, replacing any previous holder
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
      const { rows: meRows } = await pool.query(
        'SELECT id FROM game_participants WHERE game_id = $1 AND user_id = $2 AND scorecard_tee_time_id IS NOT NULL',
        [gameId, req.session.user.id]
      );
      if (!meRows[0]) {
        return res.redirect(base + '?error=' + encodeURIComponent('Only someone in a tee time or the host can set closest to the pin.'));
      }
    }

    const { rows: holeRows } = await pool.query(
      'SELECT par, is_ctp FROM scorecard_holes WHERE game_id = $1 AND hole_number = $2',
      [gameId, holeNumber]
    );
    if (!holeRows[0] || holeRows[0].par !== 3 || !holeRows[0].is_ctp) {
      return res.redirect(base + '?error=' + encodeURIComponent('Closest to the pin isn\'t enabled for that hole.'));
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

// POST /game/:gameId/scorecard/ctp-holes — host/co-host: choose which par-3 holes
// have a closest-to-the-pin competition. Works both pre-start (lobby) and once the
// game is live (scorecard host controls) — unlike teams/handicaps, this
// isn't locked in at start.
router.post('/ctp-holes', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = req.body.return_to === 'draft' ? `/game/${gameId}/draft` : `/game/${gameId}`;
  if (!await canManage(req, gameId)) return res.redirect(base);

  const rawHoles = Array.isArray(req.body.ctp_holes)
    ? req.body.ctp_holes
    : req.body.ctp_holes ? [req.body.ctp_holes] : [];
  const enabledHoles = rawHoles.map(h => parseInt(h)).filter(n => !isNaN(n));

  try {
    await pool.query(
      'UPDATE scorecard_holes SET is_ctp = (hole_number = ANY($1)) WHERE game_id = $2 AND par = 3',
      [enabledHoles, gameId]
    );
    res.redirect(base + '?success=' + encodeURIComponent('Closest-to-the-pin holes updated.'));
  } catch (err) {
    console.error('[scorecard ctp-holes]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to update closest-to-the-pin holes.'));
  }
});

// POST /game/:gameId/scorecard/reset-scores — host: wipe all entered hole scores
// (keeps teams/handicaps/closest-to-pin selections intact), so players
// can start entering strokes again after a mistake.
router.post('/reset-scores', requireAuth, async (req, res) => {
  const gameId = getGameId(req);
  const base = `/game/${gameId}`;
  if (!await isHost(req, gameId)) return res.redirect(base);

  try {
    await pool.query('DELETE FROM scorecard_scores WHERE game_id = $1', [gameId]);
    res.redirect(base + '?success=' + encodeURIComponent('All scores have been reset.'));
  } catch (err) {
    console.error('[scorecard reset-scores]', err);
    res.redirect(base + '?error=' + encodeURIComponent('Failed to reset scores.'));
  }
});

module.exports = { router, getScorecardData, isHost, canManage, renderLobby, stablefordPoints };
