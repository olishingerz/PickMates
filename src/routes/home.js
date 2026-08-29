const express = require('express');
const { pool } = require('../db');
const { fetchTournamentList, scrapeLeaderboard, computeRanks } = require('../services/scraper');
const { LEAGUE_NAMES } = require('../services/football');
const { PICKS_PER_PLAYER, SCORES_THAT_COUNT, MIN_CUT_MAKERS } = require('../constants');
const { getLmsData } = require('./lms');
const { TEAM_COUNTING_SCORES } = require('./scorecard');
const { getGameCreationRoles, canCreateGames } = require('../services/settings');
const { logActivity } = require('../services/activity');
const { computeScorecardPrizeSplit } = require('../services/scorecardPrizes');

const router = express.Router();

async function getHomeData(userId, isAdmin) {
    // Only fully "private" games are hidden from the list for anyone who
    // isn't the host, already a participant, or an admin — "invite only"
    // games are still listed (visible to everyone), just not self-joinable.
    const { rows: games } = await pool.query(`
      SELECT g.id, g.name, g.tournament_name, g.is_started, g.is_complete, g.tournament_complete, g.created_at,
             g.tournament_start_date, g.tournament_end_date, g.completed_at,
             g.game_type, g.host_user_id, g.visibility, g.lms_leagues, g.scorecard_course_name,
             g.prize_team, g.prize_individual, g.scorecard_entry_fee, g.current_pick_index,
             COUNT(gp.id)::int AS participant_count,
             BOOL_OR(gp.user_id = $1) AS user_joined
      FROM games g
      LEFT JOIN game_participants gp ON gp.game_id = g.id
      GROUP BY g.id
      HAVING g.visibility != 'private' OR g.host_user_id = $1 OR BOOL_OR(gp.user_id = $1) OR $2
      ORDER BY BOOL_OR(gp.user_id = $1) DESC NULLS LAST,
               COALESCE(g.completed_at, g.created_at) DESC
    `, [userId, isAdmin === true]);

    // Participant avatars for the "people, not numbers" card display — small
    // enough per game (a personal app, not hundreds of players) that fetching
    // everyone and slicing to the first few client-side is simpler than a
    // per-game-capped SQL query.
    if (games.length > 0) {
      const { rows: participantRows } = await pool.query(`
        SELECT gp.game_id, u.username, u.avatar
        FROM game_participants gp
        JOIN users u ON u.id = gp.user_id
        WHERE gp.game_id = ANY($1)
        ORDER BY gp.id ASC
      `, [games.map(g => g.id)]);
      const avatarsByGame = new Map();
      for (const row of participantRows) {
        if (!avatarsByGame.has(row.game_id)) avatarsByGame.set(row.game_id, []);
        avatarsByGame.get(row.game_id).push({ username: row.username, avatar: row.avatar });
      }
      for (const g of games) g.participants = avatarsByGame.get(g.id) || [];
    }

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

      // LMS: viewer's pick status, plus the game's current-week deadline
      // (shown to everyone as "next fixture", not just those still picking)
      await Promise.all(games
        .filter(g => g.user_joined && g.is_started && g.game_type === 'last_man_standing')
        .map(async g => {
          try {
            const data = await getLmsData(g.id, userId);
            // A viewer can hold more than one entry — the compact card's
            // "Make pick" button should stay visible until every entry has
            // either picked or been eliminated.
            const mine = data.myEntries;
            g.userHasPicked  = mine.length > 0 && mine.every(e => !!e.myCurrentPick || e.eliminated);
            g.userEliminated = mine.length > 0 && mine.every(e => e.eliminated);
            // The current week's own deadline can be in the past — the host
            // hasn't processed results yet, so the week hasn't advanced and
            // no later lms_weeks row (with its own deadline) exists. Once
            // that's happened, prefer the earliest deadline that's actually
            // still upcoming over showing a stale passed one as if it were
            // still relevant.
            const now = Date.now();
            const currentDeadlineFuture = data.weekObj?.deadline && new Date(data.weekObj.deadline).getTime() > now;
            const nextFutureWeek = data.weeks.find(w => w.deadline && new Date(w.deadline).getTime() > now);
            const upcomingDeadline = currentDeadlineFuture ? data.weekObj.deadline : (nextFutureWeek ? nextFutureWeek.deadline : null);
            if (mine.some(e => !e.eliminated && !e.myCurrentPick) && upcomingDeadline) {
              g.pickDeadline = upcomingDeadline;
            }
            g.nextDeadline = upcomingDeadline;
            g.aliveCount   = data.standings.filter(s => !s.eliminated).length;
            g.entryCount   = data.standings.length;
          } catch (e) {
            console.warn(`[home] getLmsData failed for game ${g.id}:`, e.message);
          }
        }));
    }

    // Recent activity across every game the viewer is in — powers the home
    // dashboard's "Recent Activity" feed. Capped to the last 24h so a quiet
    // stretch just makes the feed disappear, rather than filling the space
    // with whatever's oldest out of the last 20 rows ever logged.
    let activity = [];
    if (userId) {
      const { rows } = await pool.query(`
        SELECT al.message, al.created_at, g.name AS game_name
        FROM activity_log al
        JOIN games g ON g.id = al.game_id
        WHERE al.game_id IN (SELECT game_id FROM game_participants WHERE user_id = $1)
          AND al.created_at > NOW() - INTERVAL '24 hours'
        ORDER BY al.created_at DESC
        LIMIT 20
      `, [userId]);
      activity = rows;
    }

    const { rows: winners } = await pool.query(`
      SELECT g.id, g.name, g.game_type, g.tournament_name, g.scorecard_format,
             g.winner_username, wu.avatar AS winner_avatar,
             g.winner_individual_username, wiu.avatar AS winner_individual_avatar,
             g.tournament_end_date, g.tournament_start_date, g.created_at, g.completed_at,
             COALESCE(g.completed_at, g.tournament_end_date, g.created_at) AS event_date
      FROM games g
      -- winner_username is a real username for golf_draft/LMS, but a team name
      -- for team-format golf_scorecard — only look up an avatar in the former case
      LEFT JOIN users wu ON wu.username = g.winner_username AND g.game_type IN ('golf_draft', 'last_man_standing')
      LEFT JOIN users wiu ON wiu.username = g.winner_individual_username
      WHERE g.tournament_complete = TRUE
        AND (g.winner_username IS NOT NULL OR g.winner_individual_username IS NOT NULL)
      ORDER BY COALESCE(g.completed_at, g.tournament_end_date, g.created_at) DESC
      LIMIT 20
    `);

  return { games, winners, activity };
}

