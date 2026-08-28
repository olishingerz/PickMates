require('dotenv').config();
const crypto = require('crypto');
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
const adminRoutes   = require('./routes/admin');
const contactRoutes = require('./routes/contact');
const { scrapeAllGames } = require('./services/scraper');
const { sendLmsDeadlineEmails } = require('./services/email');
const { getCurrentGameweekFixtures, processResults } = require('./services/football');
const { processGameResults } = require('./routes/lms');
const { getGameCreationRoles, canCreateGames } = require('./services/settings');

const app = express();

// Safety net for a promise rejection that slips past every route's own
// try/catch (Express 4 doesn't auto-forward those to the error-handling
// middleware below) — without this, Node treats an unhandled rejection as an
// uncaught exception and kills the whole process, taking the entire site
// down over one bad request instead of just failing that one response.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production — refusing to start with an insecure default.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Railway terminates TLS at a proxy in front of the app — without this, Express
// sees every request as plain HTTP and a `secure` cookie would never get set.
if (isProduction) app.set('trust proxy', 1);

// Force HTTPS — Railway issues a valid cert for the custom domain, but
// without this, a request that happens to arrive over plain http:// (a typed
// URL with no scheme, an old bookmark, the bare apex domain, etc.) just gets
// served insecurely instead of upgraded, which is what was showing as
// "connection is not secure" despite the certificate itself being valid.
if (isProduction) {
  app.use((req, res, next) => {
    if (req.secure) return next();
    res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  });
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

app.use(session({
  store: new pgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET || 'dev-secret-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: isProduction,
    sameSite: 'lax',
    httpOnly: true, // express-session already defaults to this — set explicitly so it can't be silently changed
  },
}));

app.use(async (req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.impersonating = req.session.adminUserId ? true : false;
  try {
    res.locals.canCreateGames = canCreateGames(req.session.user || null, await getGameCreationRoles());
  } catch (_) {
    res.locals.canCreateGames = req.session.user?.isAdmin || false;
  }
  // Consume the one-shot "add your email" prompt set at login — shown on
  // this single page load only, and marked shown in the DB immediately so it
  // can never appear again even if the user never revisits this page.
  res.locals.showEmailPrompt = false;
  if (req.session.showEmailPrompt) {
    res.locals.showEmailPrompt = true;
    req.session.showEmailPrompt = false;
    pool.query('UPDATE users SET email_prompt_shown = TRUE WHERE id = $1', [req.session.user.id]).catch(() => {});
  }
  if (req.session.user) {
    // Sync avatar/paid/admin status on first request of the session
    if (req.session.user.avatar === undefined) {
      try {
        const { rows } = await pool.query('SELECT avatar, is_paid, is_admin FROM users WHERE id = $1', [req.session.user.id]);
        req.session.user.avatar  = rows[0]?.avatar  || null;
        req.session.user.isPaid  = rows[0]?.is_paid || false;
        req.session.user.isAdmin = rows[0]?.is_admin || false;
      } catch (_) {}
    }
    // At most once every 5 minutes per session: update last_seen and re-sync
    // is_admin/is_paid, so a revoked admin loses access without needing to log
    // out (previously only the one-time sync above ever refreshed these).
    const now = Date.now();
    if (!req.session.lastSeenAt || now - req.session.lastSeenAt > 5 * 60 * 1000) {
      req.session.lastSeenAt = now;
      pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1 RETURNING is_admin, is_paid', [req.session.user.id])
        .then(({ rows }) => {
          if (rows[0]) {
            req.session.user.isAdmin = rows[0].is_admin || false;
            req.session.user.isPaid  = rows[0].is_paid  || false;
          }
        })
        .catch(() => {});
    }
  }
  next();
});

// CSRF protection for the server-rendered forms — every POST in this app is a
// plain <form> submission (no fetch-based POSTs from any view), so a token tied
// to the session and echoed back as a hidden field is enough. Assigning the
// token below does mean an anonymous visitor's session now gets persisted
// (previously `saveUninitialized: false` skipped that for pure browsing) —
// an accepted trade-off since a form's own page needs the token before submit.
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

