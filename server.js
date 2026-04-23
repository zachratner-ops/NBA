const express = require('express');
const https = require('https');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

function fetchBBRef(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.basketball-reference.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.basketball-reference.com/'
      }
    };
    const req = https.request(options, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Team name -> abbreviation map
const TEAM_ABB = {
  'boston celtics':'BOS','los angeles lakers':'LAL','denver nuggets':'DEN',
  'oklahoma city thunder':'OKC','new york knicks':'NYK','san antonio spurs':'SAS',
  'cleveland cavaliers':'CLE','houston rockets':'HOU','detroit pistons':'DET',
  'minnesota timberwolves':'MIN','philadelphia 76ers':'PHI','atlanta hawks':'ATL',
  'orlando magic':'ORL','portland trail blazers':'POR','toronto raptors':'TOR',
  'phoenix suns':'PHO','miami heat':'MIA','golden state warriors':'GSW',
  'los angeles clippers':'LAC','milwaukee bucks':'MIL','memphis grizzlies':'MEM',
  'dallas mavericks':'DAL','indiana pacers':'IND','new orleans pelicans':'NOP',
  'sacramento kings':'SAC','utah jazz':'UTA','charlotte hornets':'CHA',
  'chicago bulls':'CHI','washington wizards':'WAS','brooklyn nets':'BKN',
  'los angeles lakers':'LAL'
};

// Fetch eliminated teams from BBRef playoff series page
// A team is eliminated if they lost a series (series shows W-L or L-W with one side at 4 wins)
app.get('/eliminated', async (req, res) => {
  try {
    const { status, body: html } = await fetchBBRef('/playoffs/NBA_2026.html');
    if (status !== 200) {
      return res.status(502).json({ error: `BBRef returned ${status}` });
    }

    const eliminated = new Set();

    // BBRef series results look like:
    // Team A (4) vs Team B (2) — Team B is eliminated
    // Match patterns like "Won 4-1" / "Lost 4-2" etc in series divs
    // We look for series where one team has been beaten (appears as losing team in completed series)

    // Match series result blocks: e.g. "Detroit Pistons defeated Orlando Magic, 4-1"
    const seriesRegex = /([A-Za-z\s]+?)\s+defeated\s+([A-Za-z\s]+?),\s*4-\d/gi;
    let m;
    while ((m = seriesRegex.exec(html)) !== null) {
      const loser = m[2].trim().toLowerCase();
      const abb = TEAM_ABB[loser];
      if (abb) eliminated.add(abb);
    }

    // Also check for teams with 0 wins remaining (still in first round losers)
    // Backup: look for series scores in the standings table format
    // Pattern: team listed with fewer wins in a completed series
    const scoreRegex = /(\d)-(\d)<\/td>/g;

    console.log('Eliminated teams:', [...eliminated]);
    res.json({ eliminated: [...eliminated], updated: new Date().toISOString() });
  } catch(e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/pts', async (req, res) => {
  try {
    const { status, body: html } = await fetchBBRef('/playoffs/NBA_2026_totals.html');
    if (status !== 200) {
      return res.status(502).json({ error: `BBRef returned ${status}`, html: html.slice(0, 500) });
    }

    const players = {};
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const row = match[1];
      const nameMatch = row.match(/data-stat="player"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
      const ptsMatch = row.match(/data-stat="pts"[^>]*>(\d+)<\/td>/);
      if (nameMatch && ptsMatch) {
        const name = nameMatch[1].trim();
        const pts = parseInt(ptsMatch[1], 10);
        players[name] = (players[name] || 0) + pts;
      }
    }

    console.log(`Parsed ${Object.keys(players).length} players`);
    res.json({ updated: new Date().toISOString(), players });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

// Combined endpoint — pts + eliminated + injuries in one request
app.get('/all', async (req, res) => {
  try {
    const [ptsResult, elimResult, injuryResult] = await Promise.all([
      fetchBBRef('/playoffs/NBA_2026_totals.html'),
      fetchBBRef('/playoffs/NBA_2026.html'),
      fetchBBRef('/friv/injuries.fcgi')
    ]);

    // Parse points
    const players = {};
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    const ptsHtml = ptsResult.body;
    while ((match = rowRegex.exec(ptsHtml)) !== null) {
      const row = match[1];
      const nameMatch = row.match(/data-stat="player"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
      const ptsMatch = row.match(/data-stat="pts"[^>]*>(\d+)<\/td>/);
      if (nameMatch && ptsMatch) {
        const name = nameMatch[1].trim();
        const pts = parseInt(ptsMatch[1], 10);
        players[name] = (players[name] || 0) + pts;
      }
    }

    // Series standings — net lead per team (positive = leading, negative = trailing)
    // Updated: April 23, 2026
    // Format: teamAbb: winsLeading - winsTrailing (e.g. 2 means up 2-0, -1 means down 1-2)
    const seriesStandings = {
      // East
      'DET': 1,   // Pistons vs Magic: 1-1
      'ORL': -1,  // Magic vs Pistons: 1-1
      'BOS': 1,   // Celtics vs 76ers: 1-1
      'PHI': -1,  // 76ers vs Celtics: 1-1
      'NYK': 1,   // Knicks vs Hawks: 1-1 (Knicks won G1, Hawks won G2)
      'ATL': -1,  // Hawks vs Knicks: 1-1
      'CLE': 2,   // Cavaliers vs Raptors: 2-0
      'TOR': -2,  // Raptors vs Cavaliers: 0-2
      // West
      'OKC': 2,   // Thunder vs Suns: 2-0
      'PHO': -2,  // Suns vs Thunder: 0-2
      'SAS': 1,   // Spurs vs Trail Blazers: 1-1
      'POR': -1,  // Trail Blazers vs Spurs: 1-1
      'DEN': 2,   // Nuggets vs Timberwolves: 2-0
      'MIN': -2,  // Timberwolves vs Nuggets: 0-2
      'LAL': 2,   // Lakers vs Rockets: 2-0
      'HOU': -2,  // Rockets vs Lakers: 0-2
    };

    // Parse eliminated teams from BBRef (completed series)
    const eliminated = new Set();
    const elimHtml = elimResult.body;
    const elimRegex = /([A-Za-z\s\.]+?)\s+defeated\s+([A-Za-z\s\.]+?),\s*4-\d/gi;
    let m;
    while ((m = elimRegex.exec(elimHtml)) !== null) {
      const loser = m[2].trim().toLowerCase().replace(/\.$/, '');
      const abb = TEAM_ABB[loser];
      if (abb) { eliminated.add(abb); seriesStandings[abb] = -4; }
    }

    // Parse injuries — BBRef injury report lists player name + description
    const injured = new Set();
    const injHtml = injuryResult.body;
    const injRowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let injMatch;
    // Normalize accented characters to plain ASCII for matching
    function normalize(str) {
      return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u0141/g,'L').replace(/\u0142/g,'l');
    }
    while ((injMatch = injRowRegex.exec(injHtml)) !== null) {
      const row = injMatch[1];
      const nameMatch = row.match(/data-stat="player"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
      const descMatch = row.match(/data-stat="note"[^>]*>([^<]+)<\/td>/);
      if (nameMatch && descMatch && descMatch[1].trim().length > 0) {
        injured.add(normalize(nameMatch[1].trim()));
      }
    }

    console.log(`Players: ${Object.keys(players).length}, Eliminated: ${[...eliminated].join(',')}, Injured: ${[...injured].join(',')}`);
    res.json({
      updated: new Date().toISOString(),
      players,
      eliminated: [...eliminated],
      injured: [...injured],
      seriesStandings
    });
  } catch(e) {
    console.error(e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug', async (req, res) => {
  try {
    const { status, body } = await fetchBBRef('/playoffs/NBA_2026.html');
    // Find "defeated" mentions to see if parsing will work
    const matches = body.match(/defeated[\s\S]{0,80}/gi) || [];
    res.json({ status, defeatedMatches: matches.slice(0,10), snippet: body.slice(0, 3000) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NBA proxy running on port ${PORT}`));
