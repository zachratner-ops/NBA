const express = require('express');
const https = require('https');
const app = express();

const BDLK = 'a99fff51-9e0a-408a-a5d3-88b53588c599';
const BBREF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.basketball-reference.com/'
};

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchBBRef(path) {
  return httpsGet('www.basketball-reference.com', path, BBREF_HEADERS);
}

function fetchBDL(path) {
  return httpsGet('api.balldontlie.io', path, {
    'Authorization': BDLK,
    'Accept': 'application/json'
  });
}

// ── Series standings from balldontlie ─────────────────────────────
// Fetch all playoff games and tally wins per team per series
async function getSeriesStandings() {
  const { status, body } = await fetchBDL('/nba/v1/games?seasons[]=2025&postseason=true&per_page=100');
  if (status !== 200) throw new Error(`BDL games returned ${status}`);
  const data = JSON.parse(body);
  const games = data.data || [];

  // wins[teamAbb] = { opponent: teamAbb, wins: N }
  const matchups = {}; // "TEAM1-TEAM2" -> { t1: wins, t2: wins }

  games.forEach(g => {
    if (g.status !== 'Final') return;
    const home = g.home_team.abbreviation;
    const away = g.visitor_team.abbreviation;
    const key = [home, away].sort().join('-');
    if (!matchups[key]) matchups[key] = { [home]: 0, [away]: 0 };
    if (g.home_team_score > g.visitor_team_score) {
      matchups[key][home]++;
    } else {
      matchups[key][away]++;
    }
  });

  // Build net lead per team
  const standings = {};
  const eliminated = new Set();
  Object.values(matchups).forEach(m => {
    const teams = Object.keys(m);
    const t1 = teams[0], t2 = teams[1];
    const lead = m[t1] - m[t2];
    standings[t1] = lead;
    standings[t2] = -lead;
    if (m[t1] === 4) eliminated.add(t2);
    if (m[t2] === 4) eliminated.add(t1);
  });

  return { standings, eliminated: [...eliminated] };
}

// ── Main /all endpoint ─────────────────────────────────────────────
app.get('/all', async (req, res) => {
  try {
    const [ptsResult, injuryResult, seriesResult] = await Promise.all([
      fetchBBRef('/playoffs/NBA_2026_totals.html'),
      fetchBBRef('/friv/injuries.fcgi'),
      getSeriesStandings()
    ]);

    // Parse points from BBRef
    const players = {};
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    while ((match = rowRegex.exec(ptsResult.body)) !== null) {
      const row = match[1];
      const nameMatch = row.match(/data-stat="player"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
      const ptsMatch = row.match(/data-stat="pts"[^>]*>(\d+)<\/td>/);
      if (nameMatch && ptsMatch) {
        const name = nameMatch[1].trim();
        const pts = parseInt(ptsMatch[1], 10);
        players[name] = (players[name] || 0) + pts;
      }
    }

    // Parse injuries from BBRef
    const injured = new Set();
    function normalize(str) {
      return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0141/g,'L').replace(/\u0142/g,'l');
    }
    const injRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let injMatch;
    while ((injMatch = injRowRegex.exec(injuryResult.body)) !== null) {
      const row = injMatch[1];
      const nameMatch = row.match(/data-stat="player"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
      const descMatch = row.match(/data-stat="note"[^>]*>([^<]+)<\/td>/);
      if (nameMatch && descMatch && descMatch[1].trim().length > 0) {
        injured.add(normalize(nameMatch[1].trim()));
      }
    }

    console.log(`Players: ${Object.keys(players).length}, Eliminated: ${seriesResult.eliminated.join(',')}, Series: ${JSON.stringify(seriesResult.standings)}`);

    res.json({
      updated: new Date().toISOString(),
      players,
      eliminated: seriesResult.eliminated,
      injured: [...injured],
      seriesStandings: seriesResult.standings
    });
  } catch(e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/debug-series', async (req, res) => {
  try {
    const result = await getSeriesStandings();
    res.json(result);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NBA proxy running on port ${PORT}`));
