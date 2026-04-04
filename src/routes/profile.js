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
  const { rows } = await pool.query('SELECT username, avatar, email FROM users WHERE id = $1', [req.session.user.id]);
  res.render('profile', {
    profileUser: rows[0],
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
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.redirect('/profile?error=' + encodeURIComponent('Please enter a valid email address.'));
  }
  try {
    await pool.query('UPDATE users SET email = $1 WHERE id = $2', [email || null, req.session.user.id]);
    res.redirect('/profile?success=' + encodeURIComponent(email ? 'Email saved — you\'ll now get pick notifications.' : 'Email removed.'));
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
