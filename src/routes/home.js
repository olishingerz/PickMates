const express = require('express');
const { pool } = require('../db');
const { fetchTournamentList, scrapeLeaderboard, computeRanks } = require('../services/scraper');
const { LEAGUE_NAMES } = require('../services/football');
const { PICKS_PER_PLAYER, SCORES_THAT_COUNT, MIN_CUT_MAKERS } = require('../constants');
const { getLmsData } = require('./lms');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const userId = req.session.user?.id || null;
    const { rows: games } = await pool.query(`
      SELECT g.id, g.name, g.tournament_name, g.is_started, g.is_complete, g.tournament_complete, g.created_at,
             g.game_type, g.host_user_id, g.is_public, g.lms_leagues, g.scorecard_course_name,
             COUNT(gp.id)::int AS participant_count,
             BOOL_OR(gp.user_id = $1) AS user_joined
      FROM games g
      LEFT JOIN game_participants gp ON gp.game_id = g.id
      GROUP BY g.id
      ORDER BY BOOL_OR(gp.user_id = $1) DESC NULLS LAST, g.created_at DESC
    `, [userId]);

    // Current standing (not the stale last_rank snapshot used for arrows on the game page)
    if (userId) {
      await Promise.all(games
        .filter(g => g.user_joined && g.is_started && g.game_type !== 'last_man_standing' && g.game_type !== 'golf_scorecard')
        .map(async g => {
          try {
            const ranks = await computeRanks(g.id);
            g.user_rank = ranks.get(userId) || null;
          } catch (e) {
            console.warn(`[home] computeRanks failed for game ${g.id}:`, e.message);
            g.user_rank = null;
          }
        }));

      // LMS pick deadline — only shown if the viewer still needs to pick this week
      await Promise.all(games
        .filter(g => g.user_joined && g.is_started && g.game_type === 'last_man_standing')
        .map(async g => {
          try {
            const data = await getLmsData(g.id, userId);
            const mine = data.standings.find(s => s.user_id === userId);
            if (mine && !mine.eliminated && !mine.myCurrentPick && data.weekObj?.deadline) {
              g.pickDeadline = data.weekObj.deadline;
            }
          } catch (e) {
            console.warn(`[home] getLmsData failed for game ${g.id}:`, e.message);
          }
        }));
    }
    const { rows: winners } = await pool.query(`
      SELECT g.id, g.name, g.game_type, g.tournament_name,
             g.winner_username,
             g.winner_individual_username,
             g.tournament_end_date, g.tournament_start_date
      FROM games g
      WHERE g.tournament_complete = TRUE
        AND (g.winner_username IS NOT NULL OR g.winner_individual_username IS NOT NULL)
      ORDER BY g.tournament_end_date DESC NULLS LAST, g.created_at DESC
      LIMIT 20
    `);

    res.render('home', {
      games,
      winners,
      LEAGUE_NAMES,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[home]', err);
    res.render('home', { games: [], winners: [], error: 'Could not load games.', success: null });
  }
});

// GET /games/create — create game page
router.get('/games/create', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/auth/login');
  if (!user.isAdmin && !user.isPaid) {
    return res.redirect('/?error=' + encodeURIComponent('You need a paid membership to create games.'));
  }
  let tournaments = [];
  try {
    const all  = await fetchTournamentList();
    const now  = new Date();
    // Live + next 4 upcoming only
    const live     = all.filter(t => t.status === 'STATUS_IN_PROGRESS');
    const upcoming = all.filter(t => t.status === 'STATUS_SCHEDULED')
                        .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
                        .slice(0, 4);
    tournaments = [...live, ...upcoming];
  } catch (e) {
    console.warn('[create page] tournament fetch failed:', e.message);
  }
  res.render('create-game', { tournaments, error: req.query.error || null });
});

