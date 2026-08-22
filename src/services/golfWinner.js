const { SCORES_THAT_COUNT } = require('../constants');

// Pure — picks the team and individual winners from pre-fetched rows. Split out
// from computeGolfDraftWinner so the scoring rules can be unit tested without a
// database.
function pickGolfDraftWinners(rows, scoresThatCount = SCORES_THAT_COUNT) {
  let teamWinner = null, bestTeamScore = Infinity;
  let indivWinner = null, bestIndivScore = Infinity;

  for (const row of rows) {
    const scores = row.scores || [];
    const cutMakers = row.cut_makers || 0;
    if (scores.length > 0 && scores[0] < bestIndivScore) {
      bestIndivScore = scores[0];
      indivWinner = row.username;
    }
    if (cutMakers >= scoresThatCount && scores.length >= scoresThatCount) {
      const teamScore = scores.slice(0, scoresThatCount).reduce((s, v) => s + v, 0);
      if (teamScore < bestTeamScore) {
        bestTeamScore = teamScore;
        teamWinner = row.username;
      }
    }
  }

  return { teamWinner, indivWinner };
}

// Shared golf-draft winner calculation — used both when ESPN auto-detects a
// finished tournament (services/scraper.js) and when a host manually completes
// a game (routes/games.js). Previously duplicated in both places; a tweak to
// one without the other would let the two paths silently disagree on a winner.
async function computeGolfDraftWinner(db, gameId) {
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

  return pickGolfDraftWinners(rows);
}

module.exports = { computeGolfDraftWinner, pickGolfDraftWinners };
