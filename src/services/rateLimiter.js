// A simple in-memory sliding-window rate limiter, keyed by an arbitrary
// string (IP, IP+username, IP+email, ...). Was copy-pasted independently
// four times (auth.js's login/forgot-password/register limiters, plus
// contact.js) — same logic, same shape, each with its own Map.
//
// Per-process state — resets on deploy/restart, and wouldn't coordinate
// correctly across multiple instances if this app is ever scaled
// horizontally. Fine at this app's current scale; swap for a shared store
// (Redis etc.) if that changes.
function createRateLimiter(maxAttempts, windowMs) {
  const attempts = new Map();

  function isLimited(key) {
    const entry = attempts.get(key);
    if (!entry || Date.now() > entry.resetAt) return false;
    return entry.count >= maxAttempts;
  }

  function recordAttempt(key) {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || now > entry.resetAt) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count++;
    }
  }

  // Called on a successful login, so a real user who mistyped their
  // password a few times isn't left rate-limited after finally getting it
  // right — forgot-password/register/contact don't need this, there's no
  // analogous "success" that should clear the count.
  function reset(key) {
    attempts.delete(key);
  }

  return { isLimited, recordAttempt, reset };
}

module.exports = { createRateLimiter };
