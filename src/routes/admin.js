const express = require('express');
const bcrypt  = require('bcrypt');
const { pool } = require('../db');
const { ROLE_OPTIONS, getGameCreationRoles, setGameCreationRoles } = require('../services/settings');
const { generateTempPassword } = require('../utils');
const { computeGolfDraftWinner } = require('../services/golfWinner');
const { sendTestEmail, isConfigured: isEmailConfigured } = require('../services/email');
const { getCurrentGameweekFixtures } = require('../services/football');
const { refreshFixtureCache } = require('./lms');
const net = require('net');

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';
async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`ESPN ${res.status}`);
  return res.json();
}

// This debug route builds its response as a raw HTML string (not an EJS view,
// which auto-escapes) — escape anything that ultimately traces back to a
// user-chosen value (game name) or third-party data (ESPN athlete names).
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.user?.isAdmin) return res.redirect('/');
  next();
}

// ── GET /admin ────────────────────────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const [usersRes, gamesRes, gameCreationRoles, lmsWinnersRes] = await Promise.all([
      pool.query(`
        SELECT u.id, u.username, u.email,
               u.is_admin, u.is_paid, u.is_banned, u.created_at, u.last_seen,
               COUNT(gp.id)::int AS game_count
        FROM users u
        LEFT JOIN game_participants gp ON gp.user_id = u.id
        GROUP BY u.id
        ORDER BY u.created_at DESC
      `),
      pool.query(`
        SELECT g.id, g.name, g.game_type, g.is_started, g.is_complete,
               g.tournament_complete, g.tournament_name, g.created_at, g.completed_at,
               COUNT(gp.id)::int AS participant_count
        FROM games g
        LEFT JOIN game_participants gp ON gp.game_id = g.id
        GROUP BY g.id
        ORDER BY g.created_at DESC
      `),
      getGameCreationRoles(),
      // Non-rollover wins only — a rollover row has no user to pay, its
      // prize_amount is just the carrying pot size, not worth exposing here.
      pool.query(`
        SELECT lw.id, lw.game_id, g.name AS game_name, lw.username, lw.final_week, lw.prize_amount
        FROM lms_winners lw
        JOIN games g ON g.id = lw.game_id
        WHERE lw.is_rollover = FALSE
        ORDER BY lw.created_at DESC
      `),
    ]);
    res.render('admin', {
      users:  usersRes.rows,
      games:  gamesRes.rows,
      lmsWinners: lmsWinnersRes.rows,
      emailConfigured: isEmailConfigured(),
      gameCreationRoles,
      ROLE_OPTIONS,
      success: req.query.success || null,
      error:   req.query.error   || null,
    });
  } catch (err) {
    console.error('[admin]', err);
    res.redirect('/');
  }
});

// ── POST /admin/settings/game-creation ──────────────────────────────────────────
router.post('/settings/game-creation', requireAdmin, async (req, res) => {
  const rawRoles = Array.isArray(req.body.roles) ? req.body.roles : req.body.roles ? [req.body.roles] : [];
  if (rawRoles.length === 0) {
    return res.redirect('/admin?error=' + encodeURIComponent('Select at least one option for who can create games.'));
  }
  try {
    const saved = await setGameCreationRoles(rawRoles);
    res.redirect('/admin?success=' + encodeURIComponent(
      `Game creation is now allowed for: ${saved.join(', ')}.`
    ));
  } catch (err) {
    console.error('[admin settings/game-creation]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not save setting.'));
  }
});

// ── POST /admin/delete-user ───────────────────────────────────────────────────
router.post('/delete-user', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.body.user_id);
  if (!targetId || targetId === req.session.user.id) {
    return res.redirect('/admin?error=' + encodeURIComponent('Cannot delete that user.'));
  }
  try {
    const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [targetId]);
    if (!rows[0]) return res.redirect('/admin?error=' + encodeURIComponent('User not found.'));
    await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
    res.redirect('/admin?success=' + encodeURIComponent(`User "${rows[0].username}" deleted.`));
  } catch (err) {
    console.error('[admin delete-user]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not delete user.'));
  }
});

