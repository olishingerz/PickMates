const express = require('express');
const { pool } = require('../db');
const { SCORES_THAT_COUNT, MIN_CUT_MAKERS } = require('../constants');
const { computeGolfDraftWinner } = require('../services/golfWinner');
const draftRouter = require('./draft');
const { router: lmsRouter, getLmsData, computePickPopularity } = require('./lms');
const { router: scorecardRouter, getScorecardData } = require('./scorecard');
const { LEAGUE_NAMES } = require('../services/football');
const { logActivity } = require('../services/activity');
const { isHost, canManage } = require('../services/permissions');

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
  const { rows: gameRows } = await pool.query('SELECT game_type, scorecard_format FROM games WHERE id=$1', [gameId]);
  const gameType = gameRows[0]?.game_type;
  const scorecardFormat = gameRows[0]?.scorecard_format;

  if (gameType === 'golf_draft') {
    const { teamWinner, indivWinner } = await computeGolfDraftWinner(pool, gameId);
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
  } else if (gameType === 'golf_scorecard') {
    // Golf Scorecard winners: team with the most Stableford points (team format
    // only), and separately the individual with the most Stableford points
    // (both formats — team format still pays out an individual net-score pot
    // alongside the team pot, so this needs recording even when there's a team winner).
    const data = await getScorecardData(gameId, null);
    const topIndiv = data.individualStandings[0];
    const indivWinner = topIndiv && (topIndiv.total18.points ?? 0) > 0 ? topIndiv.username : null;

    if (scorecardFormat === 'individual') {
      await pool.query('UPDATE games SET winner_username=NULL, winner_individual_username=$1 WHERE id=$2', [indivWinner, gameId]);
    } else {
      const teamWinner = data.standings.length > 0 && data.standings[0].totalPoints > 0
        ? data.standings[0].name
        : null;
      await pool.query('UPDATE games SET winner_username=$1, winner_individual_username=$2 WHERE id=$3', [teamWinner, indivWinner, gameId]);
    }
  }
}

// Mount sub-routers — mergeParams gives them access to :gameId
router.use('/:gameId/draft', draftRouter);
router.use('/:gameId/lms',   lmsRouter);
router.use('/:gameId/scorecard', scorecardRouter);

