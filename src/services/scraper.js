const puppeteer = require('puppeteer');
const { pool } = require('../db');

const FLASHSCORE_URL = 'https://www.flashscore.co.uk/golf/pga-tour/masters-tournament/';

// Convert a score-to-par string to integer: "E"→0, "-10"→-10, "+3"→3, otherwise null
function parseScoreToPar(str) {
  if (!str) return null;
  const s = str.trim();
  if (!s || s === '-' || s === 'CUT' || s === 'WD' || s === 'DQ' || s === 'MDF') return null;
  if (s.toLowerCase() === 'e') return 0;
  const n = parseInt(s.replace('+', ''), 10);
  return isNaN(n) ? null : n;
}

// Return integer if the string is a plausible round stroke score (60-90), else null
function parseRoundScore(str) {
  if (!str) return null;
  const n = parseInt(str.trim(), 10);
  return n >= 60 && n <= 90 ? n : null;
}

async function scrapeLeaderboard() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // undefined = use bundled (local dev)
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // Block images/fonts/media to speed up
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(FLASHSCORE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Dismiss cookie consent if shown
    try {
      await page.waitForSelector('#onetrust-accept-btn-handler', { timeout: 5000 });
      await page.click('#onetrust-accept-btn-handler');
      await new Promise(r => setTimeout(r, 1000));
    } catch { /* no banner */ }

    // Click Standings/Leaderboard tab if present
    try {
      const tab = await page.$('a[href*="standings"], button[data-testid*="standings"]');
      if (tab) { await tab.click(); await new Promise(r => setTimeout(r, 2000)); }
    } catch { /* no tab */ }

    await new Promise(r => setTimeout(r, 3000));

    // ── Extract leaderboard data ───────────────────────────────────────────────
    const rawPlayers = await page.evaluate(() => {
      const results = [];
      let pastCutLine = false;

      // Strategy 1: standard HTML <table>
      const tableRows = Array.from(document.querySelectorAll('table tr'));
      if (tableRows.length > 1) {
        for (const row of tableRows) {
          // Detect cut line separator
          const rowText = row.textContent.trim();
          if (/^CUT$/i.test(rowText) || row.classList.toString().toLowerCase().includes('cut')) {
            pastCutLine = true;
            continue;
          }

          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 3) continue;

          const posText = cells[0].textContent.trim().replace(/^[TM]/, '');
          const pos = parseInt(posText, 10);
          if (isNaN(pos) || pos <= 0 || pos > 300) continue;

          // Player name: first cell after position that looks like a name
          let playerName = '';
          let nameIdx = -1;
          for (let i = 1; i < Math.min(cells.length, 5); i++) {
            const t = cells[i].textContent.trim();
            if (t.length > 2 && /^[A-Za-zÀ-ÿ\s\-\.']+$/.test(t)) {
              playerName = t;
              nameIdx = i;
              break;
            }
          }
          if (!playerName) continue;

          // Collect all cell values after the name
          const rest = cells.slice(nameIdx + 1).map(c => c.textContent.trim());

          results.push({ pos, playerName, rest, madeCut: !pastCutLine });
        }
        if (results.length > 0) return { strategy: 'table', results };
      }

      // Strategy 2: Flashscore div-based rows
      const selectors = [
        '[class*="tableWrapper"] [class*="row"]',
        '[class*="standings"] [class*="row"]',
        '[class*="participant"]',
      ];
      for (const sel of selectors) {
        const rows = Array.from(document.querySelectorAll(sel));
        if (!rows.length) continue;

        pastCutLine = false;
        for (const row of rows) {
          if (row.textContent.trim().toUpperCase() === 'CUT') { pastCutLine = true; continue; }

          const posEl   = row.querySelector('[class*="pos"],[class*="rank"],[class*="Rank"]');
          const nameEl  = row.querySelector('[class*="name"],[class*="Name"],[class*="participant"]');
          if (!nameEl) continue;

          const posText = posEl?.textContent.trim().replace(/^[TM]/, '') || '';
          const pos     = parseInt(posText, 10);

          results.push({
            pos: isNaN(pos) ? results.length + 1 : pos,
            playerName: nameEl.textContent.trim(),
            rest: [],
            madeCut: !pastCutLine,
          });
        }
        if (results.length > 0) return { strategy: 'divs', results };
      }

      return { strategy: 'none', results: [] };
    });

    if (rawPlayers.results.length === 0) {
      const sample = await page.evaluate(() => document.body.innerText.substring(0, 400));
      console.warn('[scraper] No players found. Page sample:', sample);
      throw new Error('No players found — tournament may not have started yet, or selectors need updating');
    }

    console.log(`[scraper] Strategy "${rawPlayers.strategy}" found ${rawPlayers.results.length} players`);

    // Parse each raw row into structured data
    const players = rawPlayers.results.slice(0, 120).map(({ pos, playerName, rest, madeCut }) => {
      // From the "rest" values, try to identify:
      //   round scores (integers 60-90) and score-to-par (E / ±N)
      const roundScores = [];
      let scoreTopar = null;

      for (const val of rest) {
        const rs = (() => {
          const n = parseInt(val, 10);
          return n >= 60 && n <= 90 ? n : null;
        })();
        if (rs !== null) {
          roundScores.push(rs);
          continue;
        }
        if (scoreTopar === null) {
          const stp = (() => {
            if (!val || val === '-') return undefined;
            if (val.toLowerCase() === 'e') return 0;
            const n = parseInt(val.replace('+', ''), 10);
            return isNaN(n) ? undefined : n;
          })();
          if (stp !== undefined) scoreTopar = stp;
        }
      }

      return {
        position:    pos,
        player_name: playerName,
        score_to_par: scoreTopar,
        made_cut:    madeCut,
        r1: roundScores[0] ?? null,
        r2: roundScores[1] ?? null,
        r3: roundScores[2] ?? null,
        r4: roundScores[3] ?? null,
      };
    });

    // Persist to database
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM leaderboard');
      for (const p of players) {
        await client.query(
          `INSERT INTO leaderboard (player_name, position, score_to_par, made_cut, r1, r2, r3, r4)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [p.player_name, p.position, p.score_to_par, p.made_cut, p.r1, p.r2, p.r3, p.r4]
        );
      }
      await client.query('COMMIT');
      console.log(`[scraper] Leaderboard updated: ${players.length} players`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return players;
  } finally {
    await browser.close();
  }
}

module.exports = { scrapeLeaderboard };