// ── POST /admin/toggle-paid ───────────────────────────────────────────────────
router.post('/toggle-paid', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.body.user_id);
  if (!targetId) return res.redirect('/admin?error=' + encodeURIComponent('Invalid user.'));
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_paid = NOT is_paid WHERE id = $1 RETURNING username, is_paid',
      [targetId]
    );
    if (!rows[0]) return res.redirect('/admin?error=' + encodeURIComponent('User not found.'));
    res.redirect('/admin?success=' + encodeURIComponent(
      `${rows[0].username} is now ${rows[0].is_paid ? 'paid' : 'free'}.`
    ));
  } catch (err) {
    console.error('[admin toggle-paid]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not update user.'));
  }
});

// ── POST /admin/toggle-admin ──────────────────────────────────────────────────
router.post('/toggle-admin', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.body.user_id);
  if (!targetId || targetId === req.session.user.id) {
    return res.redirect('/admin?error=' + encodeURIComponent('Cannot change your own admin status.'));
  }
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_admin = NOT is_admin WHERE id = $1 RETURNING username, is_admin',
      [targetId]
    );
    if (!rows[0]) return res.redirect('/admin?error=' + encodeURIComponent('User not found.'));
    res.redirect('/admin?success=' + encodeURIComponent(
      `${rows[0].username} is now ${rows[0].is_admin ? 'an admin' : 'a regular user'}.`
    ));
  } catch (err) {
    console.error('[admin toggle-admin]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not update user.'));
  }
});

// ── POST /admin/toggle-ban ────────────────────────────────────────────────────
router.post('/toggle-ban', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.body.user_id);
  if (!targetId || targetId === req.session.user.id) {
    return res.redirect('/admin?error=' + encodeURIComponent('Cannot ban yourself.'));
  }
  try {
    const { rows } = await pool.query(
      'UPDATE users SET is_banned = NOT is_banned WHERE id = $1 RETURNING username, is_banned',
      [targetId]
    );
    if (!rows[0]) return res.redirect('/admin?error=' + encodeURIComponent('User not found.'));
    res.redirect('/admin?success=' + encodeURIComponent(
      `${rows[0].username} is now ${rows[0].is_banned ? 'suspended' : 'unsuspended'}.`
    ));
  } catch (err) {
    console.error('[admin toggle-ban]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not update user.'));
  }
});

// ── POST /admin/reset-password ────────────────────────────────────────────────
router.post('/reset-password', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.body.user_id);
  if (!targetId) return res.redirect('/admin?error=' + encodeURIComponent('Invalid user.'));
  try {
    const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [targetId]);
    if (!rows[0]) return res.redirect('/admin?error=' + encodeURIComponent('User not found.'));
    const tempPassword = generateTempPassword();
    const hash = await bcrypt.hash(tempPassword, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = TRUE WHERE id = $2',
      [hash, targetId]
    );
    res.redirect('/admin?success=' + encodeURIComponent(
      `Temp password for ${rows[0].username}: ${tempPassword} (they must change it on next login)`
    ));
  } catch (err) {
    console.error('[admin reset-password]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not reset password.'));
  }
});

// ── POST /admin/impersonate ───────────────────────────────────────────────────
router.post('/impersonate', requireAdmin, async (req, res) => {
  const targetId = parseInt(req.body.user_id);
  if (!targetId || targetId === req.session.user.id) {
    return res.redirect('/admin?error=' + encodeURIComponent('Cannot impersonate that user.'));
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, username, is_admin, is_paid FROM users WHERE id = $1',
      [targetId]
    );
    if (!rows[0]) return res.redirect('/admin?error=' + encodeURIComponent('User not found.'));
    req.session.adminUserId = req.session.user.id;
    req.session.user = { id: rows[0].id, username: rows[0].username, isAdmin: rows[0].is_admin, isPaid: rows[0].is_paid || false };
    res.redirect('/');
  } catch (err) {
    console.error('[admin impersonate]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not impersonate user.'));
  }
});