router.get('/', async (req, res) => {
  try {
    const userId = req.session.user?.id || null;
    const { games, winners, activity } = await getHomeData(userId, req.session.user?.isAdmin === true);
    res.render('home', {
      games,
      winners,
      activity,
      LEAGUE_NAMES,
      PICKS_PER_PLAYER,
      error:   req.query.error   || null,
      success: req.query.success || null,
    });
  } catch (err) {
    console.error('[home]', err);
    res.render('home', { games: [], winners: [], activity: [], error: 'Could not load games.', success: null });
  }
});

// GET /games/create — create game page
router.get('/games/create', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/auth/login?next=' + encodeURIComponent('/games/create'));
  if (!canCreateGames(user, await getGameCreationRoles())) {
    return res.redirect('/?error=' + encodeURIComponent('You don\'t have permission to create games.'));
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

  let savedCourses = [];
  try {
    const [coursesRes, holesRes] = await Promise.all([
      pool.query('SELECT id, name, par FROM saved_courses WHERE user_id = $1 ORDER BY name ASC', [user.id]),
      pool.query(
        `SELECT sch.course_id, sch.hole_number, sch.par, sch.stroke_index
         FROM saved_course_holes sch
         JOIN saved_courses sc ON sc.id = sch.course_id
         WHERE sc.user_id = $1
         ORDER BY sch.hole_number ASC`,
        [user.id]
      ),
    ]);
    savedCourses = coursesRes.rows.map(c => ({
      ...c,
      holes: holesRes.rows.filter(h => h.course_id === c.id).map(h => ({ hole_number: h.hole_number, par: h.par, stroke_index: h.stroke_index })),
    }));
  } catch (e) {
    console.warn('[create page] saved courses fetch failed:', e.message);
  }

  res.render('create-game', { tournaments, savedCourses, error: req.query.error || null, success: req.query.success || null });
});

