const express = require('express');
const https = require('https');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const admin = require('firebase-admin');
const cron = require('node-cron');
const app = express();

app.use(express.json());
app.use(express.static('.'));

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

// ── Read round start config from Firebase ────────────────────────
async function getRoundStart() {
  if (!firebaseReady) return null;
  try {
    const snap = await admin.database().ref('nba26_live/config/roundStart').get();
    return snap.exists() ? snap.val() : null;
  } catch(e) { return null; }
}

// ── Series standings from BallDontLie ────────────────────────────
async function getSeriesStandings(roundStart) {
  try {
    const result = await fetchBDL('/nba/v1/games?seasons[]=2025&postseason=true&per_page=100');
    if (result.status !== 200) throw new Error('BDL games returned ' + result.status);
    const data = JSON.parse(result.body);
    let games = data.data || [];

    // Filter to only games on or after the current round start date (set by commissioner)
    if (roundStart) {
      games = games.filter(function(g) { return (g.date || '').slice(0, 10) >= roundStart; });
      console.log('Round start filter ' + roundStart + ': ' + games.length + ' games');
    }

    // Today's date in ET (UTC-4 during EDT)
    const nowET = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const todayET = nowET.toISOString().slice(0, 10);
    const playingToday = new Set();

    // Sort chronologically so we can detect when teams switch to a new round matchup
    games.sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });

    // Track which matchup key each team most recently appeared in.
    // When a team shows up in a new pairing (new round), we drop the old one.
    const teamToKey = {};
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

      // If either team has moved to a new matchup (new round), clear the old one
      [home, away].forEach(function(team) {
        const prevKey = teamToKey[team];
        if (prevKey && prevKey !== key) {
          delete matchups[prevKey];
        }
        teamToKey[team] = key;
      });

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
  const roundStart = await getRoundStart();
  const [scoreData, injuredList, seriesResult] = await Promise.all([
    fetchNBAScores(),
    fetchNBAInjuries(),
    getSeriesStandings(roundStart),
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

    // Merge eliminated — never remove a team once knocked out
    const existingElimSnap = await db.ref('nba26_live/scores/eliminated').get();
    const existingElimList = existingElimSnap.exists() ? (existingElimSnap.val() || []) : [];
    const mergedElimList = [...new Set([...existingElimList, ...(seriesResult.eliminated || [])])];

    await db.ref('nba26_live/scores').set({
      players: sanitizedPlayers,
      eliminated: mergedElimList,
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
cron.schedule('0 14 * * *', async function() {
  console.log('Cron: daily NBA push starting...');
  const result = await pushNBAToFirebase();
  console.log('Cron: NBA push result:', result);
});

// ── 9am ET daily WC cron (13:00 UTC) — runs Jun 11 – Jul 19 only ──
cron.schedule('0 13 * * *', async function() {
  const todayET = new Date(Date.now() - 4 * 3600000).toISOString().slice(0, 10);
  if (todayET < '2026-06-11' || todayET > '2026-07-19') return;
  console.log('Cron: WC daily GroupMe starting...');
  const result = await postWCDailyGroupMe();
  console.log('Cron: WC daily GroupMe result:', result);
});

// ── WC live score refresh — every 5 min, 14:00-04:00 UTC, Jun 11–Jul 19 ──
// Covers game windows across all WC 2026 host cities (ET noon to midnight+)
cron.schedule('*/5 14-23,0-4 * * *', async function() {
  const todayET = new Date(Date.now() - 4 * 3600000).toISOString().slice(0, 10);
  if (todayET < '2026-06-11' || todayET > '2026-07-19') return;
  if (!firebaseReady) return;
  const result = await pushWCMatchesToFirebase();
  if (result.ok) console.log('WC live cron: ' + result.matchCount + ' matches synced');
  else if (result.error) console.error('WC live cron error:', result.error);
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
  const roundStart = await getRoundStart();
  const [scoreData, injuredList, seriesResult] = await Promise.all([
    fetchNBAScores(),
    fetchNBAInjuries(),
    getSeriesStandings(roundStart),
  ]);
  if (scoreData.error) return res.status(502).json(scoreData);
  try {
    const db = admin.database();
    const now = new Date().toISOString();
    const sanitizedPlayers = {};
    Object.keys(scoreData.players).forEach(function(name) {
      sanitizedPlayers[normalizeName(name)] = scoreData.players[name];
    });
    // Merge eliminated — never remove a team once they've been knocked out
    const existingSnap = await db.ref('nba26_live/scores/eliminated').get();
    const existingElim = existingSnap.exists() ? (existingSnap.val() || []) : [];
    const mergedElim = [...new Set([...existingElim, ...(seriesResult.eliminated || [])])];

    await db.ref('nba26_live/scores').set({
      players: sanitizedPlayers,
      eliminated: mergedElim,
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

// NBA: set/get round start date (commissioner only)
app.post('/nba/config/round-start', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  const { date } = req.body;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date — use YYYY-MM-DD' });
  try {
    await admin.database().ref('nba26_live/config/roundStart').set(date);
    console.log('Round start set to:', date);
    res.json({ ok: true, roundStart: date });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/nba/config', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  try {
    const snap = await admin.database().ref('nba26_live/config').get();
    res.json(snap.exists() ? snap.val() : {});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// NBA: reset series scores — wipes seriesStandings, seriesWins, eliminated (commissioner only)
app.post('/nba/reset-series', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  try {
    const db = admin.database();
    await db.ref('nba26_live/scores').update({
      seriesStandings: {},
      seriesWins: {},
      playingToday: [],
      // eliminated intentionally preserved — knocked-out teams stay grayed out
    });
    console.log('NBA series reset by commissioner');
    res.json({ ok: true });
  } catch(e) {
    console.error('Series reset error:', e.message);
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


// NBA: save end-of-round snapshot to Firebase (commissioner only, read-only once saved)
app.post('/nba/rounds/:round', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  const round = req.params.round; // e.g. "R1", "R2", "R3"
  if (!['R1','R2','R3','R4'].includes(round)) return res.status(400).json({ error: 'Invalid round — use R1, R2, R3, or R4' });
  try {
    const db = admin.database();
    // Check if already saved — read-only once written
    const existing = await db.ref('nba26_live/rounds/' + round).get();
    if (existing.exists()) {
      return res.status(409).json({ error: round + ' already saved. Round snapshots are read-only once written.' });
    }
    // Read current live scores
    const snap = await db.ref('nba26_live/scores').get();
    if (!snap.exists()) return res.status(404).json({ error: 'No live score data found' });
    const data = snap.val();
    const now = new Date().toISOString();
    await db.ref('nba26_live/rounds/' + round).set({
      players: data.players || {},
      eliminated: data.eliminated || [],
      seriesStandings: data.seriesStandings || {},
      seriesWins: data.seriesWins || {},
      savedAt: now,
      round: round,
    });
    console.log('Round snapshot saved: ' + round + ' at ' + now);
    res.json({ ok: true, round: round, savedAt: now });
  } catch(e) {
    console.error('Save round error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// NBA: get all saved round snapshots
app.get('/nba/rounds', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  try {
    const db = admin.database();
    const snap = await db.ref('nba26_live/rounds').get();
    res.json(snap.exists() ? snap.val() : {});
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// NBA: save final season results to history (commissioner only, read-only once written)
app.post('/nba/save-season/:year', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  const year = parseInt(req.params.year, 10);
  if (isNaN(year) || year < 2018 || year > 2050) return res.status(400).json({ error: 'Invalid year' });
  try {
    const db = admin.database();
    const existing = await db.ref('nba_history/' + year).get();
    if (existing.exists()) {
      return res.status(409).json({ error: year + ' already saved. Season history is read-only once written.' });
    }
    const snap = await db.ref('nba26_live/scores').get();
    if (!snap.exists()) return res.status(404).json({ error: 'No live score data found' });
    const liveData = snap.val();
    const sanitizedPlayers = liveData.players || {};

    const owners = {};
    NBA_OWNERS.forEach(function(o) {
      const playerList = o.players.map(function(p) {
        return { name: p, pts: sanitizedPlayers[normalizeName(p)] || 0 };
      });
      owners[o.name] = {
        score: playerList.reduce(function(sum, p) { return sum + p.pts; }, 0),
        players: playerList,
      };
    });

    const winner = (req.body && req.body.winner)
      ? req.body.winner
      : Object.entries(owners).sort(function(a, b) { return b[1].score - a[1].score; })[0][0];
    const pot = (req.body && req.body.pot) ? Number(req.body.pot) : 250;

    const record = { year: year, pot: pot, winner: winner, savedAt: new Date().toISOString(), owners: owners };
    await db.ref('nba_history/' + year).set(record);
    console.log('Season history saved: ' + year + ', winner: ' + winner);
    res.json({ ok: true, year: year, winner: winner, pot: pot });
  } catch(e) {
    console.error('Save season error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// NBA: read all saved season history from Firebase
app.get('/nba/history', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not initialized' });
  try {
    const snap = await admin.database().ref('nba_history').get();
    res.json(snap.exists() ? snap.val() : {});
  } catch(e) {
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

// ── WC GroupMe draft announcements ───────────────────────────────
const WC_GROUPME_BOT_ID = '8445fbf5c50a56a0be94d9e488';

// Member IDs — combined entries tag both people
const WC_GROUPME_MEMBERS = {
  'Marc':       ['5774512'],
  'Matt':       ['4584150'],
  'Andrew':     ['5774515'],
  'Zach':       ['5774513'],
  'Jared':      ['5774445'],
  'Mike':       ['5774511'],
  'Ben + Mark': ['5774514', '104265229'],
  'Adam + Max': ['5774510', '2921868'],
};

function flagEmojiWC(code) {
  if (!code || code.length !== 2) return '';
  const u = code.toUpperCase();
  return String.fromCodePoint(0x1F1E6 + u.charCodeAt(0) - 65) +
         String.fromCodePoint(0x1F1E6 + u.charCodeAt(1) - 65);
}

async function postWCPickGroupMe(draft, team, pickerOwner, pickIndex) {
  const seq = draft.pickSequence || [];
  const total = seq.length;
  const round = (seq[pickIndex] || {}).round || '?';
  const nextPick = seq[pickIndex + 1];
  const nextOwner = nextPick ? nextPick.owner : null;
  const flag = flagEmojiWC(team.flag || '');
  const mentionTag = nextOwner ? ('@' + nextOwner) : '';

  const lines = [
    '⚽ Pick ' + (pickIndex + 1) + ' of ' + total + ' · Round ' + round,
    '',
    pickerOwner + ' selects ' + team.name + (flag ? ' ' + flag : '') + ' (Group ' + team.group + ')',
    '',
    nextOwner ? ('On the clock: ' + mentionTag) : '🎉 Draft complete!',
  ];
  const text = lines.join('\n');

  const attachments = [];
  if (nextOwner && mentionTag) {
    const ids = WC_GROUPME_MEMBERS[nextOwner] || [];
    if (ids.length > 0) {
      const start = text.indexOf(mentionTag);
      attachments.push({
        type: 'mentions',
        user_ids: ids,
        loci: ids.map(function() { return [start, mentionTag.length]; }),
      });
    }
  }

  const body = JSON.stringify({ bot_id: WC_GROUPME_BOT_ID, text: text, attachments: attachments });
  try {
    await new Promise(function(resolve, reject) {
      const req = https.request({
        hostname: 'api.groupme.com',
        path: '/v3/bots/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, function(r) { r.resume(); r.on('end', resolve); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log('WC GroupMe pick ' + (pickIndex + 1) + ' posted');
  } catch(e) {
    console.error('WC GroupMe post failed:', e.message);
  }
}

// ── World Cup 2026 state ──────────────────────────────────────────
const WC_TEAMS = [
  { name: 'Mexico', group: 'A', flag: 'mx' }, { name: 'South Africa', group: 'A', flag: 'za' }, { name: 'South Korea', group: 'A', flag: 'kr' }, { name: 'Czechia', group: 'A', flag: 'cz' },
  { name: 'Canada', group: 'B', flag: 'ca' }, { name: 'Bosnia-Herzegovina', group: 'B', flag: 'ba' }, { name: 'Qatar', group: 'B', flag: 'qa' }, { name: 'Switzerland', group: 'B', flag: 'ch' },
  { name: 'Brazil', group: 'C', flag: 'br' }, { name: 'Morocco', group: 'C', flag: 'ma' }, { name: 'Haiti', group: 'C', flag: 'ht' }, { name: 'Scotland', group: 'C', flag: 'gb-sct' },
  { name: 'United States', group: 'D', flag: 'us' }, { name: 'Paraguay', group: 'D', flag: 'py' }, { name: 'Australia', group: 'D', flag: 'au' }, { name: 'Türkiye', group: 'D', flag: 'tr' },
  { name: 'Germany', group: 'E', flag: 'de' }, { name: 'Curaçao', group: 'E', flag: 'cw' }, { name: 'Ivory Coast', group: 'E', flag: 'ci' }, { name: 'Ecuador', group: 'E', flag: 'ec' },
  { name: 'Netherlands', group: 'F', flag: 'nl' }, { name: 'Japan', group: 'F', flag: 'jp' }, { name: 'Sweden', group: 'F', flag: 'se' }, { name: 'Tunisia', group: 'F', flag: 'tn' },
  { name: 'Belgium', group: 'G', flag: 'be' }, { name: 'Egypt', group: 'G', flag: 'eg' }, { name: 'Iran', group: 'G', flag: 'ir' }, { name: 'New Zealand', group: 'G', flag: 'nz' },
  { name: 'Spain', group: 'H', flag: 'es' }, { name: 'Cape Verde', group: 'H', flag: 'cv' }, { name: 'Saudi Arabia', group: 'H', flag: 'sa' }, { name: 'Uruguay', group: 'H', flag: 'uy' },
  { name: 'France', group: 'I', flag: 'fr' }, { name: 'Senegal', group: 'I', flag: 'sn' }, { name: 'Iraq', group: 'I', flag: 'iq' }, { name: 'Norway', group: 'I', flag: 'no' },
  { name: 'Argentina', group: 'J', flag: 'ar' }, { name: 'Algeria', group: 'J', flag: 'dz' }, { name: 'Austria', group: 'J', flag: 'at' }, { name: 'Jordan', group: 'J', flag: 'jo' },
  { name: 'Portugal', group: 'K', flag: 'pt' }, { name: 'Congo DR', group: 'K', flag: 'cd' }, { name: 'Uzbekistan', group: 'K', flag: 'uz' }, { name: 'Colombia', group: 'K', flag: 'co' },
  { name: 'England', group: 'L', flag: 'gb-eng' }, { name: 'Croatia', group: 'L', flag: 'hr' }, { name: 'Ghana', group: 'L', flag: 'gh' }, { name: 'Panama', group: 'L', flag: 'pa' }
];

const wcDrafts = {};
const ALL_WC_OWNERS = ['Ben + Mark','Marc','Jared','Andrew','Zach','Adam + Max','Matt','Mike'];

function getOrCreateWCDraft(slug) {
  if (!wcDrafts[slug]) {
    wcDrafts[slug] = {
      slug: slug, name: '', status: 'setup',
      teams: JSON.parse(JSON.stringify(WC_TEAMS)),
      owners: ALL_WC_OWNERS,
      pickOrder: [], pickSequence: [],
      picks: {}, currentPickIndex: 0,
      undoStack: [], redoStack: []
    };
    ALL_WC_OWNERS.forEach(function(o) { wcDrafts[slug].picks[o] = []; });
  }
  return wcDrafts[slug];
}

function generateWCPickSequence(order, numTeams) {
  const seq = [];
  let round = 0;
  while (seq.length < numTeams) {
    const roundOrder = round % 2 === 0 ? [...order] : [...order].reverse();
    for (let i = 0; i < roundOrder.length; i++) {
      if (seq.length >= numTeams) break;
      seq.push({ owner: roundOrder[i], round: round + 1 });
    }
    round++;
  }
  return seq;
}

// ── ESPN World Cup match fetch ─────────────────────────────────────

// ESPN uses official FIFA display names which differ from our internal names
const ESPN_WC_NAME_MAP = {
  'Korea Republic':               'South Korea',
  'Turkey':                       'Türkiye',
  'Bosnia and Herzegovina':       'Bosnia-Herzegovina',
  'Bosnia & Herzegovina':         'Bosnia-Herzegovina',
  "Côte d'Ivoire":                'Ivory Coast',
  "Cote d'Ivoire":                'Ivory Coast',
  'Cabo Verde':                   'Cape Verde',
  'DR Congo':                     'Congo DR',
  'Congo, DR':                    'Congo DR',
  'Democratic Republic of Congo': 'Congo DR',
  'Curacao':                      'Curaçao',
  'Czech Republic':               'Czechia',
  'USA':                          'United States',
  'U.S.A.':                       'United States',
};
function normalizeWCTeamName(name) {
  if (!name) return name;
  return ESPN_WC_NAME_MAP[name] || name;
}

const TEAM_TO_GROUP = {};
WC_TEAMS.forEach(function(t) { TEAM_TO_GROUP[t.name] = t.group; });

function parseESPNEvents(events) {
  const matches = {};
  events.forEach(function(event) {
    const comp = event.competitions && event.competitions[0];
    if (!comp) return;
    const competitors = comp.competitors || [];
    const home = competitors.find(function(c) { return c.homeAway === 'home'; });
    const away = competitors.find(function(c) { return c.homeAway === 'away'; });
    if (!home || !away) return;
    const statusName = (comp.status && comp.status.type && comp.status.type.name) || '';
    const statusDetail = (comp.status && comp.status.type && comp.status.type.detail) || '';
    const isFinal = statusName === 'STATUS_FINAL' || statusName === 'STATUS_FULL_TIME';
    const isLive = statusName === 'STATUS_IN_PROGRESS'
      || statusName === 'STATUS_FIRST_HALF'
      || statusName === 'STATUS_SECOND_HALF'
      || statusName === 'STATUS_HALFTIME'
      || statusName === 'STATUS_END_PERIOD'
      || statusName === 'STATUS_EXTRA_TIME'
      || statusName === 'STATUS_OVERTIME'
      || statusName === 'STATUS_PENALTY';
    let group = null, stage = 'group';
    (comp.notes || []).forEach(function(n) {
      const txt = (n.headline || n.text || '').toLowerCase();
      const gm = txt.match(/group ([a-l])/);
      if (gm) { group = gm[1].toUpperCase(); stage = 'group'; }
      else if (txt.includes('round of 32')) stage = 'r32';
      else if (txt.includes('round of 16')) stage = 'r16';
      else if (txt.includes('quarter')) stage = 'qf';
      else if (txt.includes('semi')) stage = 'sf';
      else if (txt.includes('final')) stage = 'final';
    });
    const detailLower = statusDetail.toLowerCase();
    const espnPK = detailLower.includes('pen') || detailLower.includes('p.k') || detailLower === 'f/p';
    const displayClock = (comp.status && comp.status.displayClock) || null;
    const clockLabel = statusName === 'STATUS_HALFTIME' ? 'HT'
      : (statusName === 'STATUS_END_PERIOD' || statusName === 'STATUS_EXTRA_TIME' || statusName === 'STATUS_OVERTIME') ? 'ET'
      : statusName === 'STATUS_PENALTY' ? 'PK'
      : (isLive && displayClock) ? displayClock
      : null;
    // Normalize ESPN display names to our internal WC team names
    const homeTeamName = normalizeWCTeamName(home.team && home.team.displayName);
    const awayTeamName = normalizeWCTeamName(away.team && away.team.displayName);
    // ESPN notes are empty for scheduled games — derive group from our team list
    if (!group && stage === 'group') {
      group = TEAM_TO_GROUP[homeTeamName] || TEAM_TO_GROUP[awayTeamName] || null;
    }
    // Also detect group from name if still missing
    if (!group) {
      const evtNameLower = (event.name || '').toLowerCase();
      const gm2 = evtNameLower.match(/group ([a-l])/);
      if (gm2) { group = gm2[1].toUpperCase(); stage = 'group'; }
    }
    matches[event.id] = {
      id: event.id,
      date: event.date,
      name: event.name,
      stage: stage,
      group: group,
      homeTeam: homeTeamName,
      awayTeam: awayTeamName,
      homeScore: (isFinal || isLive) ? parseInt(home.score || '0', 10) : null,
      awayScore: (isFinal || isLive) ? parseInt(away.score || '0', 10) : null,
      status: isFinal ? 'final' : isLive ? 'live' : 'scheduled',
      clock: clockLabel,
      isPenaltyShootout: espnPK && stage !== 'group'
    };
  });
  return matches;
}

async function fetchWCMatchesForDate(dateStr) {
  // dateStr: YYYYMMDD, or null/undefined for today's scoreboard
  const path = '/apis/site/v2/sports/soccer/fifa.world/scoreboard' + (dateStr ? '?dates=' + dateStr : '');
  try {
    const result = await httpsGet(
      'site.api.espn.com',
      path,
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.espn.com/' }
    );
    if (result.status !== 200) return {};
    const parsed = JSON.parse(result.body);
    return parseESPNEvents(parsed.events || []);
  } catch(e) {
    console.error('fetchWCMatchesForDate error for ' + dateStr + ':', e.message);
    return {};
  }
}

async function fetchWCMatches() {
  try {
    const matches = await fetchWCMatchesForDate(null);
    return { matches: matches, updated: new Date().toISOString() };
  } catch(e) {
    return { error: e.message };
  }
}

async function pushWCMatchesToFirebase() {
  if (!firebaseReady) return { error: 'Firebase not ready' };
  const result = await fetchWCMatches();
  if (result.error) return result;
  try {
    const db = admin.database();
    const fullSnap = await db.ref('wc26_live').get();
    const fullData = fullSnap.exists() ? (fullSnap.val() || {}) : {};
    const existing = fullData.matches || {};
    const teamOwners = fullData.teamOwners || {};
    const config = fullData.config || {};
    const participants = config.participants || ALL_WC_OWNERS;
    const notified = fullData.notifiedTies || {};

    // Start from existing (preserves full schedule), overlay today's fresh results
    const merged = Object.assign({}, existing, result.matches);
    // Protect against status downgrades from stale ESPN data
    Object.keys(existing).forEach(function(id) {
      if (!merged[id]) return;
      const existStatus = existing[id].status;
      const mergedStatus = merged[id].status;
      // Never downgrade a final match — keep existing data entirely
      if (existStatus === 'final' && mergedStatus !== 'final') {
        merged[id] = existing[id];
        return;
      }
      // Never downgrade live → scheduled (ESPN can transiently return stale status)
      if (existStatus === 'live' && mergedStatus === 'scheduled') {
        merged[id].status = 'live';
        merged[id].homeScore = existing[id].homeScore;
        merged[id].awayScore = existing[id].awayScore;
        if (existing[id].clock) merged[id].clock = existing[id].clock;
      }
      // Preserve manual isPenaltyShootout override
      if (existing[id].isPenaltyShootout && !merged[id].isPenaltyShootout) {
        merged[id].isPenaltyShootout = true;
      }
    });

    await db.ref('wc26_live/matches').set(merged);
    await db.ref('wc26_live/updated').set(result.updated);
    console.log('WC matches push: ' + Object.keys(merged).length + ' matches');

    // Detect newly completed ties and fire GroupMe notifications
    const newTies = Object.values(merged).filter(function(m) {
      if (!m || !m.id) return false;
      const before = existing[m.id];
      if (!before || before.status === 'final') return false; // didn't just become final
      if (m.status !== 'final') return false;
      if (notified[m.id]) return false; // already notified (prevents duplicate fires)
      const hs = m.homeScore, as_ = m.awayScore;
      return (m.stage === 'group' && hs === as_) || (m.stage !== 'group' && m.isPenaltyShootout);
    });

    if (newTies.length > 0) {
      // Write notified flags first to prevent double-posting if cron and manual refresh overlap
      const notifyUpdates = {};
      newTies.forEach(function(m) { notifyUpdates[m.id] = true; });
      await db.ref('wc26_live/notifiedTies').update(notifyUpdates);

      const fin = computeWCFinancials(merged, teamOwners, participants);
      for (const tie of newTies) {
        await postWCTieGroupMe(tie, teamOwners, fin.tiePotTotal);
      }
    }

    return { ok: true, matchCount: Object.keys(merged).length, updated: result.updated, newTies: newTies.length };
  } catch(e) {
    return { error: e.message };
  }
}

// ── WC daily standings GroupMe ────────────────────────────────────

function computeWCFinancials(matches, teamOwners, participants) {
  const n = participants.length;
  const net = {}, tieCount = {};
  let tiePotTotal = 0;
  participants.forEach(function(p) { net[p] = 0; tieCount[p] = 0; });
  Object.values(matches || {}).filter(function(m) { return m.status === 'final'; }).forEach(function(m) {
    const ho = teamOwners[m.homeTeam], ao = teamOwners[m.awayTeam];
    const hs = m.homeScore || 0, as_ = m.awayScore || 0;
    if (ho !== undefined && hs > 0) {
      net[ho] += hs * (n - 1);
      participants.forEach(function(p) { if (p !== ho) net[p] -= hs; });
    }
    if (ao !== undefined && as_ > 0) {
      net[ao] += as_ * (n - 1);
      participants.forEach(function(p) { if (p !== ao) net[p] -= as_; });
    }
    const isTie = (m.stage === 'group' && hs === as_) || (m.stage !== 'group' && m.isPenaltyShootout);
    if (isTie) {
      if (ho !== undefined && ao !== undefined && ho === ao) {
        net[ho] -= 20; tieCount[ho] += 2; tiePotTotal += 20;
      } else {
        if (ho !== undefined) { net[ho] -= 10; tieCount[ho]++; tiePotTotal += 10; }
        if (ao !== undefined) { net[ao] -= 10; tieCount[ao]++; tiePotTotal += 10; }
      }
    } else if (ho !== undefined && ao !== undefined && ho !== ao) {
      const wo = hs > as_ ? ho : ao, lo = hs > as_ ? ao : ho;
      net[wo] += 10; net[lo] -= 10;
    }
  });
  return { net, tieCount, tiePotTotal };
}

function wcDateInET(isoStr) {
  return new Date(new Date(isoStr).getTime() - 4 * 3600000).toISOString().slice(0, 10);
}

function wcTimeInET(isoStr) {
  const d = new Date(new Date(isoStr).getTime() - 4 * 3600000);
  const h = d.getUTCHours(), m = d.getUTCMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return h12 + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap + ' ET';
}

function wcStageName(m) {
  if (m.stage === 'group') return m.group ? 'Group ' + m.group : 'Group';
  if (m.stage === 'r32') return 'R32';
  if (m.stage === 'r16') return 'R16';
  if (m.stage === 'qf') return 'QF';
  if (m.stage === 'sf') return 'SF';
  if (m.stage === 'final') return 'Final';
  return '';
}

async function postWCDailyGroupMe() {
  if (!firebaseReady) return { error: 'Firebase not ready' };

  await pushWCMatchesToFirebase();

  const db = admin.database();
  const snap = await db.ref('wc26_live').get();
  if (!snap.exists()) return { error: 'No WC data in Firebase' };
  const data = snap.val();
  const matches = data.matches || {};
  const teamOwners = data.teamOwners || {};
  const config = data.config || {};
  const participants = config.participants || ALL_WC_OWNERS;

  const fin = computeWCFinancials(matches, teamOwners, participants);

  const nowET = new Date(Date.now() - 4 * 3600000);
  const todayET = nowET.toISOString().slice(0, 10);
  const ydDate = new Date(nowET);
  ydDate.setUTCDate(ydDate.getUTCDate() - 1);
  const yesterdayET = ydDate.toISOString().slice(0, 10);

  const allMatches = Object.values(matches);
  const finalYest = allMatches
    .filter(function(m) { return m.status === 'final' && wcDateInET(m.date) === yesterdayET; })
    .sort(function(a, b) { return new Date(a.date) - new Date(b.date); });
  const todayMatches = allMatches
    .filter(function(m) { return wcDateInET(m.date) === todayET && m.status !== 'final'; })
    .sort(function(a, b) { return new Date(a.date) - new Date(b.date); });

  const WC_FLAG_MAP = {};
  WC_TEAMS.forEach(function(t) { WC_FLAG_MAP[t.name] = t.flag || ''; });
  function tl(team) { return flagEmojiWC(WC_FLAG_MAP[team] || '') + ' ' + team; }

  const MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DO = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const todayDt = new Date(todayET + 'T12:00:00Z');
  const ydDt = new Date(yesterdayET + 'T12:00:00Z');

  const lines = [
    '⚽ WC2026 Daily Update — ' + DO[todayDt.getUTCDay()] + ' ' + MO[todayDt.getUTCMonth()] + ' ' + todayDt.getUTCDate(),
  ];

  lines.push('');
  if (finalYest.length > 0) {
    lines.push('📋 Yesterday\'s Results (' + MO[ydDt.getUTCMonth()] + ' ' + ydDt.getUTCDate() + ')');
    finalYest.forEach(function(m) {
      const ho = teamOwners[m.homeTeam], ao = teamOwners[m.awayTeam];
      const hs = m.homeScore, as_ = m.awayScore;
      const isTie = (m.stage === 'group' && hs === as_) || (m.stage !== 'group' && m.isPenaltyShootout);
      const suffix = m.isPenaltyShootout && m.stage !== 'group' ? ' (PKs)' : isTie ? ' (TIE)' : '';
      let ownerStr = '';
      if (ho && ao && ho !== ao) ownerStr = '  (' + ho + ' vs ' + ao + ')';
      else if (ho) ownerStr = '  (' + ho + ')';
      else if (ao) ownerStr = '  (' + ao + ')';
      lines.push(tl(m.homeTeam) + ' ' + hs + '-' + as_ + ' ' + tl(m.awayTeam) + suffix + ownerStr);
    });
  } else {
    lines.push('📋 No matches played yesterday (' + MO[ydDt.getUTCMonth()] + ' ' + ydDt.getUTCDate() + ')');
  }

  lines.push('');
  if (todayMatches.length > 0) {
    lines.push('📅 Today\'s Matches (' + MO[todayDt.getUTCMonth()] + ' ' + todayDt.getUTCDate() + ')');
    todayMatches.forEach(function(m) {
      const ho = teamOwners[m.homeTeam], ao = teamOwners[m.awayTeam];
      let ownerStr = '';
      if (ho && ao && ho !== ao) ownerStr = '  (' + ho + ' vs ' + ao + ')';
      else if (ho) ownerStr = '  (' + ho + ')';
      else if (ao) ownerStr = '  (' + ao + ')';
      const timeStr = m.status === 'live' ? ' 🔴 LIVE' : '  ' + wcTimeInET(m.date);
      lines.push(tl(m.homeTeam) + ' vs ' + tl(m.awayTeam) + timeStr + ownerStr);
    });
  } else {
    lines.push('📅 No matches today (' + MO[todayDt.getUTCMonth()] + ' ' + todayDt.getUTCDate() + ')');
  }

  const ranked = [...participants].sort(function(a, b) { return (fin.net[b] || 0) - (fin.net[a] || 0); });
  lines.push('');
  lines.push('🏆 Standings');
  const medals = ['🥇','🥈','🥉'];
  ranked.forEach(function(p, i) {
    const val = fin.net[p] || 0;
    const valStr = val > 0 ? '+$' + val : val < 0 ? '-$' + Math.abs(val) : '$0';
    lines.push((i < 3 ? medals[i] : (i + 1) + '.') + ' ' + p + '  ' + valStr);
  });

  lines.push('');
  lines.push('⚖️ Tie pot: $' + fin.tiePotTotal);
  if (fin.tiePotTotal > 0) {
    const maxTies = Math.max(...participants.map(function(p) { return fin.tieCount[p] || 0; }));
    const minTies = Math.min(...participants.map(function(p) { return fin.tieCount[p] || 0; }));
    const mostTied = participants.filter(function(p) { return (fin.tieCount[p] || 0) === maxTies; });
    const leastTied = participants.filter(function(p) { return (fin.tieCount[p] || 0) === minTies; });
    if (maxTies > 0) lines.push('  Most ties: ' + mostTied.map(function(p) { return p + ' (' + (fin.tieCount[p] || 0) + ')'; }).join(', '));
    if (minTies < maxTies) lines.push('  Fewest ties: ' + leastTied.map(function(p) { return p + ' (' + (fin.tieCount[p] || 0) + ')'; }).join(', '));
  }

  lines.push('');
  lines.push('🔗 gyou.in/wc.html');

  const text = lines.join('\n');
  console.log('WC daily GroupMe:\n' + text);

  const body = JSON.stringify({ bot_id: WC_GROUPME_BOT_ID, text: text });
  try {
    await new Promise(function(resolve, reject) {
      const req = https.request({
        hostname: 'api.groupme.com',
        path: '/v3/bots/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, function(r) { r.resume(); r.on('end', resolve); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log('WC daily GroupMe posted — ' + finalYest.length + ' results, ' + todayMatches.length + ' upcoming');
    return { ok: true, matchesYesterday: finalYest.length, matchesToday: todayMatches.length };
  } catch(e) {
    console.error('WC daily GroupMe failed:', e.message);
    return { error: e.message };
  }
}

async function postWCTieGroupMe(match, teamOwners, tiePotTotal) {
  const WC_FLAG_MAP = {};
  WC_TEAMS.forEach(function(t) { WC_FLAG_MAP[t.name] = t.flag || ''; });
  function tl(team) { return flagEmojiWC(WC_FLAG_MAP[team] || '') + ' ' + team; }

  const ho = teamOwners[match.homeTeam];
  const ao = teamOwners[match.awayTeam];
  const hs = match.homeScore, as_ = match.awayScore;
  const isPK = match.isPenaltyShootout && match.stage !== 'group';
  const stageStr = match.group ? 'Group ' + match.group.toUpperCase() : (match.stage || 'Knockout');

  const contextStr = isPK ? 'Penalty Shootout' : stageStr;

  const lines = ['🚨 THERE\'S BEEN A TIE! 🚨'];
  lines.push(contextStr + ' · ' + tl(match.homeTeam) + ' ' + hs + '–' + as_ + ' ' + tl(match.awayTeam));
  lines.push('');

  const affected = [];
  if (ho) affected.push(ho);
  if (ao && ao !== ho) affected.push(ao);
  if (affected.length > 0) {
    lines.push('💸 ' + affected.join(' & ') + ' each -$10 → Pot: $' + tiePotTotal);
  } else {
    lines.push('Tie pot: $' + tiePotTotal);
  }

  const text = lines.join('\n');
  console.log('WC tie GroupMe:\n' + text);

  if (GROUPME_DRY_RUN || !WC_GROUPME_BOT_ID) {
    console.log('[DRY RUN] Would post tie notification');
    return;
  }
  const body = JSON.stringify({ bot_id: WC_GROUPME_BOT_ID, text: text });
  try {
    await new Promise(function(resolve, reject) {
      const req = https.request({
        hostname: 'api.groupme.com',
        path: '/v3/bots/post',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, function(r) { r.resume(); r.on('end', resolve); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    console.log('WC tie GroupMe posted: ' + match.homeTeam + ' vs ' + match.awayTeam);
  } catch(e) {
    console.error('WC tie GroupMe failed:', e.message);
  }
}

// WC static routes (before parameterized to avoid collision)
app.get('/wc/matches', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });
  try {
    const snap = await admin.database().ref('wc26_live').get();
    res.json(snap.exists() ? snap.val() : {});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/wc/matches/seed', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });
  const SEED_GROUPS = {
    A:['Mexico','South Africa','South Korea','Czechia'],
    B:['Canada','Bosnia-Herzegovina','Qatar','Switzerland'],
    C:['Brazil','Morocco','Haiti','Scotland'],
    D:['United States','Paraguay','Australia','Türkiye'],
    E:['Germany','Curaçao','Ivory Coast','Ecuador'],
    F:['Netherlands','Japan','Sweden','Tunisia'],
    G:['Belgium','Egypt','Iran','New Zealand'],
    H:['Spain','Cape Verde','Saudi Arabia','Uruguay'],
    I:['France','Senegal','Iraq','Norway'],
    J:['Argentina','Algeria','Austria','Jordan'],
    K:['Portugal','Congo DR','Uzbekistan','Colombia'],
    L:['England','Croatia','Ghana','Panama']
  };
  // Weighted random goal count: skewed toward 0-2 goals
  function randGoals() {
    const r = Math.random();
    if (r < 0.20) return 0;
    if (r < 0.50) return 1;
    if (r < 0.75) return 2;
    if (r < 0.90) return 3;
    return 4;
  }
  const matches = {};
  let id = 9000;
  const baseDate = new Date('2026-06-11T18:00:00Z');
  Object.entries(SEED_GROUPS).forEach(function([group, teams]) {
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const d = new Date(baseDate);
        d.setDate(d.getDate() + id - 9000);
        matches['seed_' + id] = {
          id: 'seed_' + id,
          date: d.toISOString(),
          name: teams[i] + ' vs ' + teams[j],
          stage: 'group', group: group,
          homeTeam: teams[i], awayTeam: teams[j],
          homeScore: randGoals(), awayScore: randGoals(),
          status: 'final', isPenaltyShootout: false
        };
        id++;
      }
    }
  });
  try {
    await admin.database().ref('wc26_live/matches').set(matches);
    await admin.database().ref('wc26_live/updated').set(new Date().toISOString());
    res.json({ ok: true, matchCount: Object.keys(matches).length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/wc/matches/seed-full', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });

  const GROUPS = {
    A:['Mexico','South Africa','South Korea','Czechia'],
    B:['Canada','Bosnia-Herzegovina','Qatar','Switzerland'],
    C:['Brazil','Morocco','Haiti','Scotland'],
    D:['United States','Paraguay','Australia','Türkiye'],
    E:['Germany','Curaçao','Ivory Coast','Ecuador'],
    F:['Netherlands','Japan','Sweden','Tunisia'],
    G:['Belgium','Egypt','Iran','New Zealand'],
    H:['Spain','Cape Verde','Saudi Arabia','Uruguay'],
    I:['France','Senegal','Iraq','Norway'],
    J:['Argentina','Algeria','Austria','Jordan'],
    K:['Portugal','Congo DR','Uzbekistan','Colombia'],
    L:['England','Croatia','Ghana','Panama']
  };

  function rg() { const r=Math.random(); return r<.20?0:r<.50?1:r<.75?2:r<.90?3:4; }
  function shuffleArr(a) { const b=[...a]; for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];} return b; }
  function mkDate(daysFromStart, slot) {
    const d = new Date('2026-06-11T00:00:00Z');
    d.setDate(d.getDate() + daysFromStart);
    d.setUTCHours(15 + (slot % 3) * 3); // 15:00, 18:00, 21:00 UTC
    return d.toISOString();
  }

  const matches = {};
  let mid = 8000;
  const stats = {}; // team -> { mp,w,d,l,gf,ga,pts }
  Object.values(GROUPS).flat().forEach(t => { stats[t] = {mp:0,w:0,d:0,l:0,gf:0,ga:0,pts:0}; });

  // ── Group stage (days 0–16) ──────────────────────────────────────
  let gDay = 0, slotInDay = 0;
  Object.entries(GROUPS).forEach(([grp, teams]) => {
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const hs = rg(), as_ = rg();
        const id = 'fs_g_' + (mid++);
        matches[id] = { id, date: mkDate(gDay, slotInDay), stage: 'group', group: grp,
          homeTeam: teams[i], awayTeam: teams[j], homeScore: hs, awayScore: as_, status: 'final', isPenaltyShootout: false };
        stats[teams[i]].mp++; stats[teams[j]].mp++;
        stats[teams[i]].gf += hs; stats[teams[i]].ga += as_;
        stats[teams[j]].gf += as_; stats[teams[j]].ga += hs;
        if (hs > as_) { stats[teams[i]].w++; stats[teams[i]].pts += 3; stats[teams[j]].l++; }
        else if (as_ > hs) { stats[teams[j]].w++; stats[teams[j]].pts += 3; stats[teams[i]].l++; }
        else { stats[teams[i]].d++; stats[teams[i]].pts++; stats[teams[j]].d++; stats[teams[j]].pts++; }
        slotInDay++;
        if (slotInDay >= 4) { slotInDay = 0; gDay++; }
      }
    }
    gDay++; slotInDay = 0; // gap day between groups
  });

  // ── Determine advancing teams ────────────────────────────────────
  function sortTeams(teams) {
    return [...teams].sort((a, b) => {
      const sa = stats[a], sb = stats[b];
      if (sb.pts !== sa.pts) return sb.pts - sa.pts;
      const gda = sa.gf - sa.ga, gdb = sb.gf - sb.ga;
      if (gdb !== gda) return gdb - gda;
      return sb.gf - sa.gf;
    });
  }

  const winners = [], runners = [], thirds = [];
  Object.entries(GROUPS).forEach(([, teams]) => {
    const s = sortTeams(teams);
    winners.push(s[0]); runners.push(s[1]); thirds.push(s[2]);
  });
  const best8thirds = sortTeams(thirds).slice(0, 8);
  const r32teams = shuffleArr([...winners, ...runners, ...best8thirds]); // 32 teams, random bracket

  // ── Knockout helper ──────────────────────────────────────────────
  function ko(home, away, stage, day, slot) {
    const hs = rg(), as_ = rg();
    const isPK = (hs === as_); // draws in knockout → PK
    const winner = isPK ? (Math.random() < 0.5 ? home : away) : (hs > as_ ? home : away);
    const id = 'fs_' + stage + '_' + (mid++);
    matches[id] = { id, date: mkDate(day, slot), stage, homeTeam: home, awayTeam: away,
      homeScore: hs, awayScore: as_, status: 'final', isPenaltyShootout: isPK };
    return winner;
  }

  // R32 — days 17–22 (16 matches, 3/day)
  let cur = r32teams, nxt = [];
  for (let i = 0; i < cur.length; i += 2)
    nxt.push(ko(cur[i], cur[i+1], 'r32', 17 + Math.floor(i / 6), i % 3));

  // R16 — days 23–26 (8 matches, 2/day)
  cur = nxt; nxt = [];
  for (let i = 0; i < cur.length; i += 2)
    nxt.push(ko(cur[i], cur[i+1], 'r16', 23 + Math.floor(i / 2), i % 2));

  // QF — days 27–29 (4 matches)
  cur = nxt; nxt = [];
  for (let i = 0; i < cur.length; i += 2)
    nxt.push(ko(cur[i], cur[i+1], 'qf', 27 + i, 0));

  // SF — days 33–34 (2 matches); track losers for 3rd place
  cur = nxt; nxt = []; const sfLosers = [];
  for (let i = 0; i < cur.length; i += 2) {
    const hs = rg(), as_ = rg(), isPK = (hs === as_);
    const winner = isPK ? (Math.random() < 0.5 ? cur[i] : cur[i+1]) : (hs > as_ ? cur[i] : cur[i+1]);
    sfLosers.push(winner === cur[i] ? cur[i+1] : cur[i]);
    const id = 'fs_sf_' + (mid++);
    matches[id] = { id, date: mkDate(33 + Math.floor(i/2), 0), stage: 'sf',
      homeTeam: cur[i], awayTeam: cur[i+1], homeScore: hs, awayScore: as_, status: 'final', isPenaltyShootout: isPK };
    nxt.push(winner);
  }

  // 3rd place — day 37
  ko(sfLosers[0], sfLosers[1], 'sf', 37, 0);

  // Final — day 38
  ko(nxt[0], nxt[1], 'final', 38, 0);

  const bySt = {};
  Object.values(matches).forEach(m => { bySt[m.stage] = (bySt[m.stage]||0) + 1; });

  try {
    await admin.database().ref('wc26_live/matches').set(matches);
    await admin.database().ref('wc26_live/updated').set(new Date().toISOString());
    res.json({ ok: true, total: Object.keys(matches).length, byStage: bySt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/wc/matches/refresh', async function(req, res) {
  const result = await pushWCMatchesToFirebase();
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

// Force-refresh a specific date from ESPN — bypasses the live→scheduled guard so hung games can be resolved
app.post('/wc/matches/refresh-date', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });
  const { date } = req.body; // YYYYMMDD
  if (!date || !/^\d{8}$/.test(date)) return res.status(400).json({ error: 'date required in YYYYMMDD format' });
  try {
    const fetched = await fetchWCMatchesForDate(date);
    if (!Object.keys(fetched).length) return res.json({ ok: true, fetched: 0, note: 'ESPN returned no matches for ' + date });
    const db = admin.database();
    const snap = await db.ref('wc26_live/matches').get();
    const existing = snap.exists() ? (snap.val() || {}) : {};
    const merged = Object.assign({}, existing, fetched);
    Object.keys(existing).forEach(function(id) {
      if (!merged[id]) return;
      // Still protect confirmed finals from regressing to scheduled (ESPN transient stale data)
      if (existing[id].status === 'final' && merged[id].status === 'scheduled') {
        merged[id] = existing[id];
        return;
      }
      // Preserve manual PK override
      if (existing[id].isPenaltyShootout && !merged[id].isPenaltyShootout) {
        merged[id].isPenaltyShootout = true;
      }
    });
    await db.ref('wc26_live/matches').set(merged);
    await db.ref('wc26_live/updated').set(new Date().toISOString());
    console.log('WC refresh-date ' + date + ': ' + Object.keys(fetched).length + ' matches fetched from ESPN');
    res.json({ ok: true, fetched: Object.keys(fetched).length, date: date, updated: new Date().toISOString() });
  } catch(e) {
    console.error('WC refresh-date error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/wc/groupme', async function(req, res) {
  const result = await postWCDailyGroupMe();
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

app.post('/wc/matches/clear', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });
  try {
    await admin.database().ref('wc26_live/matches').remove();
    await admin.database().ref('wc26_live/updated').set(new Date().toISOString());
    console.log('WC matches cleared by commissioner');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/wc/matches/manual', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });
  const match = req.body;
  if (!match.id || !match.homeTeam || !match.awayTeam) return res.status(400).json({ error: 'id, homeTeam, awayTeam required' });
  try {
    await admin.database().ref('wc26_live/matches/' + match.id).set(match);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/wc/matches/:id/pk', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });
  try {
    await admin.database().ref('wc26_live/matches/' + req.params.id + '/isPenaltyShootout').set(!!req.body.isPenaltyShootout);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// WC: raw ESPN response — ?date=YYYYMMDD optional, defaults to today
app.get('/wc/matches/raw', async function(req, res) {
  try {
    const dateStr = req.query.date || null;
    const path = '/apis/site/v2/sports/soccer/fifa.world/scoreboard' + (dateStr ? '?dates=' + dateStr : '');
    const result = await httpsGet(
      'site.api.espn.com',
      path,
      { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', 'Referer': 'https://www.espn.com/' }
    );
    const parsed = result.status === 200 ? JSON.parse(result.body) : null;
    const events = parsed ? (parsed.events || []) : [];
    res.json({
      status: result.status,
      date: dateStr || 'today',
      eventCount: events.length,
      matchesParsed: parseESPNEvents(events),
      raw: parsed
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// WC: load full tournament schedule from ESPN into Firebase
// Fetches every date Jun 11 – Jul 19 2026; merges without overwriting final matches
app.post('/wc/schedule/load', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });

  const startDate = new Date('2026-06-11');
  const endDate   = new Date('2026-07-19');
  const dates = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dates.push('' + y + m + day);
  }

  console.log('WC schedule load: fetching ' + dates.length + ' dates from ESPN...');
  const allFetched = {};
  const BATCH = 5;
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(function(d) { return fetchWCMatchesForDate(d); }));
    results.forEach(function(m) { Object.assign(allFetched, m); });
    if (i + BATCH < dates.length) await new Promise(function(r) { setTimeout(r, 300); });
  }

  console.log('WC schedule load: ESPN returned ' + Object.keys(allFetched).length + ' matches across all dates');

  try {
    const db = admin.database();
    const existingSnap = await db.ref('wc26_live/matches').get();
    const existing = existingSnap.exists() ? (existingSnap.val() || {}) : {};

    // Merge rules:
    // 1. Start with what ESPN returned for all dates
    // 2. Never downgrade a final match back to scheduled
    // 3. Preserve any manual isPenaltyShootout override from commissioner
    // 4. Keep any manually-added matches (e.g. seed data) not present in ESPN results
    const merged = Object.assign({}, allFetched);
    Object.keys(existing).forEach(function(id) {
      if (merged[id]) {
        if (existing[id].isPenaltyShootout && !merged[id].isPenaltyShootout) {
          merged[id].isPenaltyShootout = true;
        }
        if (existing[id].status === 'final' && merged[id].status !== 'final') {
          merged[id] = existing[id];
        }
      } else {
        merged[id] = existing[id];
      }
    });

    await db.ref('wc26_live/matches').set(merged);
    await db.ref('wc26_live/updated').set(new Date().toISOString());

    const byStatus = { scheduled: 0, live: 0, final: 0, other: 0 };
    Object.values(merged).forEach(function(m) {
      if (byStatus[m.status] !== undefined) byStatus[m.status]++;
      else byStatus.other++;
    });

    console.log('WC schedule load complete:', Object.keys(merged).length, 'total matches, status breakdown:', byStatus);
    res.json({ ok: true, total: Object.keys(merged).length, byStatus: byStatus, updated: new Date().toISOString() });
  } catch(e) {
    console.error('WC schedule load Firebase error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// WC draft routes
app.get('/wc/:slug', function(req, res) { res.json(getOrCreateWCDraft(req.params.slug)); });

app.post('/wc/:slug/setup', function(req, res) {
  const draft = getOrCreateWCDraft(req.params.slug);
  const { name, owners } = req.body;
  if (name) draft.name = name;
  if (owners && owners.length >= 2) {
    draft.owners = owners;
    draft.picks = {};
    owners.forEach(function(o) { draft.picks[o] = []; });
  }
  draft.status = 'lobby';
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/wc/:slug/start', function(req, res) {
  const draft = getOrCreateWCDraft(req.params.slug);
  if (draft.status !== 'lobby') return res.status(400).json({ error: 'Not in lobby' });
  draft.pickOrder = (req.body && req.body.pickOrder) || shuffle(draft.owners);
  const teamsPerOwner = Math.floor(WC_TEAMS.length / draft.owners.length);
  const totalToPick = teamsPerOwner * draft.owners.length;
  draft.pickSequence = generateWCPickSequence(draft.pickOrder, totalToPick);
  draft.currentPickIndex = 0;
  draft.status = 'drafting';
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/wc/:slug/reset', function(req, res) {
  delete wcDrafts[req.params.slug];
  const fresh = getOrCreateWCDraft(req.params.slug);
  broadcast(req.params.slug, { type: 'state', draft: fresh });
  res.json(fresh);
});

app.post('/wc/:slug/pick', function(req, res) {
  const draft = getOrCreateWCDraft(req.params.slug);
  if (draft.status !== 'drafting') return res.status(400).json({ error: 'Not drafting' });
  const { owner, team } = req.body;
  draft.undoStack.push({ teams: JSON.parse(JSON.stringify(draft.teams)), picks: JSON.parse(JSON.stringify(draft.picks)), currentPickIndex: draft.currentPickIndex, status: draft.status });
  draft.redoStack = [];
  draft.teams = draft.teams.filter(function(t) { return t.name !== team.name; });
  if (!draft.picks[owner]) draft.picks[owner] = [];
  draft.picks[owner].push(team);
  const justPickedIndex = draft.currentPickIndex;
  draft.currentPickIndex++;
  if (draft.currentPickIndex >= draft.pickSequence.length) draft.status = 'complete';
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
  // Post to GroupMe after responding (non-blocking)
  postWCPickGroupMe(draft, team, owner, justPickedIndex).catch(function(e) { console.error('WC GroupMe error:', e.message); });
});

app.post('/wc/:slug/undo', function(req, res) {
  const draft = getOrCreateWCDraft(req.params.slug);
  if (!draft.undoStack.length) return res.status(400).json({ error: 'Nothing to undo' });
  draft.redoStack.push({ teams: JSON.parse(JSON.stringify(draft.teams)), picks: JSON.parse(JSON.stringify(draft.picks)), currentPickIndex: draft.currentPickIndex, status: draft.status });
  const prev = draft.undoStack.pop();
  Object.assign(draft, prev);
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/wc/:slug/redo', function(req, res) {
  const draft = getOrCreateWCDraft(req.params.slug);
  if (!draft.redoStack.length) return res.status(400).json({ error: 'Nothing to redo' });
  draft.undoStack.push({ teams: JSON.parse(JSON.stringify(draft.teams)), picks: JSON.parse(JSON.stringify(draft.picks)), currentPickIndex: draft.currentPickIndex, status: draft.status });
  const next = draft.redoStack.pop();
  Object.assign(draft, next);
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/wc/:slug/seed', function(req, res) {
  const draft = getOrCreateWCDraft(req.params.slug);
  if (draft.status !== 'drafting') return res.status(400).json({ error: 'Not drafting' });
  draft.undoStack.push({ teams: JSON.parse(JSON.stringify(draft.teams)), picks: JSON.parse(JSON.stringify(draft.picks)), currentPickIndex: draft.currentPickIndex, status: draft.status });
  draft.redoStack = [];
  const remaining = shuffle([...draft.teams]);
  const seq = draft.pickSequence;
  let ri = 0;
  for (let i = draft.currentPickIndex; i < seq.length; i++) {
    const owner = seq[i].owner;
    const team = remaining[ri++];
    if (!team) break;
    if (!draft.picks[owner]) draft.picks[owner] = [];
    draft.picks[owner].push(team);
  }
  draft.teams = [];
  draft.currentPickIndex = seq.length;
  draft.status = 'complete';
  broadcast(req.params.slug, { type: 'state', draft: draft });
  res.json(draft);
});

app.post('/wc/:slug/finalize', async function(req, res) {
  if (!firebaseReady) return res.status(503).json({ error: 'Firebase not ready' });
  const draft = getOrCreateWCDraft(req.params.slug);
  const teamOwners = {};
  Object.keys(draft.picks).forEach(function(owner) {
    (draft.picks[owner] || []).forEach(function(team) { teamOwners[team.name] = owner; });
  });
  try {
    const db = admin.database();
    await db.ref('wc26_live/teamOwners').set(teamOwners);
    await db.ref('wc26_live/config').set({ participants: draft.owners, draftName: draft.name, finalizedAt: new Date().toISOString() });
    draft.status = 'finalized';
    broadcast(req.params.slug, { type: 'state', draft: draft });
    res.json({ ok: true, teamOwners: teamOwners, participants: draft.owners });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Server + WebSocket ────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server: server });

wss.on('connection', function(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const slug = url.searchParams.get('slug');
  const type = url.searchParams.get('type');
  if (!slug) return ws.close();
  if (!clients[slug]) clients[slug] = new Set();
  clients[slug].add(ws);
  const draft = type === 'wc' ? getOrCreateWCDraft(slug) : getOrCreateDraft(slug);
  ws.send(JSON.stringify({ type: 'state', draft: draft }));
  ws.on('close', function() { clients[slug].delete(ws); });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, function() { console.log('Golf server running on port ' + PORT); });
