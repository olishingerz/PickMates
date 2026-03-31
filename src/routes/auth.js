const express = require('express');
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const { MAX_PLAYERS } = require('../constants');

const router = express.Router();

// GET /auth/login
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render('login', { error: 'Please fill in all fields.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.render('login', { error: 'Invalid username or password.' });
    }
    req.session.user = { id: user.id, username: user.username, isAdmin: user.is_admin, draftPosition: user.draft_position };
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Something went wrong. Please try again.' });
  }
});

// GET /auth/register
router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('register', { error: null });
});

// POST /auth/register
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
    const userId = rows[0].id;

    // First user to register becomes admin
    const { rows: allUsers } = await client.query('SELECT COUNT(*) AS cnt FROM users');
    const isAdmin = parseInt(allUsers[0].cnt) === 1;

    // Assign next available draft position if slots remain
    const { rows: taken } = await client.query(
      'SELECT COUNT(*) AS cnt FROM users WHERE draft_position IS NOT NULL'
    );
    const takenSlots = parseInt(taken[0].cnt);
    const draftPosition = takenSlots < MAX_PLAYERS ? takenSlots + 1 : null;

    await client.query(
      'UPDATE users SET is_admin = $1, draft_position = $2 WHERE id = $3',
      [isAdmin, draftPosition, userId]
    );

    await client.query('COMMIT');

    req.session.user = { id: userId, username: rows[0].username, isAdmin, draftPosition };

    // New users go straight to the draft page
    res.redirect('/draft');
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

// POST /auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
