const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  // Retry connection up to 10 times with 5s delay — handles slow DB startup on Railway
  let lastErr;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await pool.query(schema);
      console.log('Database initialised');
      return;
    } catch (err) {
      lastErr = err;
      const code = err.code || (err.errors?.[0]?.code);
      if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') {
        console.warn(`[db] Connection attempt ${attempt}/10 failed (${code}) — retrying in 5s…`);
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw err; // Non-connection error (e.g. bad SQL) — don't retry
      }
    }
  }
  throw lastErr;
}

module.exports = { pool, initDb };
