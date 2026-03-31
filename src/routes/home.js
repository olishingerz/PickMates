const express = require('express');
const { pool } = require('../db');
const { SCORES_THAT_COUNT, MIN_CUT_MAKERS } = require('../constants');

const router = express.Router();

// Format an integer score-to-par as a display string
function fmtScore(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

// Calculate all scoring data for a user's picks
function calcTeamData(picks) {
  // Picks that have a score
  const withScore = picks.filter(p => p.score_to_par !== null && p.score_to_par !== undefined);

  // Sort ascending — lowest (best) score first
  const sorted = [...withScore].sort((a, b) => a.score_to_par - b.score_to_par);

  // Team score: sum of lowest SCORES_THAT_COUNT players
  const counting = sorted.slice(0, SCORES_THAT_COUNT);
  const teamScore = counting.length === SCORES_THAT_COUNT
    ? counting.reduce((s, p) => s + p.score_to_par, 0)
    : null; // not enough data yet

  // Qualification: need MIN_CUT_MAKERS who made the cut
  const cutMakers = picks.filter(p => p.made_cut === true).length;
  const qualified = cutMakers >= MIN_CUT_MAKERS;

  // Tiebreaker: best (lowest) individual score in the team
  const bestIndividual = sorted[0]?.score_to_par ?? null;

  // Best single round (for round pot) — raw stroke score, lower is better
  let bestRound = null;
  let bestRoundNum = null;
  let bestRoundPlayer = null;
  for (const pick of picks) {
    for (const [key, label] of [['r1','R1'],['r2','R2'],['r3','R3'],['r4','R4']]) {
      const val = pick[key];
      if (val !== null && val !== undefined && (bestRound === null || val < bestRound)) {
        bestRound = val;
        bestRoundNum = label;
        bestRoundPlayer = pick.player_name;
      }
    }
  }

  return { teamScore, qualified, cutMakers, counting, bestIndividual, bestRound, bestRoundNum, bestRoundPlayer };
}

router.get('/', async (req, res) => {
  try {
    // Fetch all participants' picks with leaderboard data
    const { rows } = await pool.query(`
      SELECT
        u.id           AS user_id,
        u.username,
        u.draft_position,
        p.player_name,
        p.pick_slot,
        l.position     AS lb_position,
        l.score_to_par,
        l.made_cut,
        l.r1, l.r2, l.r3, l.r4,
        l.updated_at
      FROM users u
      LEFT JOIN picks p ON p.user_id = u.id
      LEFT JOIN leaderboard l
             ON LOWER(TRIM(l.player_name)) = LOWER(TRIM(p.player_name))
      WHERE u.draft_position IS NOT NULL
      ORDER BY u.draft_position ASC, p.pick_slot ASC
    `);

    // Group rows into teams
    const teamsMap = new Map();
    for (const row of rows) {
      if (!teamsMap.has(row.user_id)) {
        teamsMap.set(row.user_id, {
          user_id: row.user_id,
          username: row.username,
          draft_position: row.draft_position,
          picks: [],
          updated_at: null,
        });
      }
      const team = teamsMap.get(row.user_id);
      if (row.player_name) {
        team.picks.push({
          player_name:  row.player_name,
          pick_slot:    row.pick_slot,
          lb_position:  row.lb_position,
          score_to_par: row.score_to_par,
          made_cut:     row.made_cut,
          r1: row.r1, r2: row.r2, r3: row.r3, r4: row.r4,
        });
        if (row.updated_at) team.updated_at = row.updated_at;
      }
    }

    // Build scored teams array
    const teams = [...teamsMap.values()].map(team => ({
      ...team,
      ...calcTeamData(team.picks),
    }));

    // Sort standings:
    // 1. Qualified teams first, sorted by teamScore ASC, then bestIndividual ASC (tiebreaker)
    // 2. Unqualified teams below, sorted by teamScore ASC
    // 3. Teams with no score (draft not done / tournament hasn't started) last
    const qualified   = teams.filter(t => t.qualified && t.teamScore !== null);
    const unqualified = teams.filter(t => !t.qualified && t.teamScore !== null);
    const noScore     = teams.filter(t => t.teamScore === null);

    qualified.sort((a, b) =>
      a.teamScore !== b.teamScore
        ? a.teamScore - b.teamScore
        : (a.bestIndividual ?? 999) - (b.bestIndividual ?? 999)
    );
    unqualified.sort((a, b) =>
      a.teamScore !== b.teamScore
        ? a.teamScore - b.teamScore
        : (a.bestIndividual ?? 999) - (b.bestIndividual ?? 999)
    );

    const standings = [...qualified, ...unqualified, ...noScore].map((t, i) => ({
      ...t,
      rank: i + 1,
    }));

    // Round pot: find the user with the best (lowest) single round score
    const roundPotRankings = [...teams]
      .filter(t => t.bestRound !== null)
      .sort((a, b) => a.bestRound - b.bestRound)
      .map((t, i) => ({ ...t, rank: i + 1 }));

    // Last updated
    const lastUpdated = rows.find(r => r.updated_at)?.updated_at || null;

    res.render('home', {
      standings,
      roundPotRankings,
      lastUpdated,
      fmtScore,
      SCORES_THAT_COUNT,
      MIN_CUT_MAKERS,
    });
  } catch (err) {
    console.error('[home]', err);
    res.render('home', {
      standings: [], roundPotRankings: [], lastUpdated: null,
      fmtScore, SCORES_THAT_COUNT, MIN_CUT_MAKERS,
    });
  }
});

module.exports = router;