// Visitor log for the admin "Visitors" page — one row per distinct visitor
// (keyed by user_id once logged in, else IP), upserted with their latest
// activity rather than appending a row per page load. GET only (static
// files never reach here, express.static already served/terminated those
// requests above). Fire-and-forget: a logging failure should never affect
// the actual page load.
app.use((req, res, next) => {
  if (req.method === 'GET') {
    const visitorKey = req.session.user?.id ? `user:${req.session.user.id}` : `ip:${req.ip || 'unknown'}`;
    pool.query(
      `INSERT INTO visitor_log (visitor_key, ip_address, user_id, last_path, user_agent, last_seen, visit_count)
       VALUES ($1,$2,$3,$4,$5,NOW(),1)
       ON CONFLICT (visitor_key) DO UPDATE
         SET ip_address = $2, last_path = $4, user_agent = $5, last_seen = NOW(),
             visit_count = visitor_log.visit_count + 1`,
      [visitorKey, req.ip || null, req.session.user?.id || null, req.path, req.headers['user-agent'] || null]
    ).catch(err => console.warn('[visitor-log] failed:', err.message));
  }
  next();
});

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // External API-key-authenticated endpoint, not a browser form — no session/token to check.
  if (req.path === '/api/scrape') return next();
  const token = req.body?._csrf;
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).send('Your session has expired or the form was out of date — please go back and try again.');
  }
  next();
});

app.use('/', homeRoutes);
app.use('/auth', authRoutes);
app.use('/game', gamesRoutes);
app.use('/profile', profileRoutes);
app.use('/admin', adminRoutes);
app.use('/contact', contactRoutes);

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

// 404 — no route matched. Must come after every app.use()/route registration.
app.use((req, res) => {
  res.status(404).send(
    '<!DOCTYPE html><html><head><title>Not Found – PickMates</title></head>' +
    '<body style="font-family:sans-serif;text-align:center;padding:4rem 1rem">' +
    '<h1>404</h1><p>That page doesn\'t exist.</p><a href="/">← Back to PickMates</a></body></html>'
  );
});

// Catch-all error handler — must be the LAST middleware, with all 4 args, for
// Express to treat it as an error handler rather than regular middleware.
// Only catches synchronous throws and errors explicitly forwarded via
// next(err) (Express 4 doesn't auto-forward a rejected promise from an async
// handler) — every route handler should still have its own try/catch, this
// is the safety net for anything that slips through.
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err);
  if (res.headersSent) return next(err);
  res.status(500).send(
    '<!DOCTYPE html><html><head><title>Something went wrong – PickMates</title></head>' +
    '<body style="font-family:sans-serif;text-align:center;padding:4rem 1rem">' +
    '<h1>Something went wrong</h1><p>Please try again, or head back home.</p><a href="/">← Back to PickMates</a></body></html>'
  );
});

async function start() {
  await initDb();

  cron.schedule('*/5 * * * *', async () => {
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
          WHERE gp.game_id = $1 AND u.email IS NOT NULL AND u.notify_lms_deadline = TRUE
            AND NOT EXISTS (
              SELECT 1 FROM lms_picks lp
              WHERE lp.participant_id = gp.id
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

  // Every 5 minutes: grade LMS picks as their individual matches finish (no need to
  // wait for the whole gameweek), and only lock the week / declare a winner once
  // every alive player's match has actually been decided.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const { rows: games } = await pool.query(`
        SELECT g.id, g.lms_leagues, g.lms_current_week
        FROM games g
        LEFT JOIN lms_weeks w ON w.game_id = g.id AND w.week_number = g.lms_current_week
        WHERE g.game_type = 'last_man_standing' AND g.is_started = TRUE
          AND (w.results_locked IS NOT TRUE)
      `);
      for (const game of games) {
        try {
          const leagues = (game.lms_leagues || 'eng.1').split(',').map(s => s.trim()).filter(Boolean);
          const { fixtures } = await getCurrentGameweekFixtures(leagues);
          if (fixtures.length === 0) continue;

          // Grade whichever matches have already finished this cycle
          const { updated } = await processResults(pool, game.id, game.lms_current_week, fixtures);
          if (updated > 0) console.log(`[cron] LMS game ${game.id}: graded ${updated} pick(s) this cycle`);

          // Only lock the week / check for a winner once every fixture has
          // either finished or been postponed — a postponed fixture's
          // `completed` stays false forever, so without the `postponed` check
          // here a single postponement would stall this game's grading indefinitely.
          const allFinished = fixtures.every(f => f.completed || f.postponed);
          if (!allFinished) continue;

          console.log(`[cron] LMS game ${game.id}: gameweek finished, finalizing week ${game.lms_current_week}…`);
          const result = await processGameResults(game.id);
          console.log(`[cron] LMS game ${game.id}: ${result.message}`);
        } catch (err) {
          console.error(`[cron] LMS auto-process failed for game ${game.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[cron] LMS auto-process query failed:', err.message);
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
