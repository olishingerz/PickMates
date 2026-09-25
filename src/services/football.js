const ESPN_SOCCER = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

const LEAGUE_NAMES = {
  'eng.1': 'Premier League',
  'eng.2': 'Championship',
  'eng.3': 'League One',
  'eng.4': 'League Two',
};

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
  });
  if (!res.ok) {
    // ESPN's error body usually names the actual problem (e.g. an invalid
    // date range) — a bare status code alone isn't enough to tell a bad
    // request apart from rate-limiting or an outage.
    const body = await res.text().catch(() => '');
    throw new Error(`ESPN soccer API ${res.status} for ${url}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  return res.json();
}

// Normalizes one ESPN "event" object (same shape whether it came from a
// scoreboard list's `events[]` or a single-event `/scoreboard/{id}` lookup)
// into this app's fixture shape. Returns null for a malformed event (missing
// competitors) rather than throwing, so one bad event doesn't take down a
// whole batch.
function parseEspnEvent(event, code) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const home = comp.competitors?.find(c => c.homeAway === 'home');
  const away = comp.competitors?.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const statusName = comp.status?.type?.name || '';
  // ESPN's convention for a match that won't produce a normal result — not
  // verified against a live fixture in each of these states (most weren't
  // in progress when this was written), based on the standard ESPN
  // status.type.name enum. Treated the same as postponed: pickers pass
  // through automatically, no win/loss/draw. Abandoned/suspended/forfeit
  // added alongside the original postponed/canceled — a match stuck in
  // any of these never reaches completed:true either, and previously had
  // no fallback at all, which could stall a whole LMS round indefinitely
  // (see the deadline-passed staleness fallback in index.js's grading
  // cron for the belt-and-braces version of this same fix).
  const postponed  = ['STATUS_POSTPONED', 'STATUS_CANCELED', 'STATUS_ABANDONED', 'STATUS_SUSPENDED', 'STATUS_FORFEIT'].includes(statusName);
  const completed  = comp.status?.type?.completed === true;
  const homeScore  = parseInt(home.score) || 0;
  const awayScore  = parseInt(away.score) || 0;
  let winnerId = null;
  if (completed) {
    if (homeScore > awayScore) winnerId = home.team.id;
    else if (awayScore > homeScore) winnerId = away.team.id;
    // draw: winnerId stays null
  }

  return {
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
  };
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
      const fixture = parseEspnEvent(event, code);
      if (fixture) fixtures.push(fixture);
    }
  }
  // Sort by kickoff time
  fixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  return fixtures;
}

// ESPN's soccer API has no explicit "gameweek" number — it only exposes a flat
// calendar of match dates per league. A round is inferred by clustering dates that
// fall close together, treating a gap of 4+ days as the boundary to the next round.
// Only used as the Christmas-period fallback now (see getGameweekWindow) — the
// rest of the season uses a fixed Friday-Monday window instead.
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

// Boxing Day through New Year — English football's one stretch of the
// season where fixtures routinely fall on non-weekend days close together
// (Boxing Day, the 28th/29th, New Year's Day), too tightly packed for a
// fixed Friday-Monday window to make sense of.
function isChristmasPeriod(date) {
  const month = date.getUTCMonth(); // 0 = Jan, 11 = Dec
  const day   = date.getUTCDate();
  return (month === 11 && day >= 20) || (month === 0 && day <= 2);
}

// The Friday-Monday window containing `date` if it falls on Fri/Sat/Sun/Mon,
// otherwise the upcoming one (Tue/Wed/Thu look ahead to the next Friday).
function weekendWindowFor(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  const fridayOffset = day === 5 ? 0 : day === 6 ? -1 : day === 0 ? -2 : day === 1 ? -3 : 5 - day;
  const friday = new Date(d);
  friday.setUTCDate(friday.getUTCDate() + fridayOffset);
  const monday = new Date(friday);
  monday.setUTCDate(monday.getUTCDate() + 3);
  return { start: friday.toISOString().slice(0, 10), end: monday.toISOString().slice(0, 10) };
}

function nextWeekendWindow(window) {
  const friday = new Date(window.start + 'T00:00:00Z');
  friday.setUTCDate(friday.getUTCDate() + 7);
  const monday = new Date(friday);
  monday.setUTCDate(monday.getUTCDate() + 3);
  return { start: friday.toISOString().slice(0, 10), end: monday.toISOString().slice(0, 10) };
}

// Fixture calendars are unreliable for round boundaries close to Christmas
// (games most days, not clustered around one weekend), so this is only ever
// reached from getGameweekWindow during that period — the old date-clustering
// approach, still fine for that irregular stretch even though it's no longer
// used for the rest of the season.
async function getGameweekWindowDynamic(anchorCode, requireUpcomingDeadline) {
  try {
    const data = await fetchJSON(`${ESPN_SOCCER}/${anchorCode}/scoreboard`);
    const calendar = (data.leagues?.[0]?.calendar || []).map(d => d.slice(0, 10));
    const clusters = clusterDates(calendar);
    if (clusters.length === 0) return null;

    const todayStr = new Date().toISOString().slice(0, 10);
    const fallback = clusters[clusters.length - 1];
    const candidates = clusters.filter(c => c.end >= todayStr);

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

// Premier League is treated as the anchor league when it's selected — its
// fixtures alone define the round boundaries and deadline, since a combined
// PL+Championship pool shouldn't have its week 1 deadline dragged earlier by
// the Championship's earlier season start (players would be locked out
// before PL fixtures even begin). Other leagues just widen which teams are
// pickable inside that same window.
//
// A gameweek is a fixed Friday-through-Monday window — that's when Premier
// League/Championship rounds fall the vast majority of the season, and it's
// a far more predictable boundary than trying to infer one from gaps in
// ESPN's calendar data. During the Christmas period (see isChristmasPeriod)
// fixtures fall most days rather than clustering around one weekend, so that
// stretch falls back to the old dynamic calendar-based detection instead.
//
// requireUpcomingDeadline: when true, a candidate window only qualifies if
// its own natural deadline (an hour before its earliest kickoff — same
// formula as getCurrentGameweekFixtures's suggestedDeadline) is still in the
// future, not just "has some fixture left unplayed". Without this, a window
// that's already partway through (e.g. Saturday early kickoffs done, Sunday
// still to come) still counts as "current" — right for grading results on
// an already-running week, wrong for handing a *new* week to players to
// pick from: they'd inherit a deadline already in the past and look
// eliminated before they ever got a chance to pick. Callers that hand a
// week to players (refreshFixtureCache) pass true; callers grading an
// already-assigned week (the results cron, processGameResults) must not, or
// they'd skip straight past the round they're meant to be grading.
async function getGameweekWindow(leagueCodes, { requireUpcomingDeadline = false } = {}) {
  const anchorCode = leagueCodes.includes('eng.1') ? 'eng.1' : leagueCodes[0];
  if (!anchorCode) return null;

  const now = new Date();
  if (isChristmasPeriod(now)) {
    return getGameweekWindowDynamic(anchorCode, requireUpcomingDeadline);
  }

  try {
    let window = weekendWindowFor(now);
    const MAX_WEEKS_AHEAD = 6; // safety bound — an empty fixture list forever shouldn't loop forever
    for (let i = 0; i < MAX_WEEKS_AHEAD; i++) {
      const datesParam = `${window.start.replace(/-/g, '')}-${window.end.replace(/-/g, '')}`;
      const fixtures = await fetchFixtures([anchorCode], datesParam);
      const stillLive = fixtures.length === 0 || fixtures.some(f => !f.completed && !f.postponed);
      if (stillLive) {
        if (!requireUpcomingDeadline) return window;
        const kickoffs = fixtures.filter(f => !f.postponed).map(f => new Date(f.kickoff).getTime()).filter(t => !isNaN(t));
        const deadlineAhead = kickoffs.length === 0 || (Math.min(...kickoffs) - 60 * 60 * 1000) > Date.now();
        if (deadlineAhead) return window;
      }
      window = nextWeekendWindow(window);
    }
    return window;
  } catch (err) {
    console.warn(`[football] fixture fetch failed for ${anchorCode}:`, err.message);
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

// Fresh scores/status for a week that's already under way, using its own
// already-known fixture list (a game's lms_weeks.fixtures_cache, captured
// when that week started) to build the date range — NOT getCurrentGameweekFixtures's
// "guess which round is current from today's date" logic.
//
// That guessing breaks down specifically for grading: getGameweekWindow only
// treats a round as a valid candidate while its last match date is today or
// later. The moment "today" passes a round's last match date — which is
// exactly what happens once that round is actually over and needs grading —
// it silently drops out and the lookup starts returning a different, future,
// entirely-unplayed round instead. From then on nothing in that wrong round
// is ever "finished", so the real round can never lock: not a single stuck
// fixture (which the staleness fallback in index.js's cron handles), but the
// wrong *set* of fixtures entirely. Since a week's own fixture list is
// already known once it starts, there's no need to re-derive "which round is
// this" at grading time at all — just ask ESPN directly about each fixture
// it already knows about.
//
// Originally did that as a single ranged `scoreboard?dates=` query across the
// round's date span, like getCurrentGameweekFixtures. Dropped that after
// discovering (2026-09-19, diagnosing a stuck Bristol City v Watford pick)
// that ESPN's `dates` parameter can start silently returning zero events for
// *any* explicit value — including today's own date passed explicitly —
// while the exact same endpoint with no date param at all still works fine.
// A per-event lookup via `/scoreboard/{id}` sidesteps that parameter
// entirely, confirmed against that same fixture (ESPN correctly reports
// STATUS_FULL_TIME for it there, despite the ranged query returning nothing).
// Only fixtures not yet decided are re-fetched — a completed/postponed
// result can't change, and it keeps each refresh cheap. `leagueCodes` is no
// longer needed here (each stored fixture already carries its own league)
// but kept in the signature since callers already pass it.
async function refetchFixtures(leagueCodes, storedFixtures) {
  if (!storedFixtures || storedFixtures.length === 0) return [];
  const toRefetch      = storedFixtures.filter(f => !f.completed && !f.postponed);
  const alreadyDecided = storedFixtures.filter(f => f.completed || f.postponed);

  const refetched = await Promise.all(toRefetch.map(async f => {
    try {
      const data = await fetchJSON(`${ESPN_SOCCER}/${f.league}/scoreboard/${f.id}`);
      return parseEspnEvent(data, f.league) || f;
    } catch (err) {
      console.warn(`[football] Could not refetch fixture ${f.id} (${f.league}):`, err.message);
      return f; // keep the stale cached row rather than dropping the fixture entirely
    }
  }));

  return [...alreadyDecided, ...refetched];
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

module.exports = { fetchFixtures, getCurrentGameweekFixtures, refetchFixtures, processResults, LEAGUE_NAMES };
