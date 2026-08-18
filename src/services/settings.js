const { pool } = require('../db');

const ROLE_OPTIONS = [
  { value: 'admin',  label: 'Admins' },
  { value: 'paid',   label: 'Paid members' },
  { value: 'anyone', label: 'Anyone (any logged-in user)' },
];
const VALID_ROLES = ROLE_OPTIONS.map(r => r.value);
const DEFAULT_ROLES = ['admin', 'paid'];

async function getGameCreationRoles() {
  const { rows } = await pool.query('SELECT game_creation_roles FROM site_settings WHERE id = 1');
  const raw = rows[0]?.game_creation_roles;
  if (!raw) return DEFAULT_ROLES;
  const roles = raw.split(',').map(s => s.trim()).filter(Boolean);
  return roles.length > 0 ? roles : DEFAULT_ROLES;
}

async function setGameCreationRoles(roles) {
  const clean = roles.filter(r => VALID_ROLES.includes(r));
  await pool.query(
    `INSERT INTO site_settings (id, game_creation_roles) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET game_creation_roles = $1`,
    [clean.join(',')]
  );
  return clean;
}

function canCreateGames(user, roles) {
  if (!user) return false;
  if (roles.includes('anyone')) return true;
  if (roles.includes('admin') && user.isAdmin) return true;
  if (roles.includes('paid') && user.isPaid) return true;
  return false;
}

module.exports = { ROLE_OPTIONS, VALID_ROLES, getGameCreationRoles, setGameCreationRoles, canCreateGames };