// ── POST /admin/unimpersonate ─────────────────────────────────────────────────
router.post('/unimpersonate', async (req, res) => {
  if (!req.session.adminUserId) return res.redirect('/');
  try {
    const { rows } = await pool.query(
      'SELECT id, username, is_admin, is_paid FROM users WHERE id = $1',
      [req.session.adminUserId]
    );
    if (!rows[0]) { req.session.destroy(); return res.redirect('/'); }
    req.session.user = { id: rows[0].id, username: rows[0].username, isAdmin: rows[0].is_admin, isPaid: rows[0].is_paid || false };
    delete req.session.adminUserId;
    res.redirect('/admin');
  } catch (err) {
    console.error('[admin unimpersonate]', err);
    res.redirect('/');
  }
});

// ── GET /admin/network-test — raw TCP connect checks (no SMTP protocol, no
// auth) against Brevo's relay on all three ports plus a couple of unrelated
// hosts, to tell a Railway-wide outbound block apart from Brevo specifically
// blocking connections from cloud/datacenter IP ranges ─────────────────────
router.get('/network-test', requireAdmin, async (req, res) => {
  function checkConnect(host, port, timeoutMs = 5000) {
    return new Promise(resolve => {
      const start = Date.now();
      const socket = net.createConnection({ host, port, timeout: timeoutMs });
      const finish = (result) => {
        socket.destroy();
        resolve({ host, port, ms: Date.now() - start, ...result });
      };
      socket.on('connect', () => finish({ ok: true }));
      socket.on('timeout', () => finish({ ok: false, error: 'timeout' }));
      socket.on('error', (err) => finish({ ok: false, error: err.code || err.message }));
    });
  }

  const targets = [
    ['google.com', 443],
    ['smtp-relay.brevo.com', 587],
    ['smtp-relay.brevo.com', 465],
    ['smtp-relay.brevo.com', 2525],
    ['smtp.gmail.com', 587],
  ];
  const results = await Promise.all(targets.map(([host, port]) => checkConnect(host, port)));
  res.json(results);
});

// ── POST /admin/test-email — send a real test email via the Brevo API and
// report the actual success/failure, unlike the real password-reset flow
// which always shows a generic message regardless of outcome ──────────────
router.post('/test-email', requireAdmin, async (req, res) => {
  const to = req.body.to?.trim();
  if (!to) return res.redirect('/admin?error=' + encodeURIComponent('Enter an email address to test.'));
  try {
    await sendTestEmail(to);
    res.redirect('/admin?success=' + encodeURIComponent(`Test email sent to ${to} — check the inbox (and spam folder).`));
  } catch (err) {
    console.error('[admin test-email]', err);
    res.redirect('/admin?error=' + encodeURIComponent(`Email failed: ${err.message}`));
  }
});

// ── POST /admin/set-lms-prize — correct a historical LMS win's prize_amount,
// since amounts recorded before the per-player-rate multiplication fix are
// too low and can't be safely recomputed automatically ─────────────────────
router.post('/set-lms-prize', requireAdmin, async (req, res) => {
  const winnerId = parseInt(req.body.winner_id);
  const amount   = parseFloat(req.body.prize_amount);
  if (!winnerId || isNaN(amount) || amount < 0) {
    return res.redirect('/admin?error=' + encodeURIComponent('Invalid prize amount.'));
  }
  try {
    await pool.query('UPDATE lms_winners SET prize_amount = $1 WHERE id = $2', [amount, winnerId]);
    res.redirect('/admin?success=' + encodeURIComponent('Prize amount updated.'));
  } catch (err) {
    console.error('[admin set-lms-prize]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not update prize amount.'));
  }
});

