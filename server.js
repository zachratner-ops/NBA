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

app.get('/debug', async (req, res) => {
  try {
    const { status, body } = await fetchBBRef('/playoffs/NBA_2026_totals.html');
    res.json({ status, length: body.length, snippet: body.slice(0, 2000) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NBA proxy running on port ${PORT}`));
