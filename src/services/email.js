const nodemailer = require('nodemailer');

const FROM_ADDRESS = process.env.EMAIL_FROM || 'PickMates <no-reply@pickmates.app>';
const APP_URL       = process.env.APP_URL    || 'https://pickmates.up.railway.app';

// Only initialise a transporter if SMTP is configured — avoids crashing in dev.
// Standard SMTP settings, set as env vars (Railway → Variables):
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE ("true" for port 465, "false" for 587/STARTTLS),
//   SMTP_USER, SMTP_PASS
const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

// Game names and usernames are user-chosen and get interpolated straight into
// these HTML emails — escape them so a malicious game name can't inject markup
// (e.g. a fake login link) into mail sent to every participant's real inbox.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendEmail({ to, subject, html }) {
  if (!transporter) {
    console.log(`[email] No SMTP_HOST configured — would have sent "${subject}" to ${to}`);
    return;
  }
  try {
    await transporter.sendMail({ from: FROM_ADDRESS, to, subject, html });
    console.log(`[email] Sent "${subject}" to ${to}`);
  } catch (err) {
    console.warn(`[email] Failed to send "${subject}" to ${to}:`, err.message);
  }
}

/**
 * Notify a player that it's their turn in the golf draft.
 * @param {{ email: string, username: string }} user
 * @param {{ id: number, name: string }} game
 */
async function sendDraftTurnEmail(user, game) {
  if (!user.email) return;
  const gameName = escapeHtml(game.name);
  await sendEmail({
    to:      user.email,
    subject: `⛳ It's your pick! — ${game.name}`,
    html: `
      <p>Hi ${escapeHtml(user.username)},</p>
      <p>It's your turn to pick in <strong>${gameName}</strong>.</p>
      <p><a href="${APP_URL}/game/${game.id}/draft" style="background:#006747;color:#fff;padding:.5rem 1rem;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Make your pick →</a></p>
      <p style="color:#666;font-size:.85em">PickMates · Golf draft competitions</p>
    `,
  });
}

/**
 * Notify all alive players in an LMS game 24h before the weekly deadline.
 * @param {Array<{ email: string, username: string }>} players
 * @param {{ id: number, name: string }} game
 * @param {number} weekNumber
 * @param {Date} deadline
 */
async function sendLmsDeadlineEmails(players, game, weekNumber, deadline) {
  const deadlineStr = deadline.toLocaleString('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });

  const gameName = escapeHtml(game.name);
  for (const player of players) {
    if (!player.email) continue;
    await sendEmail({
      to:      player.email,
      subject: `🏆 Pick reminder — Week ${weekNumber} closes ${deadlineStr}`,
      html: `
        <p>Hi ${escapeHtml(player.username)},</p>
        <p>Don't forget to submit your pick for <strong>${gameName}</strong> — Week ${weekNumber}.</p>
        <p><strong>Deadline: ${deadlineStr}</strong></p>
        <p><a href="${APP_URL}/game/${game.id}/lms/picks" style="background:#006747;color:#fff;padding:.5rem 1rem;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Make your pick →</a></p>
        <p style="color:#666;font-size:.85em">PickMates · Last Man Standing</p>
      `,
    });
  }
}

/**
 * Send a password reset link. The token in resetUrl is the raw (unhashed)
 * value — only its sha256 hash is ever stored in the database.
 * @param {{ email: string, username: string }} user
 * @param {string} resetUrl
 */
async function sendPasswordResetEmail(user, resetUrl) {
  if (!user.email) return;
  await sendEmail({
    to:      user.email,
    subject: '🔑 Reset your PickMates password',
    html: `
      <p>Hi ${escapeHtml(user.username)},</p>
      <p>We received a request to reset your PickMates password. This link expires in 1 hour.</p>
      <p><a href="${resetUrl}" style="background:#006747;color:#fff;padding:.5rem 1rem;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Reset password →</a></p>
      <p style="color:#666;font-size:.85em">If you didn't request this, you can safely ignore this email — your password won't change.</p>
    `,
  });
}

// Sends without swallowing the error, so a caller (the admin test-email route)
// can show the real SMTP failure reason instead of the generic silent-log
// behaviour every other email in this file uses.
async function sendTestEmail(to) {
  if (!transporter) throw new Error('SMTP is not configured — SMTP_HOST is not set.');
  await transporter.sendMail({
    from: FROM_ADDRESS,
    to,
    subject: '✅ PickMates SMTP test',
    html: '<p>If you\'re reading this, SMTP is working.</p>',
  });
}

module.exports = {
  sendDraftTurnEmail, sendLmsDeadlineEmails, sendPasswordResetEmail, sendTestEmail,
  isConfigured: () => !!transporter,
};
