const ESPN_SOCCER = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const LEAGUE_NAMES = {
  'eng.1': 'Premier League',
  'eng.2': 'Championship',
};

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`ESPN soccer API ${res.status} for ${url}`);
  return res.json();
}

// Fetch this week's fixtures for the given league codes (e.g. ['eng.1', 'eng.2'])
async function fetchFixtures(leagueCodes) {
  const fixtures = [];
  for (const code of leagueCodes) {
    let data;
    try {
      data = await fetchJSON(`${ESPN_SOCCER}/${code}/scoreboard`);
    } catch (err) {
      console.warn(`[football] Could not fetch ${code}:`, err.message);
      continue;
    }
    for (const event of (data.events || [])) {
      const comp = event.competitions?.[0];
      if (!comp) continue;
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      if (!home || !away) continue;

      const completed  = comp.status?.type?.completed === true;
      const homeScore  = parseInt(home.score) || 0;
      const awayScore  = parseInt(away.score) || 0;
      let winnerId = null;
      if (completed) {
        if (homeScore > awayScore) winnerId = home.team.id;
        else if (awayScore > homeScore) winnerId = away.team.id;
        // draw: winnerId stays null
      }

      fixtures.push({
        id:        event.id,
        league:    code,
        leagueName: LEAGUE_NAMES[code] || code,
        kickoff:   event.date,
        completed,
        homeTeam:  { id: home.team.id, name: home.team.displayName, shortName: home.team.abbreviation, score: homeScore },
        awayTeam:  { id: away.team.id, name: away.team.displayName, shortName: away.team.abbreviation, score: awayScore },
        winnerId,
        isDraw:    completed && homeScore === awayScore,
      });
    }
  }
  // Sort by kickoff time
  fixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  return fixtures;
}

// Process results for a game week — updates lms_picks result column
async function processResults(pool, gameId, weekNumber) {
  const { rows: gameRows } = await pool.query('SELECT lms_leagues FROM games WHERE id = $1', [gameId]);
  const leagues = (gameRows[0]?.lms_leagues || 'eng.1').split(',').map(s => s.trim()).filter(Boolean);
  const fixtures = await fetchFixtures(leagues);

  // Build a map from team_id → result
  const teamResults = {};
  for (const f of fixtures) {
    if (!f.completed) continue;
    if (f.isDraw) {
      teamResults[f.homeTeam.id] = 'draw';
      teamResults[f.awayTeam.id] = 'draw';
    } else if (f.winnerId) {
      teamResults[f.homeTeam.id] = f.homeTeam.id === f.winnerId ? 'win' : 'loss';
      teamResults[f.awayTeam.id] = f.awayTeam.id === f.winnerId ? 'win' : 'loss';
    }
  }

  const { rows: picks } = await pool.query(
    'SELECT id, team_id FROM lms_picks WHERE game_id=$1 AND week_number=$2',
    [gameId, weekNumber]
  );

  let updated = 0;
  for (const pick of picks) {
    const result = teamResults[pick.team_id];
    if (result) {
      await pool.query('UPDATE lms_picks SET result=$1 WHERE id=$2', [result, pick.id]);
      updated++;
    }
  }
  return { updated, teamResults };
}

module.exports = { fetchFixtures, processResults, LEAGUE_NAMES };