// POST /games/create
router.post('/games/create', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/auth/login');
  if (!canCreateGames(user, await getGameCreationRoles())) {
    return res.redirect('/?error=' + encodeURIComponent('You don\'t have permission to create games.'));
  }

  const name     = req.body.name?.trim();
  const gameType = ['golf_draft', 'last_man_standing', 'golf_scorecard'].includes(req.body.game_type)
    ? req.body.game_type : 'golf_draft';
  const visibility = ['public', 'invite_only', 'private'].includes(req.body.visibility)
    ? req.body.visibility : 'public';

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

  // Golf Scorecard — validate course, 18 holes, entry fee, and (team format only) team names
  let courseName = null, coursePar = null, scorecardEntryFee = 0, holes = [], teamNames = [];
  const scorecardFormat = req.body.scorecard_format === 'individual' ? 'individual' : 'team';
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

    if (scorecardFormat === 'team') {
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
  }

  const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase();

  try {
    const { rows } = await pool.query(
      `INSERT INTO games (name, game_type, host_user_id, invite_code, prize_team, prize_individual, lms_leagues,
                           scorecard_course_name, scorecard_course_par, scorecard_entry_fee, scorecard_format, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [name, gameType, user.id, inviteCode, prizeTeam, prizeIndividual, lmsLeagues,
       courseName, coursePar, scorecardEntryFee, scorecardFormat, visibility]
    );
    const gameId = rows[0].id;

    // LMS: add the host as a participant too, unless they said they're only hosting
    if (gameType === 'last_man_standing' && req.body.lms_host_plays === '1') {
      await pool.query(
        'INSERT INTO game_participants (game_id, user_id, draft_position) VALUES ($1, $2, 1)',
        [gameId, user.id]
      );
    }

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

      // Optionally save this course to the host's library for next time
      if (req.body.save_course === '1') {
        try {
          const { rows: savedRows } = await pool.query(
            'INSERT INTO saved_courses (user_id, name, par) VALUES ($1,$2,$3) RETURNING id',
            [user.id, courseName, coursePar]
          );
          const savedCourseId = savedRows[0].id;
          for (const h of holes) {
            await pool.query(
              'INSERT INTO saved_course_holes (course_id, hole_number, par, stroke_index) VALUES ($1,$2,$3,$4)',
              [savedCourseId, h.hole_number, h.par, h.stroke_index]
            );
          }
        } catch (e) {
          console.warn('[create] saving course to library failed:', e.message);
        }
      }
    }

    res.redirect(`/game/${gameId}/draft`);
  } catch (err) {
    console.error('[create game]', err);
    res.redirect('/games/create?error=' + encodeURIComponent('Could not create game.'));
  }
});

// POST /games/create/delete-course — remove a saved course from your library
router.post('/games/create/delete-course', async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect('/auth/login');
  const courseId = parseInt(req.body.course_id);
  try {
    await pool.query('DELETE FROM saved_courses WHERE id = $1 AND user_id = $2', [courseId, user.id]);
    res.redirect('/games/create?success=' + encodeURIComponent('Course removed from your library.'));
  } catch (err) {
    console.error('[delete-course]', err);
    res.redirect('/games/create?error=' + encodeURIComponent('Could not remove course.'));
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
      // The ?next= param carries them back here after login — this route
      // re-runs from the top on that next request, now authenticated.
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
    logActivity(game.id, `${req.session.user.username} joined ${game.name}`);
    res.redirect(`/game/${game.id}?success=` + encodeURIComponent(`You've joined ${game.name}!`));
  } catch (err) {
    console.error('[join invite]', err);
    res.redirect('/?error=' + encodeURIComponent('Could not join game.'));
  }
});

