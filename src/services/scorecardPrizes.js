// Golf Scorecard prize-pot split — single source of truth, previously
// duplicated independently in src/views/scorecard.ejs (live pot display) and
// src/routes/profile.js (historical winnings). Team format is 50% winning
// team / 40% best individual net score / 10% nearest the pin; individual
// format is 70% individual / 30% nearest the pin (no team prize, since
// there are no teams). The nearest-the-pin share is always the remainder
// rather than its own rounded percentage, so the parts always sum exactly
// to the pot even after rounding.
function computeScorecardPrizeSplit(entryFee, playerCount, format) {
  const pot = (parseFloat(entryFee) || 0) * (playerCount || 0);
  if (format === 'individual') {
    const indivPrize = Math.round(pot * 0.7);
    const ctpPrize   = pot - indivPrize;
    return { pot, teamPrize: 0, indivPrize, ctpPrize };
  }
  const teamPrize  = Math.round(pot * 0.5);
  const indivPrize = Math.round(pot * 0.4);
  const ctpPrize   = pot - teamPrize - indivPrize;
  return { pot, teamPrize, indivPrize, ctpPrize };
}

module.exports = { computeScorecardPrizeSplit };
