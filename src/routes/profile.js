const express = require('express');
const bcrypt  = require('bcrypt');
const multer  = require('multer');
const { pool } = require('../db');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/auth/login');
  next();
}

router.get('/', requireAuth, async (req, res) => {
  const id = req.session.user.id;
  const [profileRes, golfRes, lmsRes, scorecardRes, winningsRes, scorecardWinningsRes] = await Promise.all([
    pool.query('SELECT username, avatar, email, notify_draft_turn, notify_lms_deadline FROM users WHERE id = $1', [id]),
    pool.query(`
      SELECT
        COUNT(DISTINCT gp.game_id) FILTER (WHERE g.game_type = 'golf_draft')::int        AS golf_played,
        COUNT(*)                   FILTER (WHERE g.winner_username = u.username
                                              AND g.tournament_complete = TRUE)::int       AS team_wins,
        COUNT(*)                   FILTER (WHERE g.winner_individual_username = u.username
                                              AND g.tournament_complete = TRUE)::int       AS indiv_wins
      FROM users u
      LEFT JOIN game_participants gp ON gp.user_id = u.id
      LEFT JOIN games g ON g.id = gp.game_id AND g.game_type = 'golf_draft'
      WHERE u.id = $1
    `, [id]),
    pool.query(`
      SELECT
        COUNT(DISTINCT gp.game_id) FILTER (WHERE g.game_type = 'last_man_standing')::int  AS lms_played,
        COUNT(*)                   FILTER (WHERE g.winner_username = u.username
                                              AND g.tournament_complete = TRUE)::int        AS lms_wins,
        MAX(lp.week_number)        FILTER (WHERE lp.result != 'pending')                   AS furthest_week
      FROM users u
      LEFT JOIN game_participants gp ON gp.user_id = u.id
      LEFT JOIN games g ON g.id = gp.game_id AND g.game_type = 'last_man_standing'
      LEFT JOIN lms_picks lp ON lp.game_id = gp.game_id AND lp.user_id = u.id
      WHERE u.id = $1
    `, [id]),
    pool.query(`
      SELECT
        COUNT(DISTINCT gp.game_id) FILTER (WHERE g.game_type = 'golf_scorecard')::int      AS scorecard_played,
        COUNT(*)                   FILTER (WHERE st.name = g.winner_username
                                              AND g.tournament_complete = TRUE)::int         AS scorecard_wins,
        COUNT(*)                   FILTER (WHERE g.winner_individual_username = u.username
                                              AND g.game_type = 'golf_scorecard'
                                              AND g.tournament_complete = TRUE)::int         AS scorecard_indiv_wins
      FROM users u
      LEFT JOIN game_participants gp ON gp.user_id = u.id
      LEFT JOIN games g ON g.id = gp.game_id AND g.game_type = 'golf_scorecard'
      LEFT JOIN scorecard_teams st ON st.id = gp.scorecard_team_id
      WHERE u.id = $1
    `, [id]),
    // Golf Draft: prize_team/prize_individual are PER-PLAYER rates (see
    // game.ejs's own "rate * participant count" pot display) — the winner
    // actually receives rate × number of players in that game, not the raw
    // stored rate. LMS uses lms_winners.prize_amount instead, a per-win
    // snapshot of the real payout, since games.prize_individual is a live pot
    // that mutates on rollover and isn't a reliable history.
    pool.query(`
      SELECT
        (SELECT COALESCE(SUM(CASE WHEN g.winner_username = u.username THEN g.prize_team * pc.cnt ELSE 0 END)
                        + SUM(CASE WHEN g.winner_individual_username = u.username THEN g.prize_individual * pc.cnt ELSE 0 END), 0)
         FROM games g
         JOIN (SELECT game_id, COUNT(*) AS cnt FROM game_participants GROUP BY game_id) pc ON pc.game_id = g.id
         WHERE g.game_type = 'golf_draft' AND g.tournament_complete = TRUE
           AND (g.winner_username = u.username OR g.winner_individual_username = u.username)) AS golf_winnings,
        (SELECT COALESCE(SUM(prize_amount), 0) FROM lms_winners WHERE user_id = u.id) AS lms_winnings
      FROM users u
      WHERE u.id = $1
    `, [id]),
    // Golf Scorecard prizes aren't stored anywhere — scorecard.ejs computes them
    // live from entry fee × player count (50/40/10 split of team/individual/CTP
    // for team format, 70/30 individual/CTP for individual format). Mirror that
    // math here per completed game the user was in, so the team prize (unlike
    // Golf Draft's single winner) gets divided across the winning team's actual
    // members rather than counted in full. Closest-to-the-pin isn't included —
    // there's no reliable "who held it at completion" history to attribute it.
    pool.query(`
      SELECT g.id, g.scorecard_entry_fee, g.scorecard_format, g.winner_username, g.winner_individual_username,
             u.username AS my_username, st.name AS my_team_name,
             (SELECT COUNT(*) FROM game_participants gp2 WHERE gp2.game_id = g.id) AS total_players,
             (SELECT COUNT(*) FROM game_participants gp3
                JOIN scorecard_teams st3 ON st3.id = gp3.scorecard_team_id
                WHERE gp3.game_id = g.id AND st3.name = g.winner_username) AS winning_team_size
      FROM games g
      JOIN game_participants gp ON gp.game_id = g.id AND gp.user_id = $1
      JOIN users u ON u.id = $1
      LEFT JOIN scorecard_teams st ON st.id = gp.scorecard_team_id
      WHERE g.game_type = 'golf_scorecard' AND g.tournament_complete = TRUE
        AND g.scorecard_entry_fee > 0
    `, [id]),
  ]);

  const scorecardWinnings = scorecardWinningsRes.rows.reduce((total, row) => {
    const pot = (parseFloat(row.scorecard_entry_fee) || 0) * (row.total_players || 0);
    if (row.scorecard_format === 'individual') {
      const indivPrize = Math.round(pot * 0.7);
      return total + (row.winner_individual_username === row.my_username ? indivPrize : 0);
    }
    const teamPrize  = Math.round(pot * 0.5);
    const indivPrize = Math.round(pot * 0.4);
    let winnings = row.winner_individual_username === row.my_username ? indivPrize : 0;
    if (row.my_team_name && row.my_team_name === row.winner_username && row.winning_team_size > 0) {
      winnings += teamPrize / row.winning_team_size;
    }
    return total + winnings;
  }, 0);

  const totalWinnings = (parseFloat(winningsRes.rows[0]?.golf_winnings) || 0)
                       + (parseFloat(winningsRes.rows[0]?.lms_winnings) || 0)
                       + scorecardWinnings;

  res.render('profile', {
    profileUser: profileRes.rows[0],
    golfStats:      golfRes.rows[0],
    lmsStats:       lmsRes.rows[0],
    scorecardStats: scorecardRes.rows[0],
    totalWinnings,
    error:   req.query.error   || null,
    success: req.query.success || null,
  });
});

