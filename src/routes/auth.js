const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../db');
const { sendPasswordResetEmail } = require('../services/email');

const APP_URL = process.env.APP_URL || 'https://pickmates.up.railway.app';

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
  res.render('login', { error: null, success: req.query.success || null, next: req.query.next || '', username: '' });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const next = req.query.next || req.body.next || '';
  if (!username || !password) {
    return res.render('login', { error: 'Please fill in all fields.', success: null, next, username: username || '' });
  }

  const rateLimitKey = `${req.ip}:${username.trim().toLowerCase()}`;
  if (loginRateLimited(rateLimitKey)) {
    return res.render('login', { error: 'Incorrect username or password.', success: null, next, username });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      recordFailedLogin(rateLimitKey);
      return res.render('login', { error: 'Incorrect username or password.', success: null, next, username });
    }
    if (user.is_banned) {
      return res.render('login', { error: 'This account has been suspended. Please contact the host.', success: null, next, username });
    }
    loginAttempts.delete(rateLimitKey);
    req.session.user = { id: user.id, username: user.username, isAdmin: user.is_admin, isPaid: user.is_paid || false };
    // One-shot email prompt — only for accounts with no email that have never
    // been shown it before; consumed and marked shown on the very next page load.
    req.session.showEmailPrompt = !user.email && !user.email_prompt_shown;
    if (user.must_change_password) return res.redirect('/auth/change-password');
    res.redirect(next.startsWith('/') ? next : '/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong. Please try again.', success: null, next, username });
  }
});

// Same sliding-window pattern as the login limiter, keyed by IP+email — keeps
// this endpoint from being used to spam a given inbox with reset emails or to
// probe which addresses are registered via timing.
const forgotPasswordAttempts = new Map();
const MAX_FORGOT_ATTEMPTS = 5;
const FORGOT_WINDOW_MS    = 15 * 60 * 1000;

function forgotPasswordRateLimited(key) {
  const entry = forgotPasswordAttempts.get(key);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= MAX_FORGOT_ATTEMPTS;
}

function recordForgotPasswordAttempt(key) {
  const now = Date.now();
  const entry = forgotPasswordAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    forgotPasswordAttempts.set(key, { count: 1, resetAt: now + FORGOT_WINDOW_MS });
  } else {
    entry.count++;
  }
}

// Same sliding-window pattern again, keyed by IP alone (there's no existing
// account to key against yet) — keeps registration from being scripted into
// mass account creation. A little more generous than login since a shared
// household/office IP registering several real accounts is plausible.
const registerAttempts = new Map();
const MAX_REGISTER_ATTEMPTS = 10;
const REGISTER_WINDOW_MS    = 15 * 60 * 1000;

function registerRateLimited(key) {
  const entry = registerAttempts.get(key);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= MAX_REGISTER_ATTEMPTS;
}

function recordRegisterAttempt(key) {
  const now = Date.now();
  const entry = registerAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    registerAttempts.set(key, { count: 1, resetAt: now + REGISTER_WINDOW_MS });
  } else {
    entry.count++;
  }
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

router.get('/forgot-password', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('forgot-password', { error: null, success: null });
});

router.post('/forgot-password', async (req, res) => {
  const email = req.body.email?.trim();
  // Always the same response whether or not the address is registered, and
  // even when rate-limited — anything else would let someone enumerate which
  // emails have accounts.
  const genericSuccess = "If that email address is registered, we've sent a password reset link.";

  if (!email) {
    return res.render('forgot-password', { error: 'Please enter your email address.', success: null });
  }

  const rateLimitKey = `${req.ip}:${email.toLowerCase()}`;
  if (forgotPasswordRateLimited(rateLimitKey)) {
    return res.render('forgot-password', { error: null, success: genericSuccess });
  }
  recordForgotPasswordAttempt(rateLimitKey);

  try {
    const { rows } = await pool.query('SELECT id, username, email FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    const user = rows[0];
    if (user) {
      const rawToken  = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      await pool.query(
        'UPDATE users SET reset_token_hash = $1, reset_token_expires = $2 WHERE id = $3',
        [tokenHash, new Date(Date.now() + RESET_TOKEN_TTL_MS), user.id]
      );
      const resetUrl = `${APP_URL}/auth/reset-password/${rawToken}`;
      sendPasswordResetEmail(user, resetUrl).catch(e => console.warn('[forgot-password] email failed:', e.message));
    }
    res.render('forgot-password', { error: null, success: genericSuccess });
  } catch (err) {
    console.error('[forgot-password]', err);
    res.render('forgot-password', { error: 'Something went wrong. Please try again.', success: null });
  }
});

router.get('/reset-password/:token', async (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires > NOW()',
      [tokenHash]
    );
    if (!rows[0]) {
      return res.render('reset-password', { error: 'This reset link is invalid or has expired.', valid: false, token: req.params.token });
    }
    res.render('reset-password', { error: null, valid: true, token: req.params.token });
  } catch (err) {
    console.error('[reset-password GET]', err);
    res.render('reset-password', { error: 'Something went wrong. Please try again.', valid: false, token: req.params.token });
  }
});

router.post('/reset-password/:token', async (req, res) => {
  const { password, confirmPassword } = req.body;
  const token = req.params.token;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  if (!password || !confirmPassword) {
    return res.render('reset-password', { error: 'Please fill in all fields.', valid: true, token });
  }
  if (password.length < 6) {
    return res.render('reset-password', { error: 'Password must be at least 6 characters.', valid: true, token });
  }
  if (password !== confirmPassword) {
    return res.render('reset-password', { error: 'Passwords do not match.', valid: true, token });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires > NOW()',
      [tokenHash]
    );
    const user = rows[0];
    if (!user) {
      return res.render('reset-password', { error: 'This reset link is invalid or has expired.', valid: false, token });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = FALSE,
                         reset_token_hash = NULL, reset_token_expires = NULL
       WHERE id = $2`,
      [passwordHash, user.id]
    );
    res.redirect('/auth/login?success=' + encodeURIComponent('Password reset — you can now log in.'));
  } catch (err) {
    console.error('[reset-password POST]', err);
    res.render('reset-password', { error: 'Something went wrong. Please try again.', valid: true });
  }
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null, username: '', email: '' });
});

router.post('/register', async (req, res) => {
  const { username, password, confirmPassword } = req.body;
  const email = req.body.email?.trim().toLowerCase() || '';

  if (registerRateLimited(req.ip)) {
    return res.render('register', { error: 'Too many attempts — please try again in a few minutes.', username: username || '', email });
  }
  recordRegisterAttempt(req.ip);

  if (!username || !password || !confirmPassword || !email) {
    return res.render('register', { error: 'Please fill in all fields.', username: username || '', email });
  }
  if (username.trim().length < 2 || username.trim().length > 50) {
    return res.render('register', { error: 'Username must be between 2 and 50 characters.', username, email });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render('register', { error: 'Please enter a valid email address.', username, email });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Password must be at least 6 characters.', username, email });
  }
  if (password !== confirmPassword) {
    return res.render('register', { error: 'Passwords do not match.', username, email });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const passwordHash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      'INSERT INTO users (username, password_hash, email) VALUES ($1, $2, $3) RETURNING id, username',
      [username.trim(), passwordHash, email]
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
      const message = err.constraint === 'users_email_key'
        ? 'That email address is already registered.'
        : 'That username is already taken.';
      return res.render('register', { error: message, username, email });
    }
    console.error(err);
    res.render('register', { error: 'Something went wrong. Please try again.', username, email });
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
