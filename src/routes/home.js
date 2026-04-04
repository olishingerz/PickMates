const express = require('express');
const { pool } = require('../db');
const { fetchTournamentList, scrapeLeaderboard } = require('../services/scraper');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const userId = req.session.user?.id || null;
    const { rows: games } = await pool.query(`
      SELECT g.id, g.name, g.tournament_name, g.is_started, g.is_complete, g.tournament_complete, g.created_at,
             g.game_type, g.host_user_id, g.is_public,
             COUNT(gp.id)::int AS participant_count,
             BOOL_OR(gp.user_id = $1) AS user_joined
      FROM games g
      LEFT JOIN game_participants gp ON gp.game_id = g.id
      GROUP BY g.id
      ORDER BY g.created_at DESC
    `, [userId]);
    const { rows: winners } = await pool.query(`
      SELECT id, name, game_type, tournament_name, winner_username, winner_individual_username,
             tournament_end_date, tournament_start_date
      FROM games
      WHERE tournament_complete = TRUE
        AND (winner_username IS NOT NULL OR winner_individual_username IS NOT NULL)
      ORDER BY tournament_end_date DESC NULLS LAST, created_at DESC
      LIMIT 20
    `);

    res.render('home', {
      games,
      winners,
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
  const gameType = ['golf_draft', 'last_man_standing'].includes(req.body.game_type)
    ? req.body.game_type : 'golf_draft';

  // Golf prizes
  const prizeTeam       = Math.max(0, parseInt(req.body.prize_team)      || 0);
  const prizeIndividual = Math.max(0, parseInt(req.body.prize_individual) || 0);

  // LMS
  const VALID_LEAGUES = ['eng.1', 'eng.2'];
  const rawLeagues = Array.isArray(req.body.lms_leagues)
    ? req.body.lms_leagues
    : req.body.lms_leagues ? [req.body.lms_leagues] : [];
  const lmsLeagues = rawLeagues.filter(l => VALID_LEAGUES.includes(l)).join(',') || 'eng.1';

  if (!name || name.length < 2 || name.length > 200) {
    return res.redirect('/games/create?error=' + encodeURIComponent('Game name must be between 2 and 200 characters.'));
  }

  const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase();

  try {
    const { rows } = await pool.query(
      'INSERT INTO games (name, game_type, host_user_id, invite_code, prize_team, prize_individual, lms_leagues) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [name, gameType, user.id, inviteCode, prizeTeam, prizeIndividual, lmsLeagues]
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

// GET /hall-of-fame
router.get('/hall-of-fame', async (req, res) => {
  try {
    const [allTimeRes, recentRes] = await Promise.all([
      pool.query(`
        SELECT u.username,
               COUNT(*) FILTER (WHERE g.winner_username = u.username)::int              AS team_wins,
               COUNT(*) FILTER (WHERE g.winner_individual_username = u.username)::int   AS indiv_wins,
               COUNT(*) FILTER (WHERE g.winner_username = u.username
                                   OR g.winner_individual_username = u.username)::int   AS total_wins
        FROM users u
        JOIN games g ON g.tournament_complete = TRUE
                     AND (g.winner_username = u.username OR g.winner_individual_username = u.username)
        GROUP BY u.username
        ORDER BY total_wins DESC, team_wins DESC
      `),
      pool.query(`
        SELECT id, name, game_type, tournament_name, winner_username, winner_individual_username,
               tournament_end_date, tournament_start_date
        FROM games
        WHERE tournament_complete = TRUE
          AND (winner_username IS NOT NULL OR winner_individual_username IS NOT NULL)
        ORDER BY tournament_end_date DESC NULLS LAST, created_at DESC
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
