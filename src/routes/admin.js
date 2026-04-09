const express = require('express');
const { pool } = require('../db');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!req.session.user?.isAdmin) return res.redirect('/');
  next();
}

router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows: users } = await pool.query(`
      SELECT u.id, u.username, u.display_name, u.email,
             u.is_admin, u.is_paid, u.created_at, u.last_login,
             COUNT(gp.id)::int AS game_count
      FROM users u
      LEFT JOIN game_participants gp ON gp.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.render('admin', {
      users,
      success: req.query.success || null,
      error:   req.query.error   || null,
    });
  } catch (err) {
    console.error('[admin]', err);
    res.redirect('/');
  }
});

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

module.exports = router;
