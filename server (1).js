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
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.basketball-reference.com/',
        'Cache-Control': 'no-cache'
      }
    }).then(r => r.text());

    const players = {};

    // BBRef totals table rows look like:
    // <td class="left " data-stat="player"><a href="/players/x/xyz.html">Name</a></td>
    // <td class="right " data-stat="pts">123</td>
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let match;
    while ((match = rowRegex.exec(html)) !== null) {
      const row = match[1];
      // Extract player name
      const nameMatch = row.match(/data-stat="player"[^>]*>.*?<a[^>]*>([^<]+)<\/a>/);
      // Extract points
      const ptsMatch = row.match(/data-stat="pts"[^>]*>(\d+)<\/td>/);
      if (nameMatch && ptsMatch) {
        const name = nameMatch[1].trim();
        const pts = parseInt(ptsMatch[1], 10);
        // If player appears twice (traded), sum them
        players[name] = (players[name] || 0) + pts;
      }
    }

    console.log('Parsed players:', Object.keys(players).length, JSON.stringify(players).slice(0, 300));
    res.json({ updated: new Date().toISOString(), players });
  } catch (e) {
    console.error('Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/debug', async (req, res) => {
  try {
    const html = await fetch('https://www.basketball-reference.com/playoffs/NBA_2026_totals.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://www.basketball-reference.com/'
      }
    }).then(r => r.text());
    // Return a snippet so we can see what BBRef is actually sending
    res.json({ length: html.length, snippet: html.slice(0, 2000) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NBA proxy running on port ${PORT}`));
