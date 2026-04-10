const express = require('express');
const bcrypt  = require('bcrypt');
const { pool } = require('../db');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.user?.isAdmin) return res.redirect('/');
  next();
}

// ── GET /admin ────────────────────────────────────────────────────────────────
router.get('/', requireAdmin, async (req, res) => {
  try {
    const [usersRes, gamesRes] = await Promise.all([
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
               g.tournament_complete, g.tournament_name, g.created_at,
               COUNT(gp.id)::int AS participant_count
        FROM games g
        LEFT JOIN game_participants gp ON gp.game_id = g.id
        GROUP BY g.id
        ORDER BY g.created_at DESC
      `),
    ]);
    res.render('admin', {
      users:  usersRes.rows,
      games:  gamesRes.rows,
      success: req.query.success || null,
      error:   req.query.error   || null,
    });
  } catch (err) {
    console.error('[admin]', err);
    res.redirect('/');
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
    const tempPassword = Math.random().toString(36).slice(2, 10); // e.g. "k4f9xz2m"
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

module.exports = router;