// POST /games/create
router.post('/games/create', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/auth/login');
  if (!user.isAdmin && !user.isPaid) {
    return res.redirect('/?error=' + encodeURIComponent('You need a paid membership to create games.'));
  }

  const name     = req.body.name?.trim();
  const gameType = ['golf_draft', 'last_man_standing', 'golf_scorecard'].includes(req.body.game_type)
    ? req.body.game_type : 'golf_draft';

  // Prizes — golf uses separate team/individual pots; LMS has a single entry fee/prize
  const prizeTeam       = gameType === 'last_man_standing' || gameType === 'golf_scorecard'
    ? 0
    : Math.max(0, parseInt(req.body.prize_team) || 0);
  const prizeIndividual = gameType === 'last_man_standing'
    ? Math.max(0, parseInt(req.body.lms_entry_fee) || 0)
    : gameType === 'golf_scorecard' ? 0
    : Math.max(0, parseInt(req.body.prize_individual) || 0);

  // LMS
  const VALID_LEAGUES = ['eng.1', 'eng.2'];
  const rawLeagues = Array.isArray(req.body.lms_leagues)
    ? req.body.lms_leagues
    : req.body.lms_leagues ? [req.body.lms_leagues] : [];
  const lmsLeagues = rawLeagues.filter(l => VALID_LEAGUES.includes(l)).join(',') || 'eng.1';

  if (!name || name.length < 2 || name.length > 200) {
    return res.redirect('/games/create?error=' + encodeURIComponent('Game name must be between 2 and 200 characters.'));
  }

  // Golf Scorecard — validate course, 18 holes, entry fee, and team names
  let courseName = null, coursePar = null, scorecardEntryFee = 0, holes = [], teamNames = [];
  if (gameType === 'golf_scorecard') {
    courseName = req.body.course_name?.trim();
    coursePar  = parseInt(req.body.course_par);
    scorecardEntryFee = Math.max(0, parseInt(req.body.scorecard_entry_fee) || 0);

    if (!courseName || courseName.length < 2 || courseName.length > 200) {
      return res.redirect('/games/create?error=' + encodeURIComponent('Course name must be between 2 and 200 characters.'));
    }
    if (isNaN(coursePar) || coursePar < 60 || coursePar > 80) {
      return res.redirect('/games/create?error=' + encodeURIComponent('Course par must be between 60 and 80.'));
    }

    const strokeIndices = new Set();
    for (let h = 1; h <= 18; h++) {
      const par = parseInt(req.body[`hole_par_${h}`]);
      const si  = parseInt(req.body[`hole_si_${h}`]);
      if (isNaN(par) || par < 3 || par > 6) {
        return res.redirect('/games/create?error=' + encodeURIComponent(`Hole ${h}: par must be between 3 and 6.`));
      }
      if (isNaN(si) || si < 1 || si > 18) {
        return res.redirect('/games/create?error=' + encodeURIComponent(`Hole ${h}: stroke index must be between 1 and 18.`));
      }
      strokeIndices.add(si);
      holes.push({ hole_number: h, par, stroke_index: si });
    }
    if (strokeIndices.size !== 18) {
      return res.redirect('/games/create?error=' + encodeURIComponent('Stroke Index must be a unique number 1–18 across the round.'));
    }

    const numTeams = Math.min(10, Math.max(2, parseInt(req.body.num_teams) || 2));
    for (let i = 1; i <= numTeams; i++) {
      const teamName = req.body[`team_name_${i}`]?.trim();
      if (!teamName || teamName.length < 1 || teamName.length > 50) {
        return res.redirect('/games/create?error=' + encodeURIComponent(`Team ${i} needs a name (max 50 characters).`));
      }
      teamNames.push(teamName);
    }
    if (new Set(teamNames.map(t => t.toLowerCase())).size !== teamNames.length) {
      return res.redirect('/games/create?error=' + encodeURIComponent('Team names must be unique.'));
    }
  }

  const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase();

  try {
    const { rows } = await pool.query(
      `INSERT INTO games (name, game_type, host_user_id, invite_code, prize_team, prize_individual, lms_leagues,
                           scorecard_course_name, scorecard_course_par, scorecard_entry_fee)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [name, gameType, user.id, inviteCode, prizeTeam, prizeIndividual, lmsLeagues,
       courseName, coursePar, scorecardEntryFee]
    );
    const gameId = rows[0].id;

    // Golf draft: save tournament if one was selected on the create page
    if (gameType === 'golf_draft' && req.body.tournament_id) {
      await pool.query(
        'UPDATE games SET tournament_id=$1, tournament_name=$2, tournament_start_date=$3, tournament_end_date=$4 WHERE id=$5',
        [req.body.tournament_id, req.body.tournament_name,
         req.body.tournament_start_date || null, req.body.tournament_end_date || null,
         gameId]
      );
      try { await scrapeLeaderboard(gameId); }
      catch (e) { console.warn('[create] initial scrape failed:', e.message); }
    }

    // Golf Scorecard: save holes and teams
    if (gameType === 'golf_scorecard') {
      for (const h of holes) {
        await pool.query(
          'INSERT INTO scorecard_holes (game_id, hole_number, par, stroke_index) VALUES ($1,$2,$3,$4)',
          [gameId, h.hole_number, h.par, h.stroke_index]
        );
      }
      for (const teamName of teamNames) {
        await pool.query('INSERT INTO scorecard_teams (game_id, name) VALUES ($1,$2)', [gameId, teamName]);
      }
    }

    res.redirect(`/game/${gameId}/draft`);
  } catch (err) {
    console.error('[create game]', err);
    res.redirect('/games/create?error=' + encodeURIComponent('Could not create game.'));
  }
});

// GET /join/:inviteCode — join a game via invite link
router.get('/join/:inviteCode', async (req, res) => {
  const { inviteCode } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT id, name, is_started, tournament_complete FROM games WHERE UPPER(invite_code) = UPPER($1)',
      [inviteCode]
    );
    const game = rows[0];
    if (!game) return res.redirect('/?error=' + encodeURIComponent('Invite link not found.'));
    if (!req.session.user) {
      // Store invite code in session, redirect to login then back
      req.session.pendingInvite = inviteCode;
      return res.redirect('/auth/login?next=' + encodeURIComponent(`/join/${inviteCode}`));
    }
    if (game.is_started) {
      return res.redirect(`/game/${game.id}?error=` + encodeURIComponent('This game has already started — you can no longer join.'));
    }
    if (game.tournament_complete) {
      return res.redirect(`/game/${game.id}?error=` + encodeURIComponent('This game is already complete.'));
    }
    // Already in game?
    const { rows: already } = await pool.query(
      'SELECT id FROM game_participants WHERE game_id=$1 AND user_id=$2',
      [game.id, req.session.user.id]
    );
    if (already.length > 0) return res.redirect(`/game/${game.id}`);

    const { rows: taken } = await pool.query(
      'SELECT COUNT(*) AS cnt FROM game_participants WHERE game_id=$1', [game.id]
    );
    const draftPosition = parseInt(taken[0].cnt) + 1;
    await pool.query(
      'INSERT INTO game_participants (game_id, user_id, draft_position) VALUES ($1,$2,$3)',
      [game.id, req.session.user.id, draftPosition]
    );
    res.redirect(`/game/${game.id}?success=` + encodeURIComponent(`You've joined ${game.name}!`));
  } catch (err) {
    console.error('[join invite]', err);
    res.redirect('/?error=' + encodeURIComponent('Could not join game.'));
  }
});

