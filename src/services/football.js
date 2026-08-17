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

// Fetch fixtures for the given league codes (e.g. ['eng.1', 'eng.2']).
// datesParam, if given, is an ESPN-format range like '20260821-20260824'; otherwise
// ESPN defaults to whatever it considers "today".
async function fetchFixtures(leagueCodes, datesParam) {
  const fixtures = [];
  for (const code of leagueCodes) {
    let data;
    try {
      const url = datesParam
        ? `${ESPN_SOCCER}/${code}/scoreboard?dates=${datesParam}`
        : `${ESPN_SOCCER}/${code}/scoreboard`;
      data = await fetchJSON(url);
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

// ESPN's soccer API has no explicit "gameweek" number — it only exposes a flat
// calendar of match dates per league. A round is inferred by clustering dates that
// fall close together, treating a gap of 4+ days as the boundary to the next round.
// Each league's calendar is clustered independently (their rounds aren't always
// aligned — e.g. the Championship season starts a week before the Premier League),
// then the "current" window is the union of each league's own next round.
function clusterCurrentWindow(calendarDates) {
  const sorted = [...new Set(calendarDates)].sort();
  if (sorted.length === 0) return null;
  const GAP_MS = 4 * 24 * 60 * 60 * 1000;
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T00:00:00Z').getTime();
    const cur  = new Date(sorted[i] + 'T00:00:00Z').getTime();
    if (cur - prev >= GAP_MS) clusters.push([]);
    clusters[clusters.length - 1].push(sorted[i]);
  }
  const todayStr = new Date().toISOString().slice(0, 10);
  const activeCluster = clusters.find(c => c[c.length - 1] >= todayStr) || clusters[clusters.length - 1];
  return { start: activeCluster[0], end: activeCluster[activeCluster.length - 1] };
}

async function getGameweekWindow(leagueCodes) {
  const perLeagueWindows = [];
  for (const code of leagueCodes) {
    try {
      const data = await fetchJSON(`${ESPN_SOCCER}/${code}/scoreboard`);
      const calendar = (data.leagues?.[0]?.calendar || []).map(d => d.slice(0, 10));
      const window = clusterCurrentWindow(calendar);
      if (window) perLeagueWindows.push(window);
    } catch (err) {
      console.warn(`[football] calendar fetch failed for ${code}:`, err.message);
    }
  }
  if (perLeagueWindows.length === 0) return null;

  return {
    start: perLeagueWindows.map(w => w.start).sort()[0],
    end:   perLeagueWindows.map(w => w.end).sort().at(-1),
  };
}

// Fixtures for the current gameweek (by date clustering) plus a suggested pick
// deadline of 24h before the earliest kickoff in that window.
async function getCurrentGameweekFixtures(leagueCodes) {
  const window = await getGameweekWindow(leagueCodes);
  if (!window) return { fixtures: [], suggestedDeadline: null };

  const datesParam = `${window.start.replace(/-/g, '')}-${window.end.replace(/-/g, '')}`;
  const fixtures = await fetchFixtures(leagueCodes, datesParam);

  const kickoffs = fixtures.map(f => new Date(f.kickoff).getTime()).filter(t => !isNaN(t));
  const suggestedDeadline = kickoffs.length ? new Date(Math.min(...kickoffs) - 24 * 60 * 60 * 1000) : null;

  return { fixtures, suggestedDeadline };
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

module.exports = { fetchFixtures, getCurrentGameweekFixtures, processResults, LEAGUE_NAMES };
