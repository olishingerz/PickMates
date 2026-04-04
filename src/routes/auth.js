const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, next: req.query.next || '' });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: 'Please fill in all fields.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.render('login', { error: 'Invalid username or password.' });
    }
    req.session.user = { id: user.id, username: user.username, isAdmin: user.is_admin, isPaid: user.is_paid || false };
    if (user.must_change_password) return res.redirect('/auth/change-password');
    const next = req.query.next || req.body.next || '/';
    res.redirect(next.startsWith('/') ? next : '/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong. Please try again.' });
  }
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null });
});

router.post('/register', async (req, res) => {
  const { username, password, confirmPassword } = req.body;

  if (!username || !password || !confirmPassword) {
    return res.render('register', { error: 'Please fill in all fields.' });
  }
  if (username.trim().length < 2 || username.trim().length > 50) {
    return res.render('register', { error: 'Username must be between 2 and 50 characters.' });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Password must be at least 6 characters.' });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'Passwords do not match.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username.trim(), passwordHash]
    );
    const userId   = rows[0].id;

    // First user to register becomes admin
    const { rows: allUsers } = await client.query('SELECT COUNT(*) AS cnt FROM users');
    const isAdmin = parseInt(allUsers[0].cnt) === 1;
    if (isAdmin) {
      await client.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [userId]);
    }

    await client.query('COMMIT');
    req.session.user = { id: userId, username: rows[0].username, isAdmin };
    res.redirect('/');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.render('register', { error: 'That username is already taken.' });
    }
    console.error(err);
    res.render('register', { error: 'Something went wrong. Please try again.' });
  } finally {
    client.release();
  }
});

router.get('/change-password', (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  res.render('change-password', { error: null });
});

router.post('/change-password', async (req, res) => {
  if (!req.session.user) return res.redirect('/auth/login');
  const { password, confirmPassword } = req.body;
  if (!password || !confirmPassword) {
    return res.render('change-password', { error: 'Please fill in all fields.' });
  }
  if (password.length < 6) {
    return res.render('change-password', { error: 'Password must be at least 6 characters.' });
  }
  if (password !== confirmPassword) {
    return res.render('change-password', { error: 'Passwords do not match.' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2',
      [passwordHash, req.session.user.id]
    );
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('change-password', { error: 'Something went wrong. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