// GET /how-it-works
router.get('/how-it-works', (req, res) => {
  res.render('how-it-works', { PICKS_PER_PLAYER, SCORES_THAT_COUNT, MIN_CUT_MAKERS, TEAM_COUNTING_SCORES });
});

// Old URL — redirect anyone with a bookmark/old link
router.get('/hall-of-fame', (req, res) => res.redirect('/winners-club'));

// GET /winners-club
router.get('/winners-club', async (req, res) => {
  try {
    // Golf Draft/LMS store the winner's own username in winner_username, so a
    // simple string match works. Golf Scorecard team-format games instead store
    // the winning TEAM'S NAME there — matching it against usernames would never
    // hit, so every member of that team needs crediting via scorecard_teams.
    const [allTimeRes, golfLmsWinningsRes, scorecardWinningsRes, recentRes] = await Promise.all([
      pool.query(`
        WITH team_wins AS (
          SELECT g.id AS game_id, u.id AS user_id
          FROM games g
          JOIN users u ON u.username = g.winner_username
          WHERE g.tournament_complete = TRUE
            AND g.game_type IN ('golf_draft', 'last_man_standing')
          UNION ALL
          SELECT g.id AS game_id, gp.user_id
          FROM games g
          JOIN scorecard_teams st ON st.game_id = g.id AND st.name = g.winner_username
          JOIN game_participants gp ON gp.scorecard_team_id = st.id AND gp.game_id = g.id
          WHERE g.tournament_complete = TRUE AND g.game_type = 'golf_scorecard'
        ),
        indiv_wins AS (
          SELECT g.id AS game_id, u.id AS user_id
          FROM games g
          JOIN users u ON u.username = g.winner_individual_username
          WHERE g.tournament_complete = TRUE
        ),
        team_counts  AS (SELECT user_id, COUNT(DISTINCT game_id)::int AS cnt FROM team_wins  GROUP BY user_id),
        indiv_counts AS (SELECT user_id, COUNT(DISTINCT game_id)::int AS cnt FROM indiv_wins GROUP BY user_id)
        SELECT u.id AS user_id, u.username, u.avatar,
               COALESCE(t.cnt, 0) AS team_wins,
               COALESCE(i.cnt, 0) AS indiv_wins,
               (COALESCE(t.cnt, 0) + COALESCE(i.cnt, 0)) AS total_wins
        FROM users u
        LEFT JOIN team_counts  t ON t.user_id = u.id
        LEFT JOIN indiv_counts i ON i.user_id = u.id
        WHERE t.cnt IS NOT NULL OR i.cnt IS NOT NULL
        ORDER BY total_wins DESC, team_wins DESC
      `),
      // Golf Draft/LMS winnings per user — same shape as profile.js's
      // getProfileStats, just ungrouped across every user instead of one.
      pool.query(`
        SELECT u.id AS user_id,
          (SELECT COALESCE(SUM(CASE WHEN g.winner_username = u.username THEN g.prize_team * pc.cnt ELSE 0 END)
                          + SUM(CASE WHEN g.winner_individual_username = u.username THEN g.prize_individual * pc.cnt ELSE 0 END), 0)
           FROM games g
           JOIN (SELECT game_id, COUNT(*) AS cnt FROM game_participants GROUP BY game_id) pc ON pc.game_id = g.id
           WHERE g.game_type = 'golf_draft' AND g.tournament_complete = TRUE
             AND (g.winner_username = u.username OR g.winner_individual_username = u.username)) AS golf_winnings,
          (SELECT COALESCE(SUM(prize_amount), 0) FROM lms_winners WHERE user_id = u.id) AS lms_winnings
        FROM users u
      `),
      // Golf Scorecard prizes aren't stored anywhere — same per-game split as
      // profile.js's scorecardWinningsRes, just for every participant instead
      // of one user, reduced per-user below with computeScorecardPrizeSplit.
      pool.query(`
        SELECT g.scorecard_entry_fee, g.scorecard_format, g.winner_username, g.winner_individual_username,
               gp.user_id AS my_user_id, u.username AS my_username, st.name AS my_team_name,
               (SELECT COUNT(*) FROM game_participants gp2 WHERE gp2.game_id = g.id) AS total_players,
               (SELECT COUNT(*) FROM game_participants gp3
                  JOIN scorecard_teams st3 ON st3.id = gp3.scorecard_team_id
                  WHERE gp3.game_id = g.id AND st3.name = g.winner_username) AS winning_team_size
        FROM games g
        JOIN game_participants gp ON gp.game_id = g.id
        JOIN users u ON u.id = gp.user_id
        LEFT JOIN scorecard_teams st ON st.id = gp.scorecard_team_id
        WHERE g.game_type = 'golf_scorecard' AND g.tournament_complete = TRUE AND g.scorecard_entry_fee > 0
      `),
      pool.query(`
        SELECT g.id, g.name, g.game_type, g.tournament_name, g.scorecard_format,
               g.winner_username, wu.avatar AS winner_avatar,
               g.winner_individual_username, wiu.avatar AS winner_individual_avatar,
               g.tournament_end_date, g.tournament_start_date, g.created_at, g.completed_at,
               COALESCE(g.completed_at, g.tournament_end_date, g.created_at) AS event_date,
               COALESCE(rc.rollover_count, 0) AS rollover_count,
               (SELECT COALESCE(json_agg(json_build_object('username', u2.username, 'avatar', u2.avatar) ORDER BY u2.username), '[]')
                FROM game_participants gp2
                JOIN scorecard_teams st2 ON st2.id = gp2.scorecard_team_id
                JOIN users u2 ON u2.id = gp2.user_id
                WHERE g.game_type = 'golf_scorecard' AND gp2.game_id = g.id AND st2.name = g.winner_username
               ) AS winning_team_members
        FROM games g
        LEFT JOIN users wu ON wu.username = g.winner_username AND g.game_type IN ('golf_draft', 'last_man_standing')
        LEFT JOIN users wiu ON wiu.username = g.winner_individual_username
        -- lms_winners logs every round of a continuous LMS game, including
        -- rollovers (everyone eliminated, pot carries over, no payee) — this
        -- counts those so a hard-fought win can show how many rollovers it
        -- survived. Non-LMS games just get 0 via the LEFT JOIN + COALESCE.
        LEFT JOIN (
          SELECT game_id, COUNT(*)::int AS rollover_count
          FROM lms_winners WHERE is_rollover = TRUE GROUP BY game_id
        ) rc ON rc.game_id = g.id
        WHERE g.tournament_complete = TRUE
          AND (g.winner_username IS NOT NULL OR g.winner_individual_username IS NOT NULL)
        ORDER BY COALESCE(g.completed_at, g.tournament_end_date, g.created_at) DESC
      `),
    ]);
    const golfLmsWinningsByUser = new Map(
      golfLmsWinningsRes.rows.map(r => [r.user_id, (parseFloat(r.golf_winnings) || 0) + (parseFloat(r.lms_winnings) || 0)])
    );
    const scorecardWinningsByUser = new Map();
    for (const row of scorecardWinningsRes.rows) {
      const { teamPrize, indivPrize } = computeScorecardPrizeSplit(row.scorecard_entry_fee, row.total_players, row.scorecard_format);
      let winnings = row.winner_individual_username === row.my_username ? indivPrize : 0;
      if (row.scorecard_format !== 'individual' && row.my_team_name && row.my_team_name === row.winner_username && row.winning_team_size > 0) {
        winnings += teamPrize / row.winning_team_size;
      }
      if (winnings > 0) {
        scorecardWinningsByUser.set(row.my_user_id, (scorecardWinningsByUser.get(row.my_user_id) || 0) + winnings);
      }
    }

    const allTime = allTimeRes.rows.map(row => ({
      ...row,
      totalWinnings: (golfLmsWinningsByUser.get(row.user_id) || 0) + (scorecardWinningsByUser.get(row.user_id) || 0),
    }));

    res.render('hall-of-fame', {
      allTime,
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
