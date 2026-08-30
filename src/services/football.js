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

      const statusName = comp.status?.type?.name || '';
      // ESPN's convention for a match that won't go ahead as scheduled — not
      // verified against a live postponed fixture (none was in progress when
      // this was written), based on the standard ESPN status.type.name enum.
      const postponed  = statusName === 'STATUS_POSTPONED' || statusName === 'STATUS_CANCELED';
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
        postponed,
        homeTeam:  { id: home.team.id, name: home.team.displayName, shortName: home.team.abbreviation, score: homeScore, logo: home.team.logo || null },
        awayTeam:  { id: away.team.id, name: away.team.displayName, shortName: away.team.abbreviation, score: awayScore, logo: away.team.logo || null },
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
function clusterDates(calendarDates) {
  const sorted = [...new Set(calendarDates)].sort();
  if (sorted.length === 0) return [];
  const GAP_MS = 4 * 24 * 60 * 60 * 1000;
  const clusters = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1] + 'T00:00:00Z').getTime();
    const cur  = new Date(sorted[i] + 'T00:00:00Z').getTime();
    if (cur - prev >= GAP_MS) clusters.push([]);
    clusters[clusters.length - 1].push(sorted[i]);
  }
  return clusters.map(c => ({ start: c[0], end: c[c.length - 1] }));
}

// Premier League is treated as the anchor league when it's selected — its calendar
// alone defines the round boundaries and deadline, since a combined PL+Championship
// pool shouldn't have its week 1 deadline dragged earlier by the Championship's
// earlier season start (players would be locked out before PL fixtures even begin).
// Other leagues just widen which teams are pickable inside that same window.
// requireUpcomingDeadline: when true, a candidate round only qualifies if its
// own natural deadline (an hour before its earliest kickoff — same formula
// as getCurrentGameweekFixtures's suggestedDeadline) is still in the future,
// not just "has some fixture left unplayed". Without this, a round that's
// already partway through (e.g. Saturday early kickoffs done, Sunday still to
// come) still counts as "current" — right for grading results on an
// already-running week, wrong for handing a *new* week to players to pick
// from: they'd inherit a deadline already in the past and look eliminated
// before they ever got a chance to pick. Callers that hand a week to players
// (refreshFixtureCache) pass true; callers grading an already-assigned week
// (the results cron, processGameResults) must not, or they'd skip straight
// past the round they're meant to be grading.
async function getGameweekWindow(leagueCodes, { requireUpcomingDeadline = false } = {}) {
  const anchorCode = leagueCodes.includes('eng.1') ? 'eng.1' : leagueCodes[0];
  if (!anchorCode) return null;

  try {
    const data = await fetchJSON(`${ESPN_SOCCER}/${anchorCode}/scoreboard`);
    const calendar = (data.leagues?.[0]?.calendar || []).map(d => d.slice(0, 10));
    const clusters = clusterDates(calendar);
    if (clusters.length === 0) return null;

    const todayStr = new Date().toISOString().slice(0, 10);
    const fallback = clusters[clusters.length - 1];
    const candidates = clusters.filter(c => c.end >= todayStr);

    // A cluster's last date being "today or later" isn't enough on its own —
    // if that round's final match kicked off earlier today and has since
    // finished, the round is over even though the date string still matches.
    // Probe each date-eligible candidate in order and take the first one that
    // still has an unplayed (or not-yet-started) fixture.
    for (const candidate of (candidates.length ? candidates : [fallback])) {
      const datesParam = `${candidate.start.replace(/-/g, '')}-${candidate.end.replace(/-/g, '')}`;
      const fixtures = await fetchFixtures([anchorCode], datesParam);
      const stillLive = fixtures.length === 0 || fixtures.some(f => !f.completed && !f.postponed);
      if (!stillLive) continue;
      if (requireUpcomingDeadline) {
        const kickoffs = fixtures.filter(f => !f.postponed).map(f => new Date(f.kickoff).getTime()).filter(t => !isNaN(t));
        const deadlineAhead = kickoffs.length === 0 || (Math.min(...kickoffs) - 60 * 60 * 1000) > Date.now();
        if (!deadlineAhead) continue;
      }
      return candidate;
    }
    return candidates[candidates.length - 1] || fallback;
  } catch (err) {
    console.warn(`[football] calendar fetch failed for ${anchorCode}:`, err.message);
    return null;
  }
}

// Fixtures for the current gameweek (by date clustering) plus a suggested pick
// deadline of an hour before the earliest kickoff in that window. See
// getGameweekWindow for what requireUpcomingDeadline changes.
async function getCurrentGameweekFixtures(leagueCodes, opts) {
  const window = await getGameweekWindow(leagueCodes, opts);
  if (!window) return { fixtures: [], suggestedDeadline: null };

  const datesParam = `${window.start.replace(/-/g, '')}-${window.end.replace(/-/g, '')}`;
  const fixtures = await fetchFixtures(leagueCodes, datesParam);

  const kickoffs = fixtures.map(f => new Date(f.kickoff).getTime()).filter(t => !isNaN(t));
  const suggestedDeadline = kickoffs.length ? new Date(Math.min(...kickoffs) - 60 * 60 * 1000) : null;

  return { fixtures, suggestedDeadline };
}

// Process results for a game week — updates lms_picks result column.
// `fixtures` must be the properly gameweek-scoped list (from getCurrentGameweekFixtures),
// not a raw fetchFixtures() call, which defaults to ESPN's ambiguous "today" view and can
// miss matches from other days in the same gameweek. Only fixtures that have actually
// finished (completed: true) or been postponed contribute a result — everything else is
// left as-is, so this can be called repeatedly as individual matches finish without
// waiting for the whole gameweek to wrap up.
async function processResults(pool, gameId, weekNumber, fixtures) {
  // Build a map from team_id → result
  const teamResults = {};
  for (const f of fixtures) {
    if (f.postponed) {
      // A postponed fixture means both teams' pickers automatically survive
      // this week and can't pick that team again (the pick row already marks
      // it used) — not a win, loss, or draw.
      teamResults[f.homeTeam.id] = 'postponed';
      teamResults[f.awayTeam.id] = 'postponed';
      continue;
    }
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
