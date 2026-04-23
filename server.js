const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/pts', async (req, res) => {
  try {
    const html = await fetch('https://www.basketball-reference.com/playoffs/NBA_2026_totals.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.basketball-reference.com/'
      }
    }).then(r => r.text());

    // Parse player name + points from the totals table
    const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
    const players = {};

    rows.forEach(row => {
      const nameMatch = row.match(/data-append-csv="[^"]*"[^>]*>([^<]+)<\/a>/);
      const ptsMatch = row.match(/data-stat="pts"[^>]*>(\d+)<\/td>/);
      if (nameMatch && ptsMatch) {
        const name = nameMatch[1].trim();
        const pts = parseInt(ptsMatch[1]);
        // Keep highest (some players appear multiple times if traded)
        if (!players[name] || pts > players[name]) {
          players[name] = pts;
        }
      }
    });

    res.json({ updated: new Date().toISOString(), players });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NBA proxy running on port ${PORT}`));