// ── POST /admin/set-team-name ─────────────────────────────────────────────────
router.post('/set-team-name', requireAdmin, async (req, res) => {
  const gameId   = parseInt(req.body.game_id);
  const username = req.body.username?.trim();
  const teamName = req.body.team_name?.trim() || null;
  if (!gameId || !username) {
    return res.redirect('/admin?error=' + encodeURIComponent('Game ID and username required.'));
  }
  try {
    const { rows: users } = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
    if (!users[0]) return res.redirect('/admin?error=' + encodeURIComponent('User not found.'));
    const { rowCount } = await pool.query(
      'UPDATE game_participants SET team_name = $1 WHERE game_id = $2 AND user_id = $3',
      [teamName, gameId, users[0].id]
    );
    if (rowCount === 0) return res.redirect('/admin?error=' + encodeURIComponent('User is not in that game.'));
    res.redirect('/admin?success=' + encodeURIComponent(
      teamName ? `Team name for ${username} in game ${gameId} set to "${teamName}".`
               : `Team name for ${username} in game ${gameId} cleared.`
    ));
  } catch (err) {
    console.error('[admin set-team-name]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not set team name.'));
  }
});

// ── POST /admin/rename-pick ───────────────────────────────────────────────────
router.post('/rename-pick', requireAdmin, async (req, res) => {
  const gameId  = parseInt(req.body.game_id);
  const oldName = req.body.old_name?.trim();
  const newName = req.body.new_name?.trim();
  if (!gameId || !oldName || !newName) {
    return res.redirect('/admin?error=' + encodeURIComponent('All fields required.'));
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE picks SET player_name = $1 WHERE game_id = $2 AND LOWER(player_name) = LOWER($3)',
      [newName, gameId, oldName]
    );
    res.redirect('/admin?success=' + encodeURIComponent(
      `Renamed "${oldName}" → "${newName}" in game ${gameId} (${rowCount} pick(s) updated).`
    ));
  } catch (err) {
    console.error('[admin rename-pick]', err);
    res.redirect('/admin?error=' + encodeURIComponent('Could not rename pick.'));
  }
});

