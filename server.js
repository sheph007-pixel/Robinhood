// Tiny server: serves index.html and a live quote endpoint for VTI and VXUS.
// No dependencies. Needs Node 18+ (built-in fetch).
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SYMBOLS = ['VTI', 'VXUS'];
const CACHE_MS = 60 * 1000;
let cache = { at: 0, data: null };

async function yahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Yahoo ${sym} ${r.status}`);
  const j = await r.json();
  const m = j.chart.result[0].meta;
  const prev = m.previousClose ?? m.chartPreviousClose;
  return {
    symbol: sym,
    name: m.longName || m.shortName || sym,
    price: m.regularMarketPrice,
    prevClose: prev,
    change: prev ? m.regularMarketPrice - prev : null,
    changePct: prev ? (m.regularMarketPrice / prev - 1) * 100 : null,
    time: m.regularMarketTime * 1000,
    source: 'Yahoo Finance',
  };
}

async function stooq(sym) {
  const r = await fetch(`https://stooq.com/q/l/?s=${sym.toLowerCase()}.us&f=sd2t2ohlcv&h&e=csv`);
  const t = await r.text();
  const row = t.trim().split('\n')[1].split(',');
  const price = parseFloat(row[6]);
  if (!isFinite(price)) throw new Error(`Stooq ${sym} no price`);
  return { symbol: sym, name: sym, price, prevClose: null, change: null, changePct: null,
           time: Date.parse(`${row[1]}T${row[2]}Z`) || Date.now(), source: 'Stooq' };
}

async function quotes() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const out = {};
  await Promise.all(SYMBOLS.map(async (s) => {
    try { out[s] = await yahoo(s); }
    catch (e) {
      try { out[s] = await stooq(s); }
      catch (e2) { out[s] = cache.data?.[s] || null; }
    }
  }));
  cache = { at: Date.now(), data: out };
  return out;
}

const crypto = require('crypto');
const page = path.join(__dirname, 'index.html');
const STATIC = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

// ---- Saved portfolio (one JSON file on a persistent volume) ----
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PIN = process.env.APP_PIN || '';
const fails = new Map(); // ip -> {n, until}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}
function pinOk(req) {
  if (!PIN) return true;
  const got = Buffer.from(String(req.headers['x-pin'] || ''));
  const want = Buffer.from(PIN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function handleState(req, res) {
  const ip = clientIp(req), f = fails.get(ip);
  if (f && f.until > Date.now()) return json(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
  if (!pinOk(req)) {
    const n = (f && f.until > Date.now() - 15 * 60e3 ? f.n : 0) + 1;
    fails.set(ip, { n, until: n >= 10 ? Date.now() + 15 * 60e3 : 0 });
    return json(res, 401, { error: 'Wrong PIN' });
  }
  fails.delete(ip);
  if (req.method === 'GET') {
    fs.readFile(STATE_FILE, 'utf8', (err, txt) => {
      if (err) return json(res, 200, { state: null });
      try { json(res, 200, { state: JSON.parse(txt) }); } catch (e) { json(res, 200, { state: null }); }
    });
    return;
  }
  if (req.method === 'PUT') {
    try {
      const obj = JSON.parse(await readBody(req));
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return json(res, 400, { error: 'bad data' });
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, STATE_FILE);
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: 'bad data' }); }
  }
  json(res, 405, { error: 'method' });
}


http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/quotes') {
    try {
      const data = await quotes();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'quotes unavailable' }));
    }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(page, (err, buf) => {
      if (err) { res.writeHead(500); res.end('error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  if (url.pathname === '/api/state') return handleState(req, res);
  if (STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    fs.readFile(path.join(__dirname, file), (err, buf) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      res.end(buf);
    });
    return;
  }
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log(`Listening on ${PORT}`));
