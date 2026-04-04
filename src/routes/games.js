const express = require('express');
const { pool } = require('../db');
const { SCORES_THAT_COUNT, MIN_CUT_MAKERS } = require('../constants');
const draftRouter = require('./draft');
const { router: lmsRouter, getLmsData, isHost: lmsIsHost } = require('./lms');
const { LEAGUE_NAMES } = require('../services/football');

const router = express.Router();

function fmtScore(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

function calcTeamData(picks) {
  const withScore = picks.filter(p => p.score_to_par !== null && p.score_to_par !== undefined);
  const sorted    = [...withScore].sort((a, b) => a.score_to_par - b.score_to_par);
  const counting  = sorted.slice(0, SCORES_THAT_COUNT);
  const teamScore = counting.length === SCORES_THAT_COUNT
    ? counting.reduce((s, p) => s + p.score_to_par, 0)
    : null;
  const cutMakers           = picks.filter(p => p.made_cut === true).length;
  const qualified           = cutMakers >= MIN_CUT_MAKERS;
  const bestIndividual      = sorted[0]?.score_to_par ?? null;
  const bestIndividualPlayer = sorted[0]?.player_name  ?? null;

  return { teamScore, qualified, cutMakers, counting, bestIndividual, bestIndividualPlayer };
}

// Compute winner(s) for a completed game and save to DB
async function saveWinner(gameId) {
  const { rows: gameRows } = await pool.query('SELECT game_type FROM games WHERE id=$1', [gameId]);
  const gameType = gameRows[0]?.game_type;

  if (gameType === 'golf_draft') {
    const { rows } = await pool.query(`
      SELECT u.username, gp.user_id,
             ARRAY_AGG(l.score_to_par ORDER BY l.score_to_par ASC) FILTER (WHERE l.score_to_par IS NOT NULL) AS scores,
             COUNT(CASE WHEN l.made_cut = TRUE THEN 1 END)::int AS cut_makers
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      LEFT JOIN picks p ON p.user_id = gp.user_id AND p.game_id = gp.game_id
      LEFT JOIN leaderboard l ON l.game_id = gp.game_id
                              AND LOWER(TRIM(l.player_name)) = LOWER(TRIM(p.player_name))
      WHERE gp.game_id = $1
      GROUP BY u.username, gp.user_id
    `, [gameId]);

    // Team winner (lowest sum of best 3, must have 3+ cut makers)
    let teamWinner = null;
    let bestTeamScore = Infinity;
    // Individual pot winner (lowest single score)
    let indivWinner = null;
    let bestIndivScore = Infinity;

    for (const row of rows) {
      const scores = row.scores || [];
      const cutMakers = row.cut_makers || 0;
      if (scores.length > 0 && scores[0] < bestIndivScore) {
        bestIndivScore = scores[0];
        indivWinner = row.username;
      }
      if (cutMakers >= SCORES_THAT_COUNT && scores.length >= SCORES_THAT_COUNT) {
        const teamScore = scores.slice(0, SCORES_THAT_COUNT).reduce((s, v) => s + v, 0);
        if (teamScore < bestTeamScore) {
          bestTeamScore = teamScore;
          teamWinner = row.username;
        }
      }
    }

    await pool.query(
      'UPDATE games SET winner_username=$1, winner_individual_username=$2 WHERE id=$3',
      [teamWinner, indivWinner, gameId]
    );
  } else if (gameType === 'last_man_standing') {
    // LMS winner: last person still alive (not eliminated)
    const data = await getLmsData(gameId, null);
    const alive = data.standings.filter(s => !s.eliminated);
    const winner = alive.length === 1 ? alive[0].username : null;
    await pool.query('UPDATE games SET winner_username=$1 WHERE id=$2', [winner, gameId]);
  }
}

// Mount sub-routers — mergeParams gives them access to :gameId
router.use('/:gameId/draft', draftRouter);
router.use('/:gameId/lms',   lmsRouter);

// GET /game/:gameId — per-game leaderboard
router.get('/:gameId', async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  if (!gameId) return res.redirect('/');

  try {
    const { rows: gameRows } = await pool.query('SELECT id, name, tournament_id, tournament_name, tournament_start_date, tournament_end_date, is_started, is_complete, tournament_complete, game_type, host_user_id, prize_team, prize_individual, invite_code FROM games WHERE id = $1', [gameId]);
    const game = gameRows[0];
    if (!game) return res.redirect('/?error=' + encodeURIComponent('Game not found.'));

    // Branch to LMS game room
    if (game.game_type === 'last_man_standing') {
      const userId   = req.session.user?.id || null;
      const data     = await getLmsData(gameId, userId);
      const hostFlag = await lmsIsHost(req, gameId);
      return res.render('lms', {
        ...data,
        isHost:     hostFlag,
        LEAGUE_NAMES,
        error:   req.query.error   || null,
        success: req.query.success || null,
      });
    }

    const { rows } = await pool.query(`
      SELECT
        u.id           AS user_id,
        u.username,
        gp.draft_position,
        gp.team_name,
        p.player_name,
        p.pick_slot,
        l.position     AS lb_position,
        l.score_to_par,
        l.made_cut,
        l.thru,
        l.r1, l.r2, l.r3, l.r4,
        l.updated_at
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      LEFT JOIN picks p ON p.user_id = u.id AND p.game_id = $1
      LEFT JOIN leaderboard l
             ON l.game_id = $1
            AND LOWER(TRIM(l.player_name)) = LOWER(TRIM(p.player_name))
      WHERE gp.game_id = $1
      ORDER BY gp.draft_position ASC, p.pick_slot ASC
    `, [gameId]);

    const teamsMap = new Map();
    for (const row of rows) {
      if (!teamsMap.has(row.user_id)) {
        teamsMap.set(row.user_id, {
          user_id: row.user_id,
          username: row.username,
          team_name: row.team_name || null,
          draft_position: row.draft_position,
          picks: [],
          updated_at: null,
        });
      }
      const team = teamsMap.get(row.user_id);
      if (row.player_name) {
        team.picks.push({
          player_name:  row.player_name,
          pick_slot:    row.pick_slot,
          lb_position:  row.lb_position,
          score_to_par: row.score_to_par,
          made_cut:     row.made_cut,
          thru:         row.thru,
          r1: row.r1, r2: row.r2, r3: row.r3, r4: row.r4,
        });
        if (row.updated_at) team.updated_at = row.updated_at;
      }
    }

    const teams = [...teamsMap.values()].map(team => ({ ...team, ...calcTeamData(team.picks) }));

    const qualified   = teams.filter(t => t.qualified && t.teamScore !== null);
    const unqualified = teams.filter(t => !t.qualified && t.teamScore !== null);
    const noScore     = teams.filter(t => t.teamScore === null);

    qualified.sort((a, b) =>
      a.teamScore !== b.teamScore ? a.teamScore - b.teamScore : (a.bestIndividual ?? 999) - (b.bestIndividual ?? 999)
    );
    unqualified.sort((a, b) =>
      a.teamScore !== b.teamScore ? a.teamScore - b.teamScore : (a.bestIndividual ?? 999) - (b.bestIndividual ?? 999)
    );

    const standings = [...qualified, ...unqualified, ...noScore].map((t, i) => ({ ...t, rank: i + 1 }));

    const individualPotRankings = [...teams]
      .filter(t => t.bestIndividual !== null)
      .sort((a, b) => a.bestIndividual - b.bestIndividual)
      .map((t, i) => ({ ...t, rank: i + 1 }));

    const lastUpdated = rows.find(r => r.updated_at)?.updated_at || null;

    const userId = req.session.user?.id || null;
    const isHost = req.session.user && (
      req.session.user.isAdmin || req.session.user.id === game.host_user_id
    );
    const userInGame = userId
      ? standings.some(s => s.user_id === userId)
      : false;

    res.render('game', {
      game, standings, individualPotRankings, lastUpdated,
      fmtScore, SCORES_THAT_COUNT, MIN_CUT_MAKERS, isHost, userInGame,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[game leaderboard]', err);
    res.redirect('/');
  }
});

// POST /game/:gameId/join — any logged-in user can join before draft starts
router.post('/:gameId/join', async (req, res) => {
  if (!req.session?.user) return res.redirect('/auth/login');
  const gameId = parseInt(req.params.gameId);
  const userId = req.session.user.id;

  try {
    const { rows: gameRows } = await pool.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    const game = gameRows[0];
    if (!game) return res.redirect('/?error=' + encodeURIComponent('Game not found.'));
    if (game.is_started) {
      return res.redirect(`/game/${gameId}/draft?error=` + encodeURIComponent('The draft has already started — you can no longer join.'));
    }

    const { rows: already } = await pool.query(
      'SELECT id FROM game_participants WHERE game_id = $1 AND user_id = $2',
      [gameId, userId]
    );
    if (already.length > 0) {
      return res.redirect(`/game/${gameId}/draft?error=` + encodeURIComponent('You are already in this game.'));
    }

    const { rows: taken } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM game_participants WHERE game_id = $1', [gameId]
    );
    const draftPosition = parseInt(taken[0].cnt) + 1;

    await pool.query(
      'INSERT INTO game_participants (game_id, user_id, draft_position) VALUES ($1, $2, $3)',
      [gameId, userId, draftPosition]
    );
    res.redirect(`/game/${gameId}/draft?success=` + encodeURIComponent("You've joined the game!"));
  } catch (err) {
    console.error('[join game]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to join game.'));
  }
});

