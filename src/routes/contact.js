const express = require('express');
const { pool } = require('../db');
const { sendContactEmail } = require('../services/email');

const router = express.Router();

const CATEGORIES = ['General question', 'Bug report', 'Feature suggestion', 'Other'];

// Sliding-window limiter, keyed by IP — same pattern as auth.js's login/
// forgot-password limiters, to stop this public form being used to spam
// the support inbox.
const contactAttempts = new Map();
const MAX_CONTACT_ATTEMPTS = 5;
const CONTACT_WINDOW_MS    = 15 * 60 * 1000;

function contactRateLimited(key) {
  const entry = contactAttempts.get(key);
  if (!entry || Date.now() > entry.resetAt) return false;
  return entry.count >= MAX_CONTACT_ATTEMPTS;
}

function recordContactAttempt(key) {
  const now = Date.now();
  const entry = contactAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    contactAttempts.set(key, { count: 1, resetAt: now + CONTACT_WINDOW_MS });
  } else {
    entry.count++;
  }
}

router.get('/', async (req, res) => {
  let email = '';
  if (req.session.user) {
    try {
      const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [req.session.user.id]);
      email = rows[0]?.email || '';
    } catch (_) {}
  }
  res.render('contact', {
    error: null,
    success: null,
    name: req.session.user?.username || '',
    email,
    category: req.query.category && CATEGORIES.includes(req.query.category) ? req.query.category : 'General question',
    message: '',
    CATEGORIES,
  });
});

router.post('/', async (req, res) => {
  const name     = req.body.name?.trim();
  const email    = req.body.email?.trim();
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'General question';
  const message  = req.body.message?.trim();

  const rerender = (error) => res.render('contact', {
    error, success: null, name: name || '', email: email || '', category, message: message || '', CATEGORIES,
  });

  if (!name || !email || !message) {
    return rerender('Please fill in all fields.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return rerender('Please enter a valid email address.');
  }
  if (message.length > 5000) {
    return rerender('Message is too long (5000 characters max).');
  }

  const rateLimitKey = req.ip;
  if (contactRateLimited(rateLimitKey)) {
    return rerender("You've sent a few messages recently — please wait a bit before sending another.");
  }
  recordContactAttempt(rateLimitKey);

  try {
    await sendContactEmail({ name, email, category, message });
    res.render('contact', {
      error: null,
      success: "Thanks — your message has been sent. We'll get back to you by email.",
      name: '', email: '', category: 'General question', message: '', CATEGORIES,
    });
  } catch (err) {
    console.error('[contact]', err);
    rerender('Something went wrong sending your message. Please try again.');
  }
});

module.exports = router;
