const crypto = require('crypto');

// Short, readable temp password for admin-issued or host-added ("walk-up")
// accounts — shown once to be relayed to the player, who must change it on
// first login. Uses crypto.randomBytes rather than Math.random(), which is
// not cryptographically random and was brute-forceable in a small keyspace.
function generateTempPassword(prefix = '') {
  const token = crypto.randomBytes(6).toString('base64url');
  return prefix ? `${prefix}-${token}` : token;
}

module.exports = { generateTempPassword };