// GET /how-it-works
router.get('/how-it-works', (req, res) => {
  res.render('how-it-works', { PICKS_PER_PLAYER, SCORES_THAT_COUNT, MIN_CUT_MAKERS });
});

// GET /hall-of-fame
router.get('/hall-of-fame', async (req, res) => {
  try {
    const [allTimeRes, recentRes] = await Promise.all([
      pool.query(`
        SELECT u.username,
               COUNT(*) FILTER (WHERE g.winner_username = u.username)::int              AS team_wins,
               COUNT(*) FILTER (WHERE g.winner_individual_username = u.username)::int   AS indiv_wins,
               (COUNT(*) FILTER (WHERE g.winner_username = u.username)
                 + COUNT(*) FILTER (WHERE g.winner_individual_username = u.username))::int AS total_wins
        FROM users u
        JOIN games g ON g.tournament_complete = TRUE
                     AND (g.winner_username = u.username OR g.winner_individual_username = u.username)
        GROUP BY u.username
        ORDER BY total_wins DESC, team_wins DESC
      `),
      pool.query(`
        SELECT g.id, g.name, g.game_type, g.tournament_name,
               g.winner_username,
               g.winner_individual_username,
               g.tournament_end_date, g.tournament_start_date
        FROM games g
        WHERE g.tournament_complete = TRUE
          AND (g.winner_username IS NOT NULL OR g.winner_individual_username IS NOT NULL)
        ORDER BY g.tournament_end_date DESC NULLS LAST, g.created_at DESC
      `),
    ]);
    res.render('hall-of-fame', {
      allTime: allTimeRes.rows,
      recentWins: recentRes.rows,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[hall-of-fame]', err);
    res.redirect('/');
  }
});

module.exports = router;