// GET /game/:gameId — per-game leaderboard
router.get('/:gameId', async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  if (!gameId) return res.redirect('/');

  try {
    const { rows: gameRows } = await pool.query(`
      SELECT g.id, g.name, g.tournament_id, g.tournament_name, g.tournament_start_date, g.tournament_end_date,
             g.is_started, g.is_complete, g.tournament_complete, g.game_type, g.host_user_id, g.prize_team,
             g.prize_individual, g.invite_code, g.round_status, g.visibility, hu.username AS host_username
      FROM games g
      LEFT JOIN users hu ON hu.id = g.host_user_id
      WHERE g.id = $1
    `, [gameId]);
    const game = gameRows[0];
    if (!game) return res.redirect('/?error=' + encodeURIComponent('Game not found.'));

    // "Private" means nobody can even see the game, not just join it —
    // shared across all three game types since this route branches to each
    // one's own template below. "invite_only" stays viewable by anyone;
    // only the join action is blocked for that (handled in /join).
    if (game.visibility === 'private') {
      const viewerId = req.session.user?.id || null;
      const isAdmin  = req.session.user?.isAdmin === true;
      let isParticipant = false;
      if (viewerId) {
        const { rows } = await pool.query(
          'SELECT 1 FROM game_participants WHERE game_id = $1 AND user_id = $2', [gameId, viewerId]
        );
        isParticipant = rows.length > 0;
      }
      if (!isParticipant && game.host_user_id !== viewerId && !isAdmin) {
        return res.redirect('/?error=' + encodeURIComponent('That game is private.'));
      }
    }

    // Branch to LMS game room
    if (game.game_type === 'last_man_standing') {
      const userId    = req.session.user?.id || null;
      const data      = await getLmsData(gameId, userId);
      const hostFlag  = await isHost(req, gameId);
      const manageFlag = await canManage(req, gameId);

      // Leaderboard is a pure DB read — never hits ESPN live. The fixture cache
      // is populated in the background at round-start/restart/advance-week; if
      // it's somehow not ready yet, we just skip the suggestion rather than
      // block this page on a live fetch (the picks page has its own fallback).
      let suggestedDeadline = null;
      if (manageFlag && !data.weekObj?.deadline) {
        const cached = data.weekObj?.fixtures_cache;
        if (cached?.length > 0) {
          const kickoffs = cached.map(f => new Date(f.kickoff).getTime()).filter(t => !isNaN(t));
          if (kickoffs.length) suggestedDeadline = new Date(Math.min(...kickoffs) - 60 * 60 * 1000);
        }
      }

      // What everyone picked, for the most recently locked week only — picks
      // for any week still in progress are hidden until everyone's in, same
      // rule as the standings table itself, so this only ever looks at a week
      // whose picks are already visible to everyone.
      const lockedWeekNumbers = data.weeks.filter(w => w.results_locked).map(w => w.week_number);
      const popularityWeek = lockedWeekNumbers.length > 0 ? Math.max(...lockedWeekNumbers) : null;
      const pickPopularity = popularityWeek !== null ? computePickPopularity(data.allPicks, popularityWeek) : [];

      return res.render('lms', {
        ...data,
        isHost:     hostFlag,
        canManage:  manageFlag,
        LEAGUE_NAMES,
        suggestedDeadline,
        popularityWeek,
        pickPopularity,
        error:   req.query.error   || null,
        success: req.query.success || null,
      });
    }

    // Branch to Golf Scorecard game room
    if (game.game_type === 'golf_scorecard') {
      const userId    = req.session.user?.id || null;
      const data      = await getScorecardData(gameId, userId);
      const hostFlag  = await isHost(req, gameId);
      const manageFlag = await canManage(req, gameId);
      const myParticipant = data.allParticipants.find(p => p.user_id === userId) || null;

      return res.render('scorecard', {
        ...data,
        isHost:     hostFlag,
        canManage:  manageFlag,
        myParticipant,
        error:   req.query.error   || null,
        success: req.query.success || null,
      });
    }

    const { rows } = await pool.query(`
      SELECT
        u.id           AS user_id,
        u.username,
        u.avatar,
        gp.team_name,
        gp.draft_position,
        gp.last_rank,
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
          avatar: row.avatar,
          team_name: row.team_name || null,
          draft_position: row.draft_position,
          last_rank: row.last_rank || null,
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

    const { rows: rankHistory } = await pool.query(`
      SELECT grh.round, grh.rank, grh.team_score, grh.user_id, u.username
      FROM game_rank_history grh
      JOIN users u ON u.id = grh.user_id
      WHERE grh.game_id = $1
      ORDER BY grh.round ASC, grh.rank ASC
    `, [gameId]);

    const userId = req.session.user?.id || null;
    // Named viewerIsHost, not isHost — this whole handler also has the
    // imported isHost(req, gameId) in scope (used by the LMS/Scorecard
    // branches above), and a same-scope `const isHost` here shadowed it for
    // the entire function body via the TDZ, breaking every LMS/Scorecard
    // game page (ReferenceError thrown before those branches' early return).
    const viewerIsHost = req.session.user && (
      req.session.user.isAdmin || req.session.user.id === game.host_user_id
    );
    const userInGame = userId
      ? standings.some(s => s.user_id === userId)
      : false;

    res.render('game', {
      game, standings, individualPotRankings, lastUpdated, rankHistory,
      fmtScore, SCORES_THAT_COUNT, MIN_CUT_MAKERS, isHost: viewerIsHost, userInGame,
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
    const { rows: gameRows } = await pool.query('SELECT name, is_started, visibility, host_user_id FROM games WHERE id = $1', [gameId]);
    const game = gameRows[0];
    if (!game) return res.redirect('/?error=' + encodeURIComponent('Game not found.'));
    if (game.is_started) {
      return res.redirect(`/game/${gameId}/draft?error=` + encodeURIComponent('The draft has already started — you can no longer join.'));
    }
    // Invite-only and private games are invite-link or host-added only —
    // not self-joinable, even by someone who's found their way directly to
    // the game's URL.
    if (game.visibility !== 'public' && game.host_user_id !== userId && !req.session.user.isAdmin) {
      return res.redirect('/?error=' + encodeURIComponent('This game is not open for self-joining — ask the host for an invite link.'));
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
    logActivity(gameId, `${req.session.user.username} joined ${game.name}`);
    res.redirect(`/game/${gameId}/draft?success=` + encodeURIComponent("You've joined the game!"));
  } catch (err) {
    console.error('[join game]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to join game.'));
  }
});

// POST /game/:gameId/leave — any joined player can remove themselves before
// the game/draft has started. Works the same across all three game types —
// deletes every game_participants row they hold (an LMS player might have
// more than one entry), and the FK cascades clean up any scores/picks tied
// to those rows. Leaves games.host_user_id untouched, since hosting is
// tracked separately from playing — a host can leave as a player and keep
// managing the game.
router.post('/:gameId/leave', async (req, res) => {
  if (!req.session?.user) return res.redirect('/auth/login');
  const gameId = parseInt(req.params.gameId);
  const userId = req.session.user.id;

  try {
    const { rows: gameRows } = await pool.query('SELECT is_started FROM games WHERE id = $1', [gameId]);
    const game = gameRows[0];
    if (!game) return res.redirect('/?error=' + encodeURIComponent('Game not found.'));
    if (game.is_started) {
      return res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Cannot leave after the game has started.'));
    }

    const { rowCount } = await pool.query(
      'DELETE FROM game_participants WHERE game_id = $1 AND user_id = $2',
      [gameId, userId]
    );
    if (rowCount === 0) {
      return res.redirect(`/game/${gameId}?error=` + encodeURIComponent('You are not in this game.'));
    }
    res.redirect('/?success=' + encodeURIComponent("You've left the game."));
  } catch (err) {
    console.error('[leave game]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to leave the game.'));
  }
});

// POST /game/:gameId/prizes — host, co-host, or admin: update prize amounts
router.post('/:gameId/prizes', async (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  const gameId = parseInt(req.params.gameId);
  if (!await canManage(req, gameId)) return res.redirect(`/game/${gameId}`);
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

// POST /game/:gameId/delete — host or admin only (not co-host): delete a game and all its data
router.post('/:gameId/delete', async (req, res) => {
  if (!req.session?.user) return res.redirect('/');
  const gameId = parseInt(req.params.gameId);
  if (!await isHost(req, gameId)) return res.redirect('/');
  try {
    await pool.query('DELETE FROM games WHERE id = $1', [gameId]);
    res.redirect('/?success=' + encodeURIComponent('Game deleted.'));
  } catch (err) {
    console.error('[game delete]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to delete game.'));
  }
});

// POST /game/:gameId/uncomplete — host, co-host, or admin: unmark tournament_complete so scraping resumes
router.post('/:gameId/uncomplete', async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  if (!await canManage(req, gameId)) return res.redirect(`/game/${gameId}`);
  try {
    await pool.query(
      'UPDATE games SET tournament_complete = FALSE, completed_at = NULL, winner_username = NULL, winner_individual_username = NULL WHERE id = $1',
      [gameId]
    );
    res.redirect(`/game/${gameId}?success=` + encodeURIComponent('Tournament unmarked — scores will resume updating.'));
  } catch (err) {
    console.error('[game uncomplete]', err);
    res.redirect(`/game/${gameId}?error=` + encodeURIComponent('Failed to unmark tournament.'));
  }
});

// POST /game/:gameId/complete — host, co-host, or admin: mark tournament as fully over
router.post('/:gameId/complete', async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  if (!await canManage(req, gameId)) return res.redirect(`/game/${req.params.gameId}`);
  try {
    await pool.query('UPDATE games SET tournament_complete = TRUE, completed_at = COALESCE(completed_at, NOW()) WHERE id = $1', [gameId]);
    await saveWinner(gameId).catch(e => console.warn('[saveWinner]', e.message));
    res.redirect(`/game/${gameId}`);
  } catch (err) {
    console.error('[game complete]', err);
    res.redirect(`/game/${gameId}`);
  }
});

module.exports = router;
