const express = require('express');
const https = require('https');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const admin = require('firebase-admin');
const cron = require('node-cron');
const app = express();

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  // Handle preflight OPTIONS requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ── Firebase Admin ─────────────────────────────────────────────────
// Set these in Railway → Variables:
//   FIREBASE_PROJECT_ID     = giesener-bets
//   FIREBASE_CLIENT_EMAIL   = firebase-adminsdk-fbsvc@giesener-bets.iam.gserviceaccount.com
//   FIREBASE_PRIVATE_KEY    = (the full private key string, including \n characters)
let firebaseReady = false;
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Railway escapes newlines in env vars — this restores them
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
    databaseURL: 'https://giesener-bets-default-rtdb.firebaseio.com',
  });
  firebaseReady = true;
  console.log('Firebase Admin initialized');
} catch (e) {
  console.error('Firebase Admin init failed:', e.message);
}

function fbDb() {
  return admin.database();
}

// ── HTTP helper ───────────────────────────────────────────────────
function httpsGet(hostname, path, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (r) => {
      let data = '';
      r.on('data', chunk => data += chunk);
      r.on('end', () => resolve({ status: r.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request to ${hostname} timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

// ── State ─────────────────────────────────────────────────────────
const drafts = {};
const historyStore = {};
const OWNERS = ['Mark','Marc','Jared','Andrew','Zach','Ben','Matt'];

function getOrCreateDraft(slug) {
  if (!drafts[slug]) {
    drafts[slug] = {
      slug, name: '', status: 'setup',
      field: [], autopickList: [],
      owners: OWNERS,
      pickOrder: [], altOrder: [],
      pickSequence: [], altSequence: [],
      picks: {}, currentPickIndex: 0,
      currentPhase: 'main',
      subs: [], pot: 25 * 7,
      timerStart: null, timerDuration: 7200,
      locked: false, undoStack: [], redoStack: [],
      espnEventId: null
    };
    OWNERS.forEach(o => { drafts[slug].picks[o] = { golfers: [], alternate: null }; });
  }
  return drafts[slug];
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generatePickSequence(order) {
  const seq = [];
  for (let r = 0; r < 4; r++) {
    const round = r % 2 === 0 ? [...order] : [...order].reverse();
    round.forEach(o => seq.push({ owner: o, round: r + 1 }));
  }
  return seq;
}

// ── ESPN golf scores ──────────────────────────────────────────────
async function fetchGolfScores(eventId) {
  try {
    const { status, body } = await httpsGet(
      'site.api.espn.com',
      `/apis/site/v2/sports/golf/pga/leaderboard?event=${eventId}`,
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.espn.com/' }
    );
    if (status !== 200) return { error: `ESPN returned ${status}` };
    const data = JSON.parse(body);
    const players = {};
    const competitors = data?.events?.[0]?.competitions?.[0]?.competitors || [];
    competitors.forEach(c => {
      const name = c.athlete?.displayName;
      const statusName = c.status?.type?.name || '';
      const cut = statusName.includes('CUT') || statusName.includes('WD') || statusName.includes('DQ');
      const linescores = c.linescores || [];
      let toPar = 0;
      linescores.forEach(ls => { toPar += (ls.value || 0); });
      const displayScore = toPar === 0 ? 'E' : (toPar > 0 ? `+${toPar}` : `${toPar}`);
      if (name) players[name] = { score: toPar, display: displayScore, cut, status: statusName };
    });
    return { players, updated: new Date().toISOString() };
  } catch(e) {
    return { error: e.message };
  }
}

// ── NBA BBRef scraper ─────────────────────────────────────────────
// Fetches total playoff points from Basketball Reference totals page
async function fetchNBAScores() {
  try {
    const { status, body } = await httpsGet(
      'www.basketball-reference.com',
      '/playoffs/NBA_2026_totals.html',
      {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.basketball-reference.com/playoffs/',
        'Cache-Control': 'no-cache',
      }
    );

    if (status !== 200) return { error: `BBRef returned ${status}` };

    const players = {};

    // Match full data rows using class="full_table" as the anchor
    // This captures the entire <tr> block including pts which is the last column
    const trRegex = /<tr[^>]*class="full_table"[^>]*>([\s\S]*?)<\/tr>/g;
    let trMatch;
    while ((trMatch = trRegex.exec(body)) !== null) {
      const row = trMatch[1];

      const nameMatch = row.match(/data-stat="player"[^>]*><a[^>]*>([^<]+)<\/a>/);
      if (!nameMatch) continue;
      const name = nameMatch[1].trim();
      if (!name || name === 'Player') continue;

      const ptsMatch = row.match(/data-stat="pts"[^>]*>\s*(\d+)\s*<\/td>/);
      if (!ptsMatch) continue;
      const pts = parseInt(ptsMatch[1], 10);
      if (isNaN(pts)) continue;

      // Keep highest total (handles traded players appearing multiple times)
      if (!players[name] || pts > players[name]) {
        players[name] = pts;
      }
    }

    // Append a daily snapshot for the chart
    // Key by date so same-day refreshes overwrite rather than pile up
    const OWNERS_LIST = [
      { name: 'Max',     players: ['Shai Gilgeous-Alexander', "De'Aaron Fox", 'Karl-Anthony Towns', 'Derrick White', 'James Harden', 'Cameron Johnson', 'Jabari Smith Jr.', 'Deni Avdija'] },
      { name: 'Throuple',players: ['Jaylen Brown', 'Jamal Murray', 'Jalen Duren', 'OG Anunoby', 'Brandon Ingram', 'Devin Vassell', 'Ajay Mitchell', 'Luka Doncic'] },
      { name: 'Andrew',  players: ['Jayson Tatum', 'Cade Cunningham', 'Jalen Williams', 'Aaron Gordon', 'Evan Mobley', 'Alperen Sengun', 'Mikal Bridges', 'Dylan Harper'] },
      { name: 'Jared',   players: ['Donovan Mitchell', 'Nikola Jokic', 'Kevin Durant', 'Stephon Castle', 'Payton Pritchard', 'Jalen Johnson', 'Paolo Banchero', 'Julius Randle'] },
      { name: 'Zach',    players: ['Victor Wembanyama', 'Jalen Brunson', 'Chet Holmgren', 'Anthony Edwards', 'Amen Thompson', 'Tobias Harris', 'Tyrese Maxey', 'LeBron James'] },
    ];

    const totals = {};
    OWNERS_LIST.forEach(o => {
      totals[o.name] = o.players.reduce((sum, p) => sum + (data.players[p] || 0), 0);
    });

    // Use date as key (Firebase keys can't have dots or slashes)
    const snapKey = today.replace(/-/g, '');
    await db.ref(`nba26_live/snapshots/${snapKey}`).set({
      date: now,
      totals,
    });

    console.log(`NBA push complete — ${Object.keys(data.players).length} players, snapshot ${snapKey}`);
    return { ok: true, players: Object.keys(data.players).length, snapshot: snapKey, updated: now };
  } catch(e) {
    console.error('Firebase write error:', e.message);
    return { error: e.message };
  }
}

// ── 7am daily cron (ET = UTC-4 in summer, so 11:00 UTC) ──────────
// Runs every day at 11:00 UTC (7:00am ET) during playoffs
cron.schedule('0 11 * * *', async () => {
  console.log('Cron: daily NBA push starting…');
  const result = await pushNBAToFirebase();
  console.log('Cron: NBA push result:', result);
});

// ── WebSocket ─────────────────────────────────────────────────────
const clients = {};
function broadcast(slug, msg) {
  if (!clients[slug]) return;
  const str = JSON.stringify(msg);
  clients[slug].forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(str); });
}

// ── Routes ────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true, service: 'golf', firebaseReady }));

// ── NBA Routes ────────────────────────────────────────────────────

// Debug route — returns raw BBRef HTML snippet so we can check structure
app.get('/nba/debug', async (req, res) => {
  try {
    const { status, body } = await httpsGet(
      'www.basketball-reference.com',
      '/playoffs/NBA_2026_totals.html',
      {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.basketball-reference.com/playoffs/',
      }
    );
    // Return status + first 3000 chars of body so we can see what BBRef is sending
    // Find the totals_stats table and grab a sample row
    const tableStart = body.indexOf('id="totals_stats"');
    const tableSnippet = tableStart >= 0 ? body.slice(tableStart, tableStart + 2000) : 'TABLE NOT FOUND';

    // Find first actual data row (not header)

  } catch(e) {
    res.json({ error: e.message });
  }
});

// Manual trigger: fetch from BBRef and push to Firebase
// POST version (called by nba.html Refresh button)
app.post('/nba/push', async (req, res) => {
  const result = await pushNBAToFirebase();
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

// GET version — open this URL directly in a browser tab to trigger a push
// No CORS issues since it's a direct navigation, not a fetch()
app.get('/nba/push', async (req, res) => {
  const result = await pushNBAToFirebase();
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

// Scrape-only route — tests BBRef fetch without Firebase write
app.get('/nba/scrape-only', async (req, res) => {
  const result = await fetchNBAScores();
  if (result.error) return res.status(502).json(result);
  res.json({
    playerCount: Object.keys(result.players).length,
    sample: Object.entries(result.players).slice(0, 5),
    updated: result.updated
  });
});

// Legacy /all route — kept for backward compatibility
// Now also writes to Firebase if available
app.get('/all', async (req, res) => {
  const data = await fetchNBAScores();
  if (data.error) return res.status(502).json(data);

  // Also push to Firebase silently
  if (firebaseReady) {
    pushNBAToFirebase().catch(e => console.error('Background Firebase push failed:', e.message));
  }

  res.json(data);
});

// ── Golf Routes ───────────────────────────────────────────────────

// Get draft state
app.get('/golf/:slug', (req, res) => {
  if (req.params.slug === 'history') return res.json(Object.values(historyStore).sort((a,b) => b.year - a.year));
  res.json(getOrCreateDraft(req.params.slug));
});

// Commissioner setup
app.post('/golf/:slug/setup', (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  const { name, field, autopickList, owners } = req.body;
  if (name) draft.name = name;
  if (field) draft.field = field;
  if (autopickList) draft.autopickList = autopickList;
  if (owners && owners.length >= 2) {
    draft.owners = owners;
    draft.picks = {};
    owners.forEach(o => { draft.picks[o] = { golfers: [], alternate: null }; });
  }
  draft.pot = draft.owners.length * 25;
  draft.status = 'lobby';
  broadcast(req.params.slug, { type: 'state', draft });
  res.json(draft);
});

app.post('/golf/:slug/start', (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  if (draft.status !== 'lobby') return res.status(400).json({ error: 'Not in lobby' });
  const owners = draft.owners;
  draft.pickOrder = req.body?.pickOrder || shuffle(owners);
  draft.altOrder = req.body?.altOrder || shuffle(owners);
  draft.pickSequence = generatePickSequence(draft.pickOrder);
  draft.altSequence = draft.altOrder.map(o => ({ owner: o, round: 5 }));
  draft.currentPickIndex = 0;
  draft.currentPhase = 'main';
  draft.status = 'drafting';
  draft.timerStart = Date.now();
  broadcast(req.params.slug, { type: 'state', draft });
  res.json(draft);
});

app.post('/golf/:slug/reset', (req, res) => {
  delete drafts[req.params.slug];
  const fresh = getOrCreateDraft(req.params.slug);
  broadcast(req.params.slug, { type: 'state', draft: fresh });
  res.json(fresh);
});

app.post('/golf/:slug/pick', (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  if (draft.status !== 'drafting') return res.status(400).json({ error: 'Not drafting' });
  const { owner, golfer, isAutopick } = req.body;

  draft.undoStack.push({
    field: [...draft.field],
    picks: JSON.parse(JSON.stringify(draft.picks)),
    currentPickIndex: draft.currentPickIndex,
    currentPhase: draft.currentPhase,
    status: draft.status
  });
  draft.redoStack = [];

  draft.field = draft.field.filter(p => p.name !== golfer.name);

  if (draft.currentPhase === 'main') {
    draft.picks[owner].golfers.push({ ...golfer, isAutopick: !!isAutopick });
  } else {
    draft.picks[owner].alternate = { ...golfer, isAutopick: !!isAutopick };
  }

  draft.currentPickIndex++;
  const seq = draft.currentPhase === 'main' ? draft.pickSequence : draft.altSequence;
  if (draft.currentPickIndex >= seq.length) {
    if (draft.currentPhase === 'main') {
      draft.currentPhase = 'alternate';
      draft.currentPickIndex = 0;
    } else {
      draft.status = 'complete';
      draft.locked = true;
    }
  }
  draft.timerStart = Date.now();
  broadcast(req.params.slug, { type: 'state', draft });
  res.json(draft);
});

app.post('/golf/:slug/undo', (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  if (!draft.undoStack.length) return res.status(400).json({ error: 'Nothing to undo' });
  draft.redoStack.push({
    field: [...draft.field],
    picks: JSON.parse(JSON.stringify(draft.picks)),
    currentPickIndex: draft.currentPickIndex,
    currentPhase: draft.currentPhase,
    status: draft.status
  });
  const prev = draft.undoStack.pop();
  Object.assign(draft, prev);
  draft.timerStart = Date.now();
  broadcast(req.params.slug, { type: 'state', draft });
  res.json(draft);
});

app.post('/golf/:slug/redo', (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  if (!draft.redoStack.length) return res.status(400).json({ error: 'Nothing to redo' });
  draft.undoStack.push({
    field: [...draft.field],
    picks: JSON.parse(JSON.stringify(draft.picks)),
    currentPickIndex: draft.currentPickIndex,
    currentPhase: draft.currentPhase,
    status: draft.status
  });
  const next = draft.redoStack.pop();
  Object.assign(draft, next);
  draft.timerStart = Date.now();
  broadcast(req.params.slug, { type: 'state', draft });
  res.json(draft);
});

app.post('/golf/:slug/sub', (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  const { owner, from, to, round } = req.body;
  const cost = round === 1 ? 5 : 15;
  draft.subs.push({ owner, from, to, round, cost, ts: new Date().toISOString() });
  draft.pot += cost;
  broadcast(req.params.slug, { type: 'state', draft });
  res.json(draft);
});

const ODDS_API_KEY = 'cfabbf2a7a75831719d5b9e0938b6b4b';

async function fetchGolfOdds() {
  try {
    const { status, body } = await httpsGet(
      'api.the-odds-api.com',
      `/v4/sports/golf_pga/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=outrights&bookmakers=draftkings,fanduel`,
      { 'Accept': 'application/json' }
    );
    if (status === 404) return { error: 'No active golf event found on Odds API — try closer to tournament week' };
    if (status === 401) return { error: 'Invalid Odds API key' };
    if (status !== 200) return { error: `Odds API returned ${status}: ${body.slice(0,100)}` };
    const data = JSON.parse(body);
    if (!data.length) return { error: 'No golf odds available right now — try again closer to tournament week' };
    const odds = {};
    (data || []).forEach(event => {
      (event.bookmakers || []).forEach(bm => {
        const key = bm.key;
        (bm.markets || []).forEach(market => {
          (market.outcomes || []).forEach(outcome => {
            const name = outcome.name;
            const price = outcome.price;
            if (!odds[name]) odds[name] = {};
            if (key === 'draftkings') odds[name].dk = price > 0 ? `+${price}` : `${price}`;
            if (key === 'fanduel') odds[name].fd = price > 0 ? `+${price}` : `${price}`;
          });
        });
      });
    });
    return { odds, updated: new Date().toISOString() };
  } catch(e) {
    return { error: e.message };
  }
}

app.post('/golf/:slug/odds', async (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  const result = await fetchGolfOdds();
  if (result.error) return res.status(502).json(result);

  const matched = [], unmatched = [];
  const availableOdds = Object.entries(result.odds).map(([name, o]) => ({ name, dk: o.dk, fd: o.fd }))
    .sort((a,b) => a.name.localeCompare(b.name));

  draft.oddsCache = result.odds;
  draft.field = draft.field.map(p => {
    const exact = result.odds[p.name];
    if (exact) { matched.push(p.name); return { ...p, odds_dk: exact.dk, odds_fd: exact.fd }; }
    const lastName = p.name.split(' ').pop().toLowerCase();
    const matchKey = Object.keys(result.odds).find(k => k.split(' ').pop().toLowerCase() === lastName);
    if (matchKey) { matched.push(p.name); return { ...p, odds_dk: result.odds[matchKey].dk, odds_fd: result.odds[matchKey].fd }; }
    unmatched.push({ name: p.name });
    return p;
  });

  broadcast(req.params.slug, { type: 'state', draft });
  res.json({ matched: matched.length, unmatched, availableOdds, updated: result.updated });
});

app.post('/golf/:slug/odds/manual', (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  const { fieldName, oddsName } = req.body;
  if (!draft.oddsCache) return res.status(400).json({ error: 'No odds cache' });
  const odds = draft.oddsCache[oddsName];
  if (!odds) return res.status(404).json({ error: 'Odds not found for: ' + oddsName });
  draft.field = draft.field.map(p => p.name === fieldName ? { ...p, odds_dk: odds.dk, odds_fd: odds.fd } : p);
  broadcast(req.params.slug, { type: 'state', draft });
  res.json({ ok: true });
});

app.get('/golf/:slug/scores', async (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  if (!draft.espnEventId) return res.status(400).json({ error: 'No ESPN event ID configured' });
  const scores = await fetchGolfScores(draft.espnEventId);
  res.json(scores);
});

app.post('/golf/:slug/eventid', (req, res) => {
  const draft = getOrCreateDraft(req.params.slug);
  draft.espnEventId = req.body.eventId;
  broadcast(req.params.slug, { type: 'state', draft });
  res.json({ ok: true });
});

app.get('/history', (req, res) => res.json(Object.values(historyStore).sort((a,b) => b.year - a.year)));
app.post('/history', (req, res) => {
  const entry = req.body;
  historyStore[entry.slug] = entry;
  res.json({ ok: true });
});

// ── Server + WebSocket ────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  const slug = new URL(req.url, 'http://localhost').searchParams.get('slug');
  if (!slug) return ws.close();
  if (!clients[slug]) clients[slug] = new Set();
  clients[slug].add(ws);
  const draft = getOrCreateDraft(slug);
  ws.send(JSON.stringify({ type: 'state', draft }));
  ws.on('close', () => clients[slug].delete(ws));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Golf server running on port ${PORT}`));
