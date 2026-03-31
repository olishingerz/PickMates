require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const path = require('path');
const cron = require('node-cron');
const { pool, initDb } = require('./db');
const authRoutes  = require('./routes/auth');
const draftRoutes = require('./routes/draft');
const homeRoutes  = require('./routes/home');
const { scrapeLeaderboard } = require('./services/scraper');

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

// Make user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

app.use('/', homeRoutes);
app.use('/auth', authRoutes);
app.use('/draft', draftRoutes);

// Manual scrape trigger (protected by API key)
app.post('/api/scrape', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.SCRAPE_API_KEY) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const players = await scrapeLeaderboard();
    res.json({ success: true, players: players.length });
  } catch (err) {
    console.error('[scrape API]', err);
    res.status(500).json({ error: err.message });
  }
});

async function start() {
  await initDb();

  // Scrape every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    console.log('[cron] Running scheduled scrape…');
    try { await scrapeLeaderboard(); }
    catch (err) { console.error('[cron] Scrape failed:', err.message); }
  });

  // Run once on startup
  scrapeLeaderboard()
    .then(p => console.log(`[startup] Scraped ${p.length} players`))
    .catch(err => console.warn('[startup] Initial scrape skipped:', err.message));

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`PickMates running on port ${PORT}`));
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
