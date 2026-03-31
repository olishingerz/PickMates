const MAX_PLAYERS       = parseInt(process.env.MAX_PLAYERS)        || 6;
const PICKS_PER_PLAYER  = parseInt(process.env.PICKS_PER_PLAYER)   || 6;
const SCORES_THAT_COUNT = parseInt(process.env.SCORES_THAT_COUNT)  || 3; // lowest N scores per team
const MIN_CUT_MAKERS    = parseInt(process.env.MIN_CUT_MAKERS)      || 3; // need 3+ to make cut to qualify

// Prizes (display only)
const ENTRY_FEE    = 12;
const TEAM_PRIZE   = 10;
const ROUND_PRIZE  = 2;

module.exports = { MAX_PLAYERS, PICKS_PER_PLAYER, SCORES_THAT_COUNT, MIN_CUT_MAKERS, ENTRY_FEE, TEAM_PRIZE, ROUND_PRIZE };