// POST /game/:gameId/prizes — host or admin: update prize amounts
router.post('/:gameId/prizes', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.redirect('/');
  const gameId = parseInt(req.params.gameId);
  const { rows } = await pool.query('SELECT host_user_id FROM games WHERE id = $1', [gameId]);
  const isHost = user.isAdmin || user.id === rows[0]?.host_user_id;
  if (!isHost) return res.redirect(`/game/${gameId}`);
  const prizeTeam       = Math.max(0, parseInt(req.body.prize_team)      || 0);
  const prizeIndividual = Math.max(0, parseInt(req.body.prize_individual) || 0);
  try {
    await pool.query('UPDATE games SET prize_team=$1, prize_individual=$2 WHERE id=$3', [prizeTeam, prizeIndividual, gameId]);
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent('Prize amounts updated.'));
  } catch (err) {
    console.error('[game prizes]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to update prizes.'));
  }
});

// POST /game/:gameId/delete — host or admin: delete a game and all its data
router.post('/:gameId/delete', async (req, res) => {
  const user = req.session?.user;
  if (!user) return res.redirect('/');
  const gameId = parseInt(req.params.gameId);
  const { rows } = await pool.query('SELECT host_user_id FROM games WHERE id = $1', [gameId]);
  const isHost = user.isAdmin || user.id === rows[0]?.host_user_id;
  if (!isHost) return res.redirect('/');
  try {
    await pool.query('DELETE FROM games WHERE id = $1', [gameId]);
    res.redirect('/?success=' + encodeURIComponent('Game deleted.'));
  } catch (err) {
    console.error('[game delete]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to delete game.'));
  }
});