// POST /profile/username
router.post('/username', requireAuth, async (req, res) => {
  const username = req.body.username?.trim();
  if (!username || username.length < 2 || username.length > 50) {
    return res.redirect('/profile?error=' + encodeURIComponent('Username must be between 2 and 50 characters.'));
  }
  try {
    await pool.query('UPDATE users SET username = $1 WHERE id = $2', [username, req.session.user.id]);
    req.session.user.username = username;
    res.redirect('/profile?success=' + encodeURIComponent('Username updated.'));
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect('/profile?error=' + encodeURIComponent('That username is already taken.'));
    }
    console.error(err);
    res.redirect('/profile?error=' + encodeURIComponent('Something went wrong.'));
  }
});

// POST /profile/password
router.post('/password', requireAuth, async (req, res) => {
  const { current_password, password, confirmPassword } = req.body;
  if (!current_password || !password || !confirmPassword) {
    return res.redirect('/profile?error=' + encodeURIComponent('Please fill in all fields.'));
  }
  if (password.length < 6) {
    return res.redirect('/profile?error=' + encodeURIComponent('New password must be at least 6 characters.'));
  }
  if (password !== confirmPassword) {
    return res.redirect('/profile?error=' + encodeURIComponent('New passwords do not match.'));
  }
  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.user.id]);
    if (!(await bcrypt.compare(current_password, rows[0].password_hash))) {
      return res.redirect('/profile?error=' + encodeURIComponent('Current password is incorrect.'));
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.user.id]);
    res.redirect('/profile?success=' + encodeURIComponent('Password updated.'));
  } catch (err) {
    console.error(err);
    res.redirect('/profile?error=' + encodeURIComponent('Something went wrong.'));
  }
});

// POST /profile/email
router.post('/email', requireAuth, async (req, res) => {
  const email = req.body.email?.trim().toLowerCase() || null;
  const notifyDraftTurn   = req.body.notify_draft_turn === '1';
  const notifyLmsDeadline = req.body.notify_lms_deadline === '1';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.redirect('/profile?error=' + encodeURIComponent('Please enter a valid email address.'));
  }
  try {
    await pool.query(
      'UPDATE users SET email = $1, notify_draft_turn = $2, notify_lms_deadline = $3 WHERE id = $4',
      [email || null, notifyDraftTurn, notifyLmsDeadline, req.session.user.id]
    );
    res.redirect('/profile?success=' + encodeURIComponent(email ? 'Email preferences saved.' : 'Email removed.'));
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect('/profile?error=' + encodeURIComponent('That email is already used by another account.'));
    }
    console.error(err);
    res.redirect('/profile?error=' + encodeURIComponent('Something went wrong.'));
  }
});

// POST /profile/avatar
router.post('/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  try {
    let avatarData = null;
    if (req.file) {
      // Store as base64 data URL
      avatarData = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    } else if (req.body.remove_avatar === '1') {
      avatarData = null;
    } else {
      return res.redirect('/profile?error=' + encodeURIComponent('No image selected.'));
    }
    await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarData, req.session.user.id]);
    req.session.user.avatar = avatarData;
    res.redirect('/profile?success=' + encodeURIComponent(avatarData ? 'Profile picture updated.' : 'Profile picture removed.'));
  } catch (err) {
    if (err.message === 'Only image files are allowed.') {
      return res.redirect('/profile?error=' + encodeURIComponent('Only image files are allowed.'));
    }
    console.error(err);
    res.redirect('/profile?error=' + encodeURIComponent('Upload failed — max size is 2 MB.'));
  }
});

module.exports = router;
