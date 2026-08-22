const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');

const router = express.Router();

// In-memory sliding-window login limiter, keyed by IP+username so one attacker
// hammering a known username can't lock a real player out entirely. Fine at
// this app's scale — swap for a shared store if it's ever run multi-instance.
const loginAttempts = new Map();
const MAX_LOGIN_ATTEMPTS = 8;
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;

function loginRateLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count++;
  }
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, next: req.query.next || '', username: '' });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const next = req.query.next || req.body.next || '';
  if (!username || !password) {
    return res.render('login', { error: 'Please fill in all fields.', next, username: username || '' });
  }

  const rateLimitKey = `${req.ip}:${username.trim().toLowerCase()}`;
  if (loginRateLimited(rateLimitKey)) {
    return res.render('login', { error: 'Incorrect username or password.', next, username });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      recordFailedLogin(rateLimitKey);
      return res.render('login', { error: 'Incorrect username or password.', next, username });
    }
    if (user.is_banned) {
      return res.render('login', { error: 'This account has been suspended. Please contact the host.', next, username });
    }
    loginAttempts.delete(rateLimitKey);
    req.session.user = { id: user.id, username: user.username, isAdmin: user.is_admin, isPaid: user.is_paid || false };
    if (user.must_change_password) return res.redirect('/auth/change-password');
    res.redirect(next.startsWith('/') ? next : '/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong. Please try again.', next, username });
  }
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null, username: '' });
});

router.post('/register', async (req, res) => {
  const { username, password, confirmPassword } = req.body;

  if (!username || !password || !confirmPassword) {
    return res.render('register', { error: 'Please fill in all fields.', username: username || '' });
  }
  if (username.trim().length < 2 || username.trim().length > 50) {
    return res.render('register', { error: 'Username must be between 2 and 50 characters.', username });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Password must be at least 6 characters.', username });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'Passwords do not match.', username });
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
      return res.render('register', { error: 'That username is already taken.', username });
    }
    console.error(err);
    res.render('register', { error: 'Something went wrong. Please try again.', username });
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