// POST /game/:gameId/uncomplete — host or admin: unmark tournament_complete so scraping resumes
router.post('/:gameId/uncomplete', async (req, res) => {
  const user = req.session?.user;
  const gameId = parseInt(req.params.gameId);
  const { rows } = await pool.query('SELECT host_user_id FROM games WHERE id = $1', [gameId]);
  const isHost = user?.isAdmin || user?.id === rows[0]?.host_user_id;
  if (!isHost) return res.redirect(`/game/${gameId}`);
  try {
    await pool.query(
      'UPDATE games SET tournament_complete = FALSE, winner_username = NULL, winner_individual_username = NULL WHERE id = $1',
      [gameId]
    );
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent('Tournament unmarked — scores will resume updating.'));
  } catch (err) {
    console.error('[game uncomplete]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to unmark tournament.'));
  }
});

// POST /game/:gameId/complete — host or admin: mark tournament as fully over
router.post('/:gameId/complete', async (req, res) => {
  const user = req.session?.user;
  const gameId = parseInt(req.params.gameId);
  const { rows } = await pool.query('SELECT host_user_id FROM games WHERE id = $1', [gameId]);
  const isHost = user?.isAdmin || user?.id === rows[0]?.host_user_id;
  if (!isHost) return res.redirect(`/game/${req.params.gameId}`);
  try {
    await pool.query('UPDATE games SET tournament_complete = TRUE WHERE id = $1', [gameId]);
    await saveWinner(gameId).catch(e => console.warn('[saveWinner]', e.message));
    res.redirect(`/game/${gameId}`);
  } catch (err) {
    console.error('[game complete]', err);
    res.redirect(`/game/${gameId}`);
  }
});

module.exports = router;
