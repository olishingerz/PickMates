const { pool } = require('../db');

const ESPN_SCOREBOARD = 'https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard';

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`ESPN API ${res.status} for ${url}`);
  return res.json();
}

function parseScore(val) {
  if (val === null || val === undefined || val === '-') return null;
  if (typeof val === 'number') return val;
  const s = String(val).trim();
  if (s.toUpperCase() === 'E' || s.toUpperCase() === 'EVEN') return 0;
  const n = parseInt(s.replace('+', ''), 10);
  return isNaN(n) ? null : n;
}

// Returns PGA Tour event list for the tournament selector
async function fetchTournamentList() {
  // The scoreboard endpoint's calendar array contains the full season schedule
  const data     = await fetchJSON(`${ESPN_SCOREBOARD}?lang=en`);
  const calendar = data.leagues?.[0]?.calendar || [];
  const now      = new Date();

  const events = calendar
    .filter(e => e.id && e.label)
    .map(e => {
      const startDate = e.startDate ? new Date(e.startDate) : null;
      const endDate   = e.endDate   ? new Date(e.endDate)   : null;
      const isLive    = startDate && endDate && startDate <= now && now <= endDate;
      const completed = endDate ? endDate < now : false;
      return {
        id:        e.id,
        name:      e.label,
        shortName: e.label,
        startDate: e.startDate,
        endDate:   e.endDate,
        status:    isLive ? 'STATUS_IN_PROGRESS' : completed ? 'STATUS_COMPLETE' : 'STATUS_SCHEDULED',
        completed,
      };
    });

  // Order: live first, then upcoming by date, then last 5 completed most-recent-first
  const live      = events.filter(e => e.status === 'STATUS_IN_PROGRESS');
  const upcoming  = events.filter(e => e.status === 'STATUS_SCHEDULED')
                          .sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const completed = events.filter(e => e.completed)
                          .sort((a, b) => new Date(b.startDate) - new Date(a.startDate))
                          .slice(0, 5);

  return [...live, ...upcoming, ...completed];
}

const SCORES_THAT_COUNT = parseInt(process.env.SCORES_THAT_COUNT) || 3;

// Compute golf winner and save to games table (accepts a pool client or pool itself)
async function saveGolfWinner(db, gameId) {
  try {
    const { rows } = await db.query(`
      SELECT u.username,
             ARRAY_AGG(l.score_to_par ORDER BY l.score_to_par ASC)
               FILTER (WHERE l.score_to_par IS NOT NULL) AS scores,
             COUNT(CASE WHEN l.made_cut = TRUE THEN 1 END)::int AS cut_makers
      FROM game_participants gp
      JOIN users u ON u.id = gp.user_id
      LEFT JOIN picks p ON p.user_id = gp.user_id AND p.game_id = gp.game_id
      LEFT JOIN leaderboard l ON l.game_id = gp.game_id
                              AND LOWER(TRIM(l.player_name)) = LOWER(TRIM(p.player_name))
      WHERE gp.game_id = $1
      GROUP BY u.username, gp.user_id
    `, [gameId]);

    let teamWinner = null, bestTeam = Infinity;
    let indivWinner = null, bestIndiv = Infinity;

    for (const row of rows) {
      const scores = row.scores || [];
      if (scores.length > 0 && scores[0] < bestIndiv) {
        bestIndiv = scores[0];
        indivWinner = row.username;
      }
      if (row.cut_makers >= SCORES_THAT_COUNT && scores.length >= SCORES_THAT_COUNT) {
        const ts = scores.slice(0, SCORES_THAT_COUNT).reduce((s, v) => s + v, 0);
        if (ts < bestTeam) { bestTeam = ts; teamWinner = row.username; }
      }
    }

    await db.query(
      'UPDATE games SET winner_username=$1, winner_individual_username=$2 WHERE id=$3',
      [teamWinner, indivWinner, gameId]
    );
    console.log(`[scraper] Game ${gameId}: winner saved — team: ${teamWinner}, individual: ${indivWinner}`);
  } catch (err) {
    console.warn(`[scraper] Game ${gameId}: saveGolfWinner failed:`, err.message);
  }
}

