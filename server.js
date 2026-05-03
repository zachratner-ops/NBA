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
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Firebase Admin ────────────────────────────────────────────────
let firebaseReady = false;
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
    databaseURL: 'https://giesener-bets-default-rtdb.firebaseio.com',
  });
  firebaseReady = true;
  console.log('Firebase Admin initialized');
} catch (e) {
  console.error('Firebase Admin init failed:', e.message);
}

// ── HTTP helper ───────────────────────────────────────────────────
function httpsGet(hostname, path, headers, timeoutMs) {
  timeoutMs = timeoutMs || 15000;
  return new Promise(function(resolve, reject) {
    const req = https.request({ hostname: hostname, path: path, method: 'GET', headers: headers }, function(r) {
      let body = '';
      r.on('data', function(chunk) { body += chunk; });
      r.on('end', function() { resolve({ status: r.statusCode, body: body }); });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, function() {
      req.destroy();
      reject(new Error('Request to ' + hostname + ' timed out after ' + timeoutMs + 'ms'));
    });
    req.end();
  });
}

// ── Name normalizer ──────────────────────────────────────────────
// Strips diacritics so BBRef's "Nikola Jokić" matches our "Nikola Jokic"
// and sanitizes Firebase key-illegal characters
function normalizeName(name) {
  return name
    .normalize('NFD')                    // decompose accents
    .replace(/[̀-ͯ]/g, '')     // strip combining diacritics
    .replace(/\./g, '_')                 // dots -> underscore (Jr. etc)
    .replace(/[#$\/\[\]]/g, '_');        // other Firebase-illegal chars
}

// ── BallDontLie API ──────────────────────────────────────────────
const BDLK = 'a99fff51-9e0a-408a-a5d3-88b53588c599';

function fetchBDL(path) {
  return httpsGet('api.balldontlie.io', path, {
    'Authorization': BDLK,
    'Accept': 'application/json'
  });
}

// ── Series standings from BallDontLie ────────────────────────────
async function getSeriesStandings() {
  try {
    const result = await fetchBDL('/nba/v1/games?seasons[]=2025&postseason=true&per_page=100');
    if (result.status !== 200) throw new Error('BDL games returned ' + result.status);
    const data = JSON.parse(result.body);
    const games = data.data || [];

    // Today's date in ET (UTC-4 during EDT)
    const nowET = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const todayET = nowET.toISOString().slice(0, 10);
    const playingToday = new Set();

    const matchups = {};
    games.forEach(function(g) {
      // Collect teams playing today (not yet final)
      const gameDate = (g.date || '').slice(0, 10);
      if (gameDate === todayET && g.status !== 'Final') {
        playingToday.add(g.home_team.abbreviation);
        playingToday.add(g.visitor_team.abbreviation);
      }
      if (g.status !== 'Final') return;
      const home = g.home_team.abbreviation;
      const away = g.visitor_team.abbreviation;
      const key = [home, away].sort().join('-');
      if (!matchups[key]) matchups[key] = {};
      matchups[key][home] = (matchups[key][home] || 0);
      matchups[key][away] = (matchups[key][away] || 0);
      if (g.home_team_score > g.visitor_team_score) {
        matchups[key][home]++;
      } else {
        matchups[key][away]++;
      }
    });

    const standings = {};
    const winsMap = {};
    const eliminated = new Set();
    Object.values(matchups).forEach(function(m) {
      const teams = Object.keys(m);
      const t1 = teams[0], t2 = teams[1];
      const lead = m[t1] - m[t2];
      standings[t1] = lead;
      standings[t2] = -lead;
      winsMap[t1] = { w: m[t1], l: m[t2] };
      winsMap[t2] = { w: m[t2], l: m[t1] };
      if (m[t1] === 4) eliminated.add(t2);
      if (m[t2] === 4) eliminated.add(t1);
    });

    return { standings: standings, winsMap: winsMap, eliminated: [...eliminated], playingToday: [...playingToday] };
  } catch(e) {
    console.error('getSeriesStandings error:', e.message);
    return { standings: {}, winsMap: {}, eliminated: [] };
  }
}

// ── Golf state ────────────────────────────────────────────────────
const drafts = {};
const historyStore = {};
const GOLF_OWNERS = ['Mark','Marc','Jared','Andrew','Zach','Ben','Matt'];

function getOrCreateDraft(slug) {
  if (!drafts[slug]) {
    drafts[slug] = {
      slug: slug, name: '', status: 'setup',
      field: [], autopickList: [],
      owners: GOLF_OWNERS,
      pickOrder: [], altOrder: [],
      pickSequence: [], altSequence: [],
      picks: {}, currentPickIndex: 0,
      currentPhase: 'main',
      subs: [], pot: 25 * 7,
      timerStart: null, timerDuration: 7200,
      locked: false, undoStack: [], redoStack: [],
      espnEventId: null
    };
    GOLF_OWNERS.forEach(function(o) { drafts[slug].picks[o] = { golfers: [], alternate: null }; });
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
    round.forEach(function(o) { seq.push({ owner: o, round: r + 1 }); });
  }
  return seq;
}

// ── ESPN golf scores ──────────────────────────────────────────────
async function fetchGolfScores(eventId) {
  try {
    const result = await httpsGet(
      'site.api.espn.com',
      '/apis/site/v2/sports/golf/pga/leaderboard?event=' + eventId,
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.espn.com/' }
    );
    if (result.status !== 200) return { error: 'ESPN returned ' + result.status };
    const parsed = JSON.parse(result.body);
    const players = {};
    const competitors = (parsed && parsed.events && parsed.events[0] && parsed.events[0].competitions && parsed.events[0].competitions[0] && parsed.events[0].competitions[0].competitors) || [];
    competitors.forEach(function(c) {
      const name = c.athlete && c.athlete.displayName;
      const statusName = (c.status && c.status.type && c.status.type.name) || '';
      const linescores = c.linescores || [];
      let toPar = 0;
      linescores.forEach(function(ls) { toPar += (ls.value || 0); });
      const displayScore = toPar === 0 ? 'E' : (toPar > 0 ? '+' + toPar : '' + toPar);
      if (name) players[name] = { score: toPar, display: displayScore, cut: statusName.includes('CUT') || statusName.includes('WD'), status: statusName };
    });
    return { players: players, updated: new Date().toISOString() };
  } catch(e) {
    return { error: e.message };
  }
}

// ── NBA BBRef scraper ─────────────────────────────────────────────
async function fetchNBAScores() {
  try {
    const result = await httpsGet(
      'www.basketball-reference.com',
      '/playoffs/NBA_2026_totals.html',
      {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.basketball-reference.com/playoffs/',
      }
    );

    if (result.status !== 200) return { error: 'BBRef returned ' + result.status };

    const body = result.body;
    const players = {};

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
      const mappedName = mapPlayerName(name);
      if (!players[mappedName] || pts > players[mappedName]) players[mappedName] = pts;
    }

    console.log('BBRef scrape: found ' + Object.keys(players).length + ' players');
    if (Object.keys(players).length === 0) console.log('BBRef body preview:', body.slice(0, 300));

    return { players: players, eliminated: [], injured: [], seriesStandings: {}, seriesWins: {}, updated: new Date().toISOString() };
  } catch(e) {
    console.error('fetchNBAScores error:', e.message);
    return { error: e.message };
  }
}

// ── NBA name map — BBRef spelling -> our canonical name ──────────
// Add entries here whenever BBRef uses a different spelling
const NBA_NAME_MAP = {
  'Jabari Smith':      'Jabari Smith Jr.',
  'Jabari Smith Jr.':  'Jabari Smith Jr.',
};

function mapPlayerName(bbrefName) {
  return NBA_NAME_MAP[bbrefName] || bbrefName;
}

// ── NBA owners for snapshot totals ────────────────────────────────
const NBA_OWNERS = [
  { name: 'Max',     players: ['Shai Gilgeous-Alexander', "De'Aaron Fox", 'Karl-Anthony Towns', 'Derrick White', 'James Harden', 'Cameron Johnson', 'Jabari Smith Jr.', 'Deni Avdija'] },
  { name: 'Throuple',players: ['Jaylen Brown', 'Jamal Murray', 'Jalen Duren', 'OG Anunoby', 'Brandon Ingram', 'Devin Vassell', 'Ajay Mitchell', 'Luka Doncic'] },
  { name: 'Andrew',  players: ['Jayson Tatum', 'Cade Cunningham', 'Jalen Williams', 'Aaron Gordon', 'Evan Mobley', 'Alperen Sengun', 'Mikal Bridges', 'Dylan Harper'] },
  { name: 'Jared',   players: ['Donovan Mitchell', 'Nikola Jokic', 'Kevin Durant', 'Stephon Castle', 'Payton Pritchard', 'Jalen Johnson', 'Paolo Banchero', 'Julius Randle'] },
  { name: 'Zach',    players: ['Victor Wembanyama', 'Jalen Brunson', 'Chet Holmgren', 'Anthony Edwards', 'Amen Thompson', 'Tobias Harris', 'Tyrese Maxey', 'LeBron James'] },
];

// ── GroupMe bot ──────────────────────────────────────────────────
const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID || 'af8ec9a284c08aa0c9d0c2e231';
const GROUPME_DRY_RUN = process.env.GROUPME_DRY_RUN === 'true';

async function postGroupMe(totals, botId) {
  botId = botId || GROUPME_BOT_ID;
  const ranked = Object.entries(totals)
    .sort(function(a, b) { return b[1] - a[1]; });
  const leader = ranked[0][1];
  const medals = ['🏆','2️⃣ ','3️⃣ ','4️⃣ ','5️⃣ '];
  const lines = ranked.map(function(entry, i) {
    const name = entry[0], pts = entry[1];
    const behind = i === 0 ? 'leading' : '-' + (leader - pts) + ' pts';
    return medals[i] + ' ' + name + ' — ' + pts.toLocaleString() + ' pts  (' + behind + ')';
  });
  const now = new Date();
  const dateStr = (now.getMonth()+1) + '/' + now.getDate();
  const msg = [
    '🏀 Playoff Standings — ' + dateStr,
    '',
    ...lines,
    '',
    '💰 $250 pot · Winner takes all',
    '',
    '🔗 📊 gyou.in/nba.html',
  ].join('\n');

  if (GROUPME_DRY_RUN || !GROUPME_BOT_ID) {
    console.log('[GroupMe DRY RUN] Would post:\n' + msg);
    return;
  }
  try {
    const body = JSON.stringify({ bot_id: botId, text: msg });
    await new Promise(function(resolve, reject) {
      const req = https.request({
        hostname: 'api.groupme.com',
        path: '/v3/bots/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, function(r) {
        r.resume();
        r.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log('GroupMe post sent OK');
  } catch(e) {
    console.error('GroupMe post failed:', e.message);
  }
}

// ── NBA injury scraper ───────────────────────────────────────────
async function fetchNBAInjuries() {
  try {
    const result = await httpsGet(
      'www.basketball-reference.com',
      '/friv/injuries.fcgi',
      {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Referer': 'https://www.basketball-reference.com/',
      }
    );
    if (result.status !== 200) return {};
    const body = result.body;
    const injuredMap = {};
    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let m;
    while ((m = trRegex.exec(body)) !== null) {
      const row = m[1];
      const nameMatch = row.match(/data-stat="player"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
      const noteMatch = row.match(/data-stat="note"[^>]*>([^<]+)<\/td>/);
      if (nameMatch && noteMatch && noteMatch[1].trim().length > 0) {
        const name = normalizeName(nameMatch[1].trim());
        injuredMap[name] = noteMatch[1].trim();
      }
    }
    console.log('Injuries found: ' + Object.keys(injuredMap).length);
    return injuredMap;
  } catch(e) {
    console.error('fetchNBAInjuries error:', e.message);
    return [];
  }
}

// ── Push NBA scores to Firebase ───────────────────────────────────
async function pushNBAToFirebase() {
  if (!firebaseReady) return { error: 'Firebase not initialized' };
  console.log('Fetching NBA scores, injuries, and series standings...');
  const [scoreData, injuredList, seriesResult] = await Promise.all([
    fetchNBAScores(),
    fetchNBAInjuries(),
    getSeriesStandings(),
  ]);
  if (scoreData.error) return scoreData;
  try {
    const db = admin.database();
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    // Normalize names: strip accents + sanitize Firebase-illegal chars
    // e.g. "Nikola Jokić" -> "Nikola Jokic", "Jabari Smith Jr." -> "Jabari Smith Jr_"
    const sanitizedPlayers = {};
    Object.keys(scoreData.players).forEach(function(name) {
      const safeKey = normalizeName(name);
      sanitizedPlayers[safeKey] = scoreData.players[name];
    });

    await db.ref('nba26_live/scores').set({
      players: sanitizedPlayers,
      eliminated: seriesResult.eliminated || [],
      injuredMap: injuredList || {},
      seriesStandings: seriesResult.standings || {},
      seriesWins: seriesResult.winsMap || {},
      playingToday: seriesResult.playingToday || [],
      updated: now,
    });
    const totals = {};
    NBA_OWNERS.forEach(function(o) {
      totals[o.name] = o.players.reduce(function(sum, p) {
        // Look up using sanitized key to match what we wrote to Firebase
        const safeP = normalizeName(p);
        return sum + (sanitizedPlayers[safeP] || 0);
      }, 0);
    });
    const snapKey = today.replace(/-/g, '');
    await db.ref('nba26_live/snapshots/' + snapKey).set({ date: now, totals: totals });
    const playerCount = Object.keys(scoreData.players).length;
    console.log('NBA push complete — ' + playerCount + ' players, snapshot ' + snapKey);

    return { ok: true, players: playerCount, snapshot: snapKey, updated: now };
  } catch(e) {
    console.error('Firebase write error:', e.message);
    return { error: e.message };
  }
}

// ── 7am ET daily cron (11:00 UTC) ────────────────────────────────
cron.schedule('0 16 * * *', async function() {
  console.log('Cron: daily NBA push starting...');
  const result = await pushNBAToFirebase();
  console.log('Cron: NBA push result:', result);
});

// ── WebSocket ─────────────────────────────────────────────────────
const clients = {};
function broadcast(slug, msg) {
  if (!clients[slug]) return;
  const str = JSON.stringify(msg);
  clients[slug].forEach(function(ws) { if (ws.readyState === WebSocket.OPEN) ws.send(str); });
}

// ══════════════════════════════════════════════════════════════════
// ROUTES — all functions defined above before any routes
// ══════════════════════════════════════════════════════════════════

app.get('/health', function(req, res) { res.json({ ok: true, service: 'golf', firebaseReady: firebaseReady }); });

// NBA: scrape only, no Firebase
app.get('/nba/scrape-only', async function(req, res) {
  const result = await fetchNBAScores();
  if (result.error) return res.status(502).json(result);
  res.json({ playerCount: Object.keys(result.players).length, sample: Object.entries(result.players).slice(0, 10), updated: result.updated });
});

// NBA: debug raw BBRef
app.get('/nba/debug', async function(req, res) {
  try {
    const r = await httpsGet('www.basketball-reference.com', '/playoffs/NBA_2026_totals.html', {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Referer': 'https://www.basketball-reference.com/playoffs/',
    });
    const body = r.body;
    let sampleRow = 'none found';
    const rows = body.split('<tr');
    for (const row of rows) {
      if (row.includes('data-stat="player"') && row.includes('data-stat="pts"') && !row.includes('>Player<')) {
        sampleRow = row.slice(0, 1200);
        break;
      }
    }
    res.json({ status: r.status, bodyLength: body.length, hasPlayerStat: body.includes('data-stat="player"'), hasPtsStat: body.includes('data-stat="pts"'), hasFullTable: body.includes('class="full_table"'), sampleRow: sampleRow });
  } catch(e) { res.json({ error: e.message }); }
});

// NBA: push to Firebase — GET works from browser tab directly
app.get('/nba/push', async function(req, res) {
  const result = await pushNBAToFirebase();
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

app.post('/nba/push', async function(req, res) {
  const result = await pushNBAToFirebase();
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

// NBA: refresh live scores only — NO snapshot written (manual refresh from frontend)
app.get('/nba/refresh-only', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  const [scoreData, injuredList, seriesResult] = await Promise.all([
    fetchNBAScores(),
    fetchNBAInjuries(),
    getSeriesStandings(),
  ]);
  if (scoreData.error) return res.status(502).json(scoreData);
  try {
    const db = admin.database();
    const now = new Date().toISOString();
    const sanitizedPlayers = {};
    Object.keys(scoreData.players).forEach(function(name) {
      sanitizedPlayers[normalizeName(name)] = scoreData.players[name];
    });
    await db.ref('nba26_live/scores').set({
      players: sanitizedPlayers,
      eliminated: seriesResult.eliminated || [],
      injuredMap: injuredList || {},
      seriesStandings: seriesResult.standings || {},
      seriesWins: seriesResult.winsMap || {},
      playingToday: seriesResult.playingToday || [],
      updated: now,
    });
    // No snapshot write — chart data stays cron-only
    console.log('NBA refresh-only complete — ' + Object.keys(scoreData.players).length + ' players');
    res.json({ ok: true, players: Object.keys(scoreData.players).length, updated: now });
  } catch(e) {
    console.error('Firebase refresh-only error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// NBA: post standings to GroupMe on demand (commissioner button)
app.post('/nba/groupme', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  try {
    const db = admin.database();
    const snap = await db.ref('nba26_live/scores').get();

    if (!snap.exists()) return res.status(404).json({ error: 'No score data in Firebase yet' });
    const data = snap.val();
    const sanitizedPlayers = data.players || {};
    if (Object.keys(sanitizedPlayers).length === 0) return res.status(400).json({ error: 'Score data is empty — run a scrape first' });
    const totals = {};
    NBA_OWNERS.forEach(function(o) {
      totals[o.name] = o.players.reduce(function(sum, p) {
        return sum + (sanitizedPlayers[normalizeName(p)] || 0);
      }, 0);
    });
    const botId = req.body && req.body.botId ? req.body.botId : GROUPME_BOT_ID;
    await postGroupMe(totals, botId);
    res.json({ ok: true, totals: totals, botId: botId });
  } catch(e) {
    console.error('On-demand GroupMe error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// Legacy
app.get('/all', async function(req, res) {
  const scoreData = await fetchNBAScores();
  if (scoreData.error) return res.status(502).json(scoreData);
  if (firebaseReady) pushNBAToFirebase().catch(function(e) { console.error('Background push failed:', e.message); });
  res.json(scoreData);
});

// Golf routes
app.get('/golf/:slug', function(req, res) {
  if (req.params.slug === 'history') return res.json(Object.values(historyStore).sort(function(a,b) { return b.year - a.year; }));
  res.json(getOrCreateDraft(req.params.slug));
});

app.post('/golf/:slug/setup', function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  const { name, field, autopickList, owners } = req.body;
  if (name) draft.name = name;
  if (field) draft.field = field;
  if (autopickList) draft.autopickList = autopickList;
  if (owners && owners.length >= 2) {
    draft.owners = owners;
    draft.picks = {};
    owners.forEach(function(o) { draft.picks[o] = { golfers: [], alternate: null }; });
  }
  draft.pot = draft.owners.length * 25;
  draft.status = 'lobby';
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/golf/:slug/start', function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  if (draft.status !== 'lobby') return res.status(400).json({ error: 'Not in lobby' });
  const owners = draft.owners;
  draft.pickOrder = (req.body && req.body.pickOrder) || shuffle(owners);
  draft.altOrder = (req.body && req.body.altOrder) || shuffle(owners);
  draft.pickSequence = generatePickSequence(draft.pickOrder);
  draft.altSequence = draft.altOrder.map(function(o) { return { owner: o, round: 5 }; });
  draft.currentPickIndex = 0;
  draft.currentPhase = 'main';
  draft.status = 'drafting';
  draft.timerStart = Date.now();
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/golf/:slug/reset', function(req, res) {
  delete drafts[req.params.slug];
  const fresh = getOrCreateDraft(req.params.slug);
  broadcast(req.params.slug, { type: 'state', draft: fresh });
  res.json(fresh);
});

app.post('/golf/:slug/pick', function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  if (draft.status !== 'drafting') return res.status(400).json({ error: 'Not drafting' });
  const { owner, golfer, isAutopick } = req.body;
  draft.undoStack.push({ field: [...draft.field], picks: JSON.parse(JSON.stringify(draft.picks)), currentPickIndex: draft.currentPickIndex, currentPhase: draft.currentPhase, status: draft.status });
  draft.redoStack = [];
  draft.field = draft.field.filter(function(p) { return p.name !== golfer.name; });
  if (draft.currentPhase === 'main') {
    draft.picks[owner].golfers.push({ ...golfer, isAutopick: !!isAutopick });
  } else {
    draft.picks[owner].alternate = { ...golfer, isAutopick: !!isAutopick };
  }
  draft.currentPickIndex++;
  const seq = draft.currentPhase === 'main' ? draft.pickSequence : draft.altSequence;
  if (draft.currentPickIndex >= seq.length) {
    if (draft.currentPhase === 'main') { draft.currentPhase = 'alternate'; draft.currentPickIndex = 0; }
    else { draft.status = 'complete'; draft.locked = true; }
  }
  draft.timerStart = Date.now();
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/golf/:slug/undo', function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  if (!draft.undoStack.length) return res.status(400).json({ error: 'Nothing to undo' });
  draft.redoStack.push({ field: [...draft.field], picks: JSON.parse(JSON.stringify(draft.picks)), currentPickIndex: draft.currentPickIndex, currentPhase: draft.currentPhase, status: draft.status });
  const prev = draft.undoStack.pop();
  Object.assign(draft, prev);
  draft.timerStart = Date.now();
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/golf/:slug/redo', function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  if (!draft.redoStack.length) return res.status(400).json({ error: 'Nothing to redo' });
  draft.undoStack.push({ field: [...draft.field], picks: JSON.parse(JSON.stringify(draft.picks)), currentPickIndex: draft.currentPickIndex, currentPhase: draft.currentPhase, status: draft.status });
  const next = draft.redoStack.pop();
  Object.assign(draft, next);
  draft.timerStart = Date.now();
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/golf/:slug/sub', function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  const { owner, from, to, round } = req.body;
  const cost = round === 1 ? 5 : 15;
  draft.subs.push({ owner: owner, from: from, to: to, round: round, cost: cost, ts: new Date().toISOString() });
  draft.pot += cost;
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

const ODDS_API_KEY = 'cfabbf2a7a75831719d5b9e0938b6b4b';

async function fetchGolfOdds() {
  try {
    const r = await httpsGet('api.the-odds-api.com', '/v4/sports/golf_pga/odds?apiKey=' + ODDS_API_KEY + '&regions=us&markets=outrights&bookmakers=draftkings,fanduel', { 'Accept': 'application/json' });
    if (r.status === 404) return { error: 'No active golf event found' };
    if (r.status === 401) return { error: 'Invalid Odds API key' };
    if (r.status !== 200) return { error: 'Odds API returned ' + r.status };
    const parsed = JSON.parse(r.body);
    if (!parsed.length) return { error: 'No golf odds available right now' };
    const odds = {};
    parsed.forEach(function(event) {
      (event.bookmakers || []).forEach(function(bm) {
        (bm.markets || []).forEach(function(market) {
          (market.outcomes || []).forEach(function(outcome) {
            if (!odds[outcome.name]) odds[outcome.name] = {};
            if (bm.key === 'draftkings') odds[outcome.name].dk = outcome.price > 0 ? '+' + outcome.price : '' + outcome.price;
            if (bm.key === 'fanduel')    odds[outcome.name].fd = outcome.price > 0 ? '+' + outcome.price : '' + outcome.price;
          });
        });
      });
    });
    return { odds: odds, updated: new Date().toISOString() };
  } catch(e) { return { error: e.message }; }
}

app.post('/golf/:slug/odds', async function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  const result = await fetchGolfOdds();
  if (result.error) return res.status(502).json(result);
  const matched = [], unmatched = [];
  draft.oddsCache = result.odds;
  draft.field = draft.field.map(function(p) {
    const exact = result.odds[p.name];
    if (exact) { matched.push(p.name); return Object.assign({}, p, { odds_dk: exact.dk, odds_fd: exact.fd }); }
    const lastName = p.name.split(' ').pop().toLowerCase();
    const matchKey = Object.keys(result.odds).find(function(k) { return k.split(' ').pop().toLowerCase() === lastName; });
    if (matchKey) { matched.push(p.name); return Object.assign({}, p, { odds_dk: result.odds[matchKey].dk, odds_fd: result.odds[matchKey].fd }); }
    unmatched.push({ name: p.name });
    return p;
  });
  broadcast(req.params.slug, { type: 'state', draft: draft });
  const availableOdds = Object.entries(result.odds).map(function(e) { return { name: e[0], dk: e[1].dk, fd: e[1].fd }; }).sort(function(a,b) { return a.name.localeCompare(b.name); });
  res.json({ matched: matched.length, unmatched: unmatched, availableOdds: availableOdds, updated: result.updated });
});

app.post('/golf/:slug/odds/manual', function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  const { fieldName, oddsName } = req.body;
  if (!draft.oddsCache) return res.status(400).json({ error: 'No odds cache' });
  const odds = draft.oddsCache[oddsName];
  if (!odds) return res.status(404).json({ error: 'Odds not found for: ' + oddsName });
  draft.field = draft.field.map(function(p) { return p.name === fieldName ? Object.assign({}, p, { odds_dk: odds.dk, odds_fd: odds.fd }) : p; });
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json({ ok: true });
});

app.get('/golf/:slug/scores', async function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  if (!draft.espnEventId) return res.status(400).json({ error: 'No ESPN event ID configured' });
  const scores = await fetchGolfScores(draft.espnEventId);
  res.json(scores);
});

app.post('/golf/:slug/eventid', function(req, res) {
  const draft = getOrCreateDraft(req.params.slug);
  draft.espnEventId = req.body.eventId;
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json({ ok: true });
});

app.get('/history', function(req, res) { res.json(Object.values(historyStore).sort(function(a,b) { return b.year - a.year; })); });
app.post('/history', function(req, res) { historyStore[req.body.slug] = req.body; res.json({ ok: true }); });

// ── Server + WebSocket ────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server: server });

wss.on('connection', function(ws, req) {
  const slug = new URL(req.url, 'http://localhost').searchParams.get('slug');
  if (!slug) return ws.close();
  if (!clients[slug]) clients[slug] = new Set();
  clients[slug].add(ws);
  const draft = getOrCreateDraft(slug);
  ws.send(JSON.stringify({ type: 'state', draft: draft }));
  ws.on('close', function() { clients[slug].delete(ws); });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() { console.log('Golf server running on port ' + PORT); });