// ── GET /admin/espn-debug/:gameId — show raw ESPN cut statuses ────────────────
router.get('/espn-debug/:gameId', requireAdmin, async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  try {
    const { rows } = await pool.query('SELECT tournament_id, name FROM games WHERE id=$1', [gameId]);
    if (!rows[0]) return res.send('Game not found');
    const { tournament_id, name } = rows[0];
    if (!tournament_id) return res.send('No tournament linked to this game');

    const data = await fetchJSON(`${ESPN_SCOREBOARD}?tournamentId=${tournament_id}&lang=en`);
    const competitors = data.events?.[0]?.competitions?.[0]?.competitors || [];

    // Also get current DB leaderboard for this game
    const { rows: lb } = await pool.query(
      'SELECT player_name, made_cut FROM leaderboard WHERE game_id=$1 ORDER BY player_name',
      [gameId]
    );
    const dbMap = Object.fromEntries(lb.map(r => [r.player_name.toLowerCase(), r.made_cut]));

    const currentPeriod = data.events?.[0]?.competitions?.[0]?.status?.period || 1;
    const rows2 = competitors.map(c => {
      const lsPeriodsRaw = (c.linescores || []).map(ls => ls.period);
      const hasR3 = lsPeriodsRaw.includes(3);
      const name  = c.athlete?.displayName || '?';
      return {
        name: escapeHtml(name),
        score:      c.score,
        lsPeriods:  lsPeriodsRaw.join(',') || '(none)',
        hasR3,
        db_made_cut: dbMap[name.toLowerCase()] ?? '(not in DB)',
      };
    });

    const r3HasStarted = currentPeriod >= 3 && rows2.some(r => r.hasR3);

    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <h2>ESPN Debug: ${escapeHtml(name)} (game ${gameId})</h2>
      <p>Tournament ID: ${tournament_id} · Current period: ${currentPeriod} · R3 started: ${r3HasStarted}</p>
      <p><em>Cut detection: ${r3HasStarted ? 'ACTIVE — players without R3 linescore = missed cut' : 'NOT YET — still in R1/R2'}</em></p>
      <table border="1" cellpadding="4" style="border-collapse:collapse;font-family:monospace;font-size:13px">
        <tr><th>ESPN Name</th><th>score</th><th>linescore periods</th><th>hasR3</th><th>→ made_cut</th><th>DB made_cut</th></tr>
        ${rows2.map(r => {
          const computed = r3HasStarted ? r.hasR3 : null;
          const mismatch = computed !== null && computed !== r.db_made_cut;
          return `<tr style="background:${!r.hasR3 && r3HasStarted ? '#fee2e2' : mismatch ? '#fef9c3' : ''}">
            <td>${r.name}</td><td>${r.score}</td><td>${r.lsPeriods}</td>
            <td>${r.hasR3}</td><td>${computed}</td><td>${r.db_made_cut}</td>
          </tr>`;
        }).join('')}
      </table>
    `);
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

// ── GET /admin/scorecard-debug/:gameId — raw data behind the scorecard prize
// calc (game row, teams, participants) so a real reported discrepancy in
// profile winnings can be diagnosed against actual data instead of guesswork ──
router.get('/scorecard-debug/:gameId', requireAdmin, async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  try {
    const { rows: gameRows } = await pool.query(
      `SELECT id, name, game_type, scorecard_format, scorecard_entry_fee,
              tournament_complete, winner_username, winner_individual_username
       FROM games WHERE id = $1`,
      [gameId]
    );
    const { rows: teams } = await pool.query(
      'SELECT id, name FROM scorecard_teams WHERE game_id = $1 ORDER BY id',
      [gameId]
    );
    const { rows: participants } = await pool.query(
      `SELECT gp.id AS participant_id, u.id AS user_id, u.username,
              gp.scorecard_team_id, st.name AS team_name
       FROM game_participants gp
       JOIN users u ON u.id = gp.user_id
       LEFT JOIN scorecard_teams st ON st.id = gp.scorecard_team_id
       WHERE gp.game_id = $1
       ORDER BY st.name NULLS LAST, u.username`,
      [gameId]
    );
    res.json({ game: gameRows[0] || null, teams, participants });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/golf-draft-debug/:gameId — compares the stored winner_username
// against a fresh live recomputation, to diagnose a reported "should have won
// the team pot" discrepancy against real data ──────────────────────────────
router.get('/golf-draft-debug/:gameId', requireAdmin, async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  try {
    const { rows: gameRows } = await pool.query(
      `SELECT id, name, game_type, tournament_complete, prize_team, prize_individual,
              winner_username, winner_individual_username
       FROM games WHERE id = $1`,
      [gameId]
    );
    const { rows: rawRows } = await pool.query(`
      SELECT u.username, gp.user_id,
             ARRAY_AGG(l.score_to_par ORDER BY l.score_to_par ASC) FILTER (WHERE l.score_to_par IS NOT NULL) AS scores,
             COUNT(CASE WHEN l.made_cut = TRUE THEN 1 END)::int AS cut_makers,
             ARRAY_AGG(p.player_name) AS picks
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      LEFT JOIN picks p ON p.user_id = gp.user_id AND p.game_id = gp.game_id
      LEFT JOIN leaderboard l ON l.game_id = gp.game_id
                              AND LOWER(TRIM(l.player_name)) = LOWER(TRIM(p.player_name))
      WHERE gp.game_id = $1
      GROUP BY u.username, gp.user_id
    `, [gameId]);
    const liveComputed = await computeGolfDraftWinner(pool, gameId);
    res.json({ game: gameRows[0] || null, liveComputed, perPlayer: rawRows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/lms-fixtures-debug/:gameId — raw ESPN fixture data (including
// each match's status.type.name) for an LMS game's current gameweek window.
// Postponed-fixture detection relies on ESPN's status.type.name being
// "STATUS_POSTPONED"/"STATUS_CANCELED" — not verified against a live
// postponed match when this was built, so worth checking here the next time
// a real postponement happens.
router.get('/lms-fixtures-debug/:gameId', requireAdmin, async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  try {
    const { rows: gameRows } = await pool.query(
      'SELECT id, name, game_type, lms_leagues, lms_current_week FROM games WHERE id = $1',
      [gameId]
    );
    const game = gameRows[0];
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.game_type !== 'last_man_standing') return res.status(400).json({ error: 'Not an LMS game' });

    const leagues = (game.lms_leagues || 'eng.1').split(',').map(s => s.trim()).filter(Boolean);
    const { fixtures } = await getCurrentGameweekFixtures(leagues);
    const effectiveFixtures = fixtures.filter(f => !f.postponed).length;

    res.json({
      game,
      effectiveFixtures,
      wouldSkipWeek: fixtures.length > 0 && effectiveFixtures <= 5,
      fixtures: fixtures.map(f => ({
        home: f.homeTeam.name, away: f.awayTeam.name, kickoff: f.kickoff,
        completed: f.completed, postponed: f.postponed,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/lms-state-debug/:gameId — read-only snapshot of an LMS game's
// current state (game row, remaining weeks/winners rows) — for diagnosing
// something like an unexpected rollover after the fact, since lms_weeks/
// lms_picks for a concluded round are hard-deleted by resetToLobby/restartRound.
router.get('/lms-state-debug/:gameId', requireAdmin, async (req, res) => {
  const gameId = parseInt(req.params.gameId);
  try {
    const { rows: gameRows } = await pool.query(
      `SELECT id, name, game_type, is_started, is_complete, lms_current_week,
              lms_continuous, prize_individual, host_user_id
       FROM games WHERE id = $1`,
      [gameId]
    );
    const game = gameRows[0];
    if (!game) return res.status(404).json({ error: 'Game not found' });
    if (game.game_type !== 'last_man_standing') return res.status(400).json({ error: 'Not an LMS game' });

    const [weeksRes, winnersRes, picksRes] = await Promise.all([
      pool.query('SELECT * FROM lms_weeks WHERE game_id = $1 ORDER BY week_number', [gameId]),
      pool.query('SELECT * FROM lms_winners WHERE game_id = $1 ORDER BY id', [gameId]),
      pool.query('SELECT week_number, count(*) FROM lms_picks WHERE game_id = $1 GROUP BY week_number ORDER BY week_number', [gameId]),
    ]);

    res.json({ game, weeks: weeksRes.rows, winners: winnersRes.rows, picksByWeek: picksRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/lms-fix-game10-history — ONE-TIME repair for game 10.
// A stale-deadline bug caused two back-to-back bogus rollovers that hard-deleted
// the real week 1 picks (lms_picks/lms_weeks get wiped on every rollover by
// design). This reconstructs that real week 1 from the actual ESPN results
// (captured before the wipe) plus the host's own records of who picked what,
// removes the two bogus rollover entries, resets the prize back to its
// pre-bug value, and reseeds week 2 with the real upcoming fixtures. Delete
// this route once it's been run — it's tailored to this one incident, not a
// reusable tool.
router.post('/lms-fix-game10-history', requireAdmin, async (req, res) => {
  const gameId = 10;

  // Real week 1 fixtures/results, exactly as ESPN had them before the window
  // moved on and this became unrecoverable from a live fetch.
  const week1Fixtures = [
    {"id":"401879301","isDraw":false,"league":"eng.1","kickoff":"2026-08-21T19:00Z","awayTeam":{"id":"388","name":"Coventry City","score":0,"shortName":"COV"},"homeTeam":{"id":"359","name":"Arsenal","score":3,"shortName":"ARS"},"winnerId":"359","completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401879322","isDraw":false,"league":"eng.1","kickoff":"2026-08-22T11:30Z","awayTeam":{"id":"360","name":"Manchester United","score":0,"shortName":"MAN"},"homeTeam":{"id":"306","name":"Hull City","score":2,"shortName":"HUL"},"winnerId":"306","completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401880328","isDraw":true,"league":"eng.2","kickoff":"2026-08-22T11:30Z","awayTeam":{"id":"333","name":"Bristol City","score":2,"shortName":"BRC"},"homeTeam":{"id":"392","name":"Birmingham City","score":2,"shortName":"BIR"},"winnerId":null,"completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880325","isDraw":false,"league":"eng.2","kickoff":"2026-08-22T11:30Z","awayTeam":{"id":"385","name":"Portsmouth","score":3,"shortName":"POR"},"homeTeam":{"id":"314","name":"Lincoln City","score":1,"shortName":"LCN"},"winnerId":"385","completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880324","isDraw":false,"league":"eng.2","kickoff":"2026-08-22T11:30Z","awayTeam":{"id":"381","name":"Norwich City","score":0,"shortName":"NOR"},"homeTeam":{"id":"391","name":"Millwall","score":3,"shortName":"MIL"},"winnerId":"391","completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401879300","isDraw":false,"league":"eng.1","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"384","name":"Crystal Palace","score":0,"shortName":"CRY"},"homeTeam":{"id":"368","name":"Everton","score":2,"shortName":"EVE"},"winnerId":"368","completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401879299","isDraw":false,"league":"eng.1","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"366","name":"Sunderland","score":1,"shortName":"SUN"},"homeTeam":{"id":"373","name":"Ipswich Town","score":2,"shortName":"IPS"},"winnerId":"373","completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401879298","isDraw":false,"league":"eng.1","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"357","name":"Leeds United","score":1,"shortName":"LEE"},"homeTeam":{"id":"393","name":"Nottingham Forest","score":0,"shortName":"NFO"},"winnerId":"357","completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401880327","isDraw":false,"league":"eng.2","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"369","name":"Middlesbrough","score":1,"shortName":"MID"},"homeTeam":{"id":"365","name":"Blackburn Rovers","score":2,"shortName":"BLK"},"winnerId":"365","completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880326","isDraw":true,"league":"eng.2","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"347","name":"Cardiff City","score":2,"shortName":"CAR"},"homeTeam":{"id":"374","name":"Derby County","score":2,"shortName":"DER"},"winnerId":null,"completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880323","isDraw":false,"league":"eng.2","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"380","name":"Wolverhampton Wanderers","score":3,"shortName":"WOL"},"homeTeam":{"id":"394","name":"Preston North End","score":1,"shortName":"PNE"},"winnerId":"380","completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880322","isDraw":true,"league":"eng.2","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"358","name":"Bolton Wanderers","score":0,"shortName":"BOL"},"homeTeam":{"id":"334","name":"Queens Park Rangers","score":0,"shortName":"QPR"},"winnerId":null,"completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880321","isDraw":false,"league":"eng.2","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"336","name":"Stoke City","score":1,"shortName":"STK"},"homeTeam":{"id":"376","name":"Southampton","score":3,"shortName":"SOU"},"winnerId":"376","completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880320","isDraw":true,"league":"eng.2","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"398","name":"Sheffield United","score":0,"shortName":"SHU"},"homeTeam":{"id":"318","name":"Swansea City","score":0,"shortName":"SWA"},"winnerId":null,"completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880318","isDraw":false,"league":"eng.2","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"372","name":"Charlton Athletic","score":2,"shortName":"CHA"},"homeTeam":{"id":"371","name":"West Ham United","score":1,"shortName":"WHU"},"winnerId":"372","completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401880317","isDraw":true,"league":"eng.2","kickoff":"2026-08-22T14:00Z","awayTeam":{"id":"395","name":"Watford","score":1,"shortName":"WAT"},"homeTeam":{"id":"352","name":"Wrexham","score":1,"shortName":"WXM"},"winnerId":null,"completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401879321","isDraw":false,"league":"eng.1","kickoff":"2026-08-22T16:30Z","awayTeam":{"id":"367","name":"Tottenham Hotspur","score":0,"shortName":"TOT"},"homeTeam":{"id":"337","name":"Brentford","score":3,"shortName":"BRE"},"winnerId":"337","completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401880319","isDraw":false,"league":"eng.2","kickoff":"2026-08-23T11:00Z","awayTeam":{"id":"379","name":"Burnley","score":1,"shortName":"BUR"},"homeTeam":{"id":"383","name":"West Bromwich Albion","score":3,"shortName":"WBA"},"winnerId":"383","completed":true,"postponed":false,"leagueName":"Championship"},
    {"id":"401879297","isDraw":false,"league":"eng.1","kickoff":"2026-08-23T13:00Z","awayTeam":{"id":"362","name":"Aston Villa","score":0,"shortName":"AVL"},"homeTeam":{"id":"331","name":"Brighton & Hove Albion","score":4,"shortName":"BHA"},"winnerId":"331","completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401879320","isDraw":false,"league":"eng.1","kickoff":"2026-08-23T13:00Z","awayTeam":{"id":"349","name":"AFC Bournemouth","score":1,"shortName":"BOU"},"homeTeam":{"id":"382","name":"Manchester City","score":2,"shortName":"MNC"},"winnerId":"382","completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401879319","isDraw":true,"league":"eng.1","kickoff":"2026-08-23T15:30Z","awayTeam":{"id":"364","name":"Liverpool","score":2,"shortName":"LIV"},"homeTeam":{"id":"361","name":"Newcastle United","score":2,"shortName":"NEW"},"winnerId":null,"completed":true,"postponed":false,"leagueName":"Premier League"},
    {"id":"401879318","isDraw":false,"league":"eng.1","kickoff":"2026-08-24T19:00Z","awayTeam":{"id":"363","name":"Chelsea","score":3,"shortName":"CHE"},"homeTeam":{"id":"370","name":"Fulham","score":2,"shortName":"FUL"},"winnerId":"363","completed":true,"postponed":false,"leagueName":"Premier League"},
  ];

  // Who picked what in the real week 1, reconstructed from the host's records
  // and cross-checked against the fixtures above (Arsenal/Man City won,
  // Man United/West Ham lost — matches exactly).
  const picks = [
    { username: 'Preece',     team_id: '382', team_name: 'Manchester City',   result: 'win'  },
    { username: 'Cmac7',      team_id: '359', team_name: 'Arsenal',           result: 'win'  },
    { username: 'TylerBrunt', team_id: '359', team_name: 'Arsenal',           result: 'win'  },
    { username: 'olishingerz',team_id: '360', team_name: 'Manchester United', result: 'loss' },
    { username: 'Coleman',    team_id: '371', team_name: 'West Ham United',   result: 'loss' },
    { username: 'JHoops',     team_id: '360', team_name: 'Manchester United', result: 'loss' },
    { username: 'Blakey',     team_id: '371', team_name: 'West Ham United',   result: 'loss' },
    { username: 'BigWilly95', team_id: '371', team_name: 'West Ham United',   result: 'loss' },
    { username: 'Char',       team_id: '371', team_name: 'West Ham United',   result: 'loss' },
  ];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE games SET prize_individual = 10, lms_current_week = 2 WHERE id = $1',
      [gameId]
    );
    await client.query('DELETE FROM lms_winners WHERE game_id = $1', [gameId]);
    await client.query('DELETE FROM lms_picks WHERE game_id = $1', [gameId]);
    await client.query('DELETE FROM lms_weeks WHERE game_id = $1', [gameId]);
    await client.query(
      `INSERT INTO lms_weeks (game_id, week_number, fixtures_cache, deadline, results_locked, skipped)
       VALUES ($1, 1, $2, $3, TRUE, FALSE)`,
      [gameId, JSON.stringify(week1Fixtures), '2026-08-21T18:00:00.000Z']
    );

    for (const p of picks) {
      const { rows } = await client.query(
        'SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [p.username]
      );
      if (rows.length === 0) throw new Error(`User not found: ${p.username}`);
      await client.query(
        `INSERT INTO lms_picks (game_id, user_id, week_number, team_id, team_name, result)
         VALUES ($1,$2,1,$3,$4,$5)`,
        [gameId, rows[0].id, p.team_id, p.team_name, p.result]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }

  try {
    await refreshFixtureCache(gameId, 2);
  } catch (err) {
    return res.json({ ok: true, warning: 'Week 1 restored, but refreshing week 2 fixtures failed: ' + err.message });
  }

  res.json({ ok: true, message: 'Game 10 restored: week 1 picks/results reinstated, prize reset to £10, bogus rollovers removed, week 2 seeded with real upcoming fixtures.' });
});

module.exports = router;
