require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const cron = require('node-cron');
const { pool, initDb } = require('./db');
const authRoutes    = require('./routes/auth');
const homeRoutes    = require('./routes/home');
const gamesRoutes   = require('./routes/games');
const profileRoutes = require('./routes/profile');
const { scrapeAllGames } = require('./services/scraper');
const { sendLmsDeadlineEmails } = require('./services/email');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  // Keep avatar and paid status in sync
  if (req.session.user && req.session.user.avatar === undefined) {
    try {
      const { rows } = await pool.query('SELECT avatar, is_paid FROM users WHERE id = $1', [req.session.user.id]);
      req.session.user.avatar  = rows[0]?.avatar   || null;
      req.session.user.isPaid  = rows[0]?.is_paid  || false;
    } catch (_) {}
  }
  next();
});

app.use('/', homeRoutes);
app.use('/auth', authRoutes);
app.use('/game', gamesRoutes);
app.use('/profile', profileRoutes);

// Manual scrape trigger (protected by API key)
app.post('/api/scrape', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.SCRAPE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    await scrapeAllGames();
    res.json({ success: true });
  } catch (err) {
    console.error('[scrape API]', err);
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await initDb();

  cron.schedule('*/30 * * * *', async () => {
    console.log('[cron] Running scheduled scrape…');
    try { await scrapeAllGames(); }
    catch (err) { console.error('[cron] Scrape failed:', err.message); }
  });

  // Hourly: send LMS deadline reminders 24h before each week's deadline
  cron.schedule('0 * * * *', async () => {
    try {
      const { rows: weeks } = await pool.query(`
        SELECT w.id, w.game_id, w.week_number, w.deadline,
               g.name AS game_name, g.id AS game_id
        FROM lms_weeks w
        JOIN games g ON g.id = w.game_id
        WHERE w.deadline IS NOT NULL
          AND w.reminder_sent = FALSE
          AND w.results_locked = FALSE
          AND w.deadline BETWEEN NOW() + INTERVAL '23 hours' AND NOW() + INTERVAL '25 hours'
      `);
      for (const week of weeks) {
        // Get alive players with emails
        const { rows: players } = await pool.query(`
          SELECT u.email, u.username
          FROM game_participants gp
          JOIN users u ON u.id = gp.user_id
          WHERE gp.game_id = $1 AND u.email IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM lms_picks lp
              WHERE lp.game_id = $1 AND lp.user_id = gp.user_id
                AND lp.week_number = $2 AND lp.result != 'loss'
            )
        `, [week.game_id, week.week_number]);

        if (players.length > 0) {
          await sendLmsDeadlineEmails(
            players,
            { id: week.game_id, name: week.game_name },
            week.week_number,
            new Date(week.deadline)
          );
        }
        await pool.query('UPDATE lms_weeks SET reminder_sent = TRUE WHERE id = $1', [week.id]);
      }
    } catch (err) {
      console.error('[cron] LMS reminder failed:', err.message);
    }
  });

  scrapeAllGames()
    .then(() => console.log('[startup] Initial scrape complete'))
    .catch(err => console.warn('[startup] Initial scrape skipped:', err.message));

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`PickMates running on port ${PORT}`));
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
