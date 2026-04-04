const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS   = process.env.EMAIL_FROM || 'PickMates <no-reply@pickmates.app>';
const APP_URL        = process.env.APP_URL    || 'https://pickmates.up.railway.app';

// Only initialise Resend if an API key is configured — avoids crashing in dev
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

async function sendEmail({ to, subject, html }) {
  if (!resend) {
    console.log(`[email] No RESEND_API_KEY — would have sent "${subject}" to ${to}`);
    return;
  }
  try {
    await resend.emails.send({ from: FROM_ADDRESS, to, subject, html });
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
  await sendEmail({
    to:      user.email,
    subject: `⛳ It's your pick! — ${game.name}`,
    html: `
      <p>Hi ${user.username},</p>
      <p>It's your turn to pick in <strong>${game.name}</strong>.</p>
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

  for (const player of players) {
    if (!player.email) continue;
    await sendEmail({
      to:      player.email,
      subject: `🏆 Pick reminder — Week ${weekNumber} closes ${deadlineStr}`,
      html: `
        <p>Hi ${player.username},</p>
        <p>Don't forget to submit your pick for <strong>${game.name}</strong> — Week ${weekNumber}.</p>
        <p><strong>Deadline: ${deadlineStr}</strong></p>
        <p><a href="${APP_URL}/game/${game.id}/lms/picks" style="background:#006747;color:#fff;padding:.5rem 1rem;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600">Make your pick →</a></p>
        <p style="color:#666;font-size:.85em">PickMates · Last Man Standing</p>
      `,
    });
  }
}

module.exports = { sendDraftTurnEmail, sendLmsDeadlineEmails };
