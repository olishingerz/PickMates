const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { pool } = require('../db');
const { sendPasswordResetEmail, sendVerificationEmail } = require('../services/email');
const { createRateLimiter } = require('../services/rateLimiter');

const APP_URL = process.env.APP_URL || 'https://pickmates.up.railway.app';
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — more generous than the 1hr password-reset window, since this isn't security-critical

const router = express.Router();

// Generates a verification token, stores its hash, and emails the raw token
// — shared by registration and the profile page's "resend" action.
async function issueVerificationEmail(user) {
  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    'UPDATE users SET email_verify_token_hash = $1, email_verify_token_expires = $2 WHERE id = $3',
    [tokenHash, new Date(Date.now() + EMAIL_VERIFY_TTL_MS), user.id]
  );
  const verifyUrl = `${APP_URL}/auth/verify-email/${rawToken}`;
  sendVerificationEmail(user, verifyUrl).catch(e => console.warn('[verify-email] send failed:', e.message));
}

// Keyed by IP+username so one attacker hammering a known username can't lock
// a real player out entirely.
const loginLimiter = createRateLimiter(8, 15 * 60 * 1000);

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
  if (loginLimiter.isLimited(rateLimitKey)) {
    return res.render('login', { error: 'Incorrect username or password.', success: null, next, username });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      loginLimiter.recordAttempt(rateLimitKey);
      return res.render('login', { error: 'Incorrect username or password.', success: null, next, username });
    }
    if (user.is_banned) {
      return res.render('login', { error: 'This account has been suspended. Please contact the host.', success: null, next, username });
    }
    loginLimiter.reset(rateLimitKey);
    // Regenerate the session on successful login (session-fixation hardening)
    // — a fresh session ID is issued rather than reusing whatever the browser
    // had before authenticating.
    req.session.regenerate((err) => {
      if (err) {
        console.error('[login] session regenerate failed', err);
        return res.render('login', { error: 'Something went wrong. Please try again.', success: null, next, username });
      }
      req.session.user = { id: user.id, username: user.username, isAdmin: user.is_admin, isPaid: user.is_paid || false };
      // One-shot email prompt — only for accounts with no email that have never
      // been shown it before; consumed and marked shown on the very next page
      // load. This only catches a *fresh* login, though — someone already
      // logged in (a persistent session never hits this route again) needs
      // the periodic check in index.js's per-request middleware instead, or
      // they'd never get prompted until their session happens to expire.
      req.session.showEmailPrompt = !user.email && !user.email_prompt_shown;
      if (user.must_change_password) return res.redirect('/auth/change-password');
      res.redirect(next.startsWith('/') ? next : '/');
    });
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong. Please try again.', success: null, next, username });
  }
});

// Keyed by IP+email — keeps this endpoint from being used to spam a given
// inbox with reset emails or to probe which addresses are registered via timing.
const forgotPasswordLimiter = createRateLimiter(5, 15 * 60 * 1000);

// Keyed by IP alone (there's no existing account to key against yet) — keeps
// registration from being scripted into mass account creation. A little more
// generous than login since a shared household/office IP registering several
// real accounts is plausible.
const registerLimiter = createRateLimiter(10, 15 * 60 * 1000);

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
  if (forgotPasswordLimiter.isLimited(rateLimitKey)) {
    return res.render('forgot-password', { error: null, success: genericSuccess });
  }
  forgotPasswordLimiter.recordAttempt(rateLimitKey);

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
    const passwordHash = await bcrypt.hash(password, 12);
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

  if (registerLimiter.isLimited(req.ip)) {
    return res.render('register', { error: 'Too many attempts — please try again in a few minutes.', username: username || '', email });
  }
  registerLimiter.recordAttempt(req.ip);

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

    const passwordHash = await bcrypt.hash(password, 12);
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
    issueVerificationEmail({ id: userId, username: rows[0].username, email }).catch(e => console.warn('[register] verification email failed:', e.message));
    // Regenerate the session on successful registration, same as login —
    // session-fixation hardening, a fresh session ID rather than reusing
    // whatever the browser had before registering.
    req.session.regenerate((err) => {
      if (err) {
        console.error('[register] session regenerate failed', err);
        return res.render('register', { error: 'Something went wrong. Please try again.', username, email });
      }
      req.session.user = { id: userId, username: rows[0].username, isAdmin };
      res.redirect('/');
    });
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

// GET /auth/verify-email/:token — clicked from the verification email
router.get('/verify-email/:token', async (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  try {
    const { rows } = await pool.query(
      'SELECT id FROM users WHERE email_verify_token_hash = $1 AND email_verify_token_expires > NOW()',
      [tokenHash]
    );
    if (!rows[0]) {
      return res.redirect('/?error=' + encodeURIComponent('That verification link is invalid or has expired.'));
    }
    await pool.query(
      'UPDATE users SET email_verified = TRUE, email_verify_token_hash = NULL, email_verify_token_expires = NULL WHERE id = $1',
      [rows[0].id]
    );
    res.redirect((req.session.user ? '/profile' : '/auth/login') + '?success=' + encodeURIComponent('Email verified — thanks!'));
  } catch (err) {
    console.error('[verify-email]', err);
    res.redirect('/?error=' + encodeURIComponent('Something went wrong verifying your email.'));
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
    const passwordHash = await bcrypt.hash(password, 12);
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

module.exports = { router, issueVerificationEmail };