// Scrape leaderboard for a specific game
async function scrapeLeaderboard(gameId) {
  const { rows } = await pool.query('SELECT tournament_id, player_source FROM games WHERE id = $1', [gameId]);
  const tournamentId  = rows[0]?.tournament_id;
  const playerSource  = rows[0]?.player_source || 'espn';

  if (!tournamentId) {
    console.warn(`[scraper] Game ${gameId} has no tournament selected — skipping`);
    return [];
  }

  console.log(`[scraper] Fetching data for game ${gameId} (tournament ${tournamentId})…`);

  const data  = await fetchJSON(`${ESPN_SCOREBOARD}?tournamentId=${tournamentId}&lang=en`);
  const event = data.events?.[0];
  if (!event) throw new Error('No event data returned from ESPN');

  // ESPN ignores tournamentId and returns the current live event when the requested
  // tournament hasn't started yet — skip the update if it's not our tournament
  if (String(event.id) !== String(tournamentId)) {
    console.log(`[scraper] Game ${gameId}: ESPN returned event ${event.id} (${event.name}) instead of ${tournamentId} — tournament not live yet, skipping score update`);
    return [];
  }

  const competitors    = event.competitions?.[0]?.competitors || [];
  const eventState     = event.competitions?.[0]?.status?.type?.state;
  const eventCompleted = event.competitions?.[0]?.status?.type?.completed === true;
  // Treat both 'in' (active) and 'post' (suspended/complete) as having valid scores
  const isLive         = eventState === 'in' || eventState === 'post';

  if (competitors.length === 0) {
    console.warn(`[scraper] Game ${gameId}: no competitors returned`);
    return [];
  }

  const players = competitors.map(c => {
    const statusName = c.status?.type?.name || '';
    const missedCut  = statusName.includes('CUT') || statusName.includes('WD') || statusName.includes('DQ');

    // Each top-level linescore is a round. displayValue = score-to-par for that round.
    // Inner linescores array = individual hole scores, so its length = holes played this round.
    const rounds = [null, null, null, null];
    let thru = null;
    for (const ls of (c.linescores || [])) {
      const idx = (ls.period || 1) - 1;
      if (idx >= 0 && idx < 4 && ls.displayValue != null) {
        rounds[idx] = parseScore(ls.displayValue);
        // Holes played only meaningful for current (in-progress) round
        if (isLive && ls.linescores?.length > 0) {
          thru = ls.linescores.length;
        }
      }
    }

    return {
      player_name:  c.athlete?.displayName || c.athlete?.fullName || 'Unknown',
      position:     c.order || null,
      score_to_par: isLive ? parseScore(c.score) : null,
      made_cut:     isLive ? !missedCut : null,
      thru,
      r1: rounds[0], r2: rounds[1], r3: rounds[2], r4: rounds[3],
    };
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (playerSource === 'custom') {
      // Custom list: update scores for existing players only — don't wipe the admin's list
      for (const p of players) {
        await client.query(
          `UPDATE leaderboard
           SET position=$1, score_to_par=$2, made_cut=$3, thru=$4, r1=$5, r2=$6, r3=$7, r4=$8, updated_at=NOW()
           WHERE game_id=$9 AND LOWER(TRIM(player_name)) = LOWER(TRIM($10))`,
          [p.position, p.score_to_par, p.made_cut, p.thru, p.r1, p.r2, p.r3, p.r4, gameId, p.player_name]
        );
      }
    } else {
      // ESPN source: full replace
      await client.query('DELETE FROM leaderboard WHERE game_id = $1', [gameId]);
      for (const p of players) {
        await client.query(
          `INSERT INTO leaderboard (game_id, player_name, position, score_to_par, made_cut, thru, r1, r2, r3, r4)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [gameId, p.player_name, p.position, p.score_to_par, p.made_cut, p.thru, p.r1, p.r2, p.r3, p.r4]
        );
      }
    }

    // Auto-complete: if ESPN says the event is finished AND at least one player
    // has an R4 score (guards against ESPN firing 'completed' prematurely after cut day)
    const hasR4 = players.some(p => p.r4 !== null);
    if (eventCompleted && hasR4) {
      const { rowCount } = await client.query(
        'UPDATE games SET tournament_complete = TRUE WHERE id = $1 AND tournament_complete = FALSE',
        [gameId]
      );
      if (rowCount > 0) {
        console.log(`[scraper] Game ${gameId}: tournament complete — scores frozen`);
        // Compute and save winner
        await saveGolfWinner(client, gameId);
      }
    }

    await client.query('COMMIT');
    console.log(`[scraper] Game ${gameId}: updated ${players.length} players (${isLive ? 'live' : 'pre-tournament'}, source: ${playerSource})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return players;
}

// Scrape all active games — called by the cron job
async function scrapeAllGames() {
  const { rows } = await pool.query(
    'SELECT id FROM games WHERE tournament_id IS NOT NULL AND tournament_complete = FALSE'
  );
  for (const game of rows) {
    try {
      await scrapeLeaderboard(game.id);
    } catch (err) {
      console.error(`[scraper] Game ${game.id} failed:`, err.message);
    }
  }

  // Backfill winners for completed golf games that are missing them
  const { rows: needWinner } = await pool.query(
    `SELECT id FROM games WHERE game_type = 'golf_draft' AND tournament_complete = TRUE AND winner_username IS NULL`
  );
  for (const game of needWinner) {
    await saveGolfWinner(pool, game.id);
  }
}

module.exports = { scrapeLeaderboard, scrapeAllGames, fetchTournamentList };
