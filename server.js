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
    high52: m.fiftyTwoWeekHigh ?? null,
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
const Anthropic = require('@anthropic-ai/sdk');
const AI_MODEL = 'claude-opus-5-5';
const AI_SYSTEM = `You are the built-in assistant in a personal long-term investing app. The owner holds three things: VTI (Vanguard Total Stock Market ETF), VXUS (Vanguard Total International Stock ETF) and a high-yield cash bucket. Their goal is building wealth for the long run; the app is deliberately designed to counter the day-to-day noise of trading apps.

Every request includes a snapshot of their live portfolio data (holdings, prices, targets, projections). Use those exact numbers. Do math carefully and show the key figures.

How to help:
- Answer questions about their portfolio, where they stand against their targets and goal, how much to put where, and what the projections mean.
- For market news, today's moves or anything that happened recently, use web search and say when the information is from.
- Keep a calm, long-term perspective. Explain short-term drops in context; don't encourage timing the market or trading on headlines.
- Give clear, practical suggestions when asked (e.g. how to split a deposit to reach their targets, whether their cash level fits their stated targets), and explain the reasoning. Mention big trade-offs or risks briefly. You are not a licensed advisor; say so only when the question is about taxes, legal matters or a major life decision, not on every answer.
- Be concise: short paragraphs or a few bullets, plain language, no tables unless asked. Use dollar amounts rounded sensibly (e.g. $1.28M, $54,180).`;
let ai = null;
function aiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  // Accept a key saved under another variable name (e.g. "AI Key").
  for (const v of Object.values(process.env)) if (typeof v === 'string' && /^\s*sk-ant-/.test(v)) return v.trim();
  return null;
}
function aiClient() { const k = aiKey(); if (!k) return null; if (!ai) ai = new Anthropic({ apiKey: k }); return ai; }

async function handleChat(req, res) {
  const client = aiClient();
  if (!client) return json(res, 503, { error: 'no_key' });
  let body;
  try { body = JSON.parse(await readBody(req, 400 * 1024)); } catch (e) { return json(res, 400, { error: 'bad data' }); }
  const msgs = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const messages = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!messages.length || messages[messages.length - 1].role !== 'user') return json(res, 400, { error: 'bad data' });
  const context = String(body.context || '').slice(0, 20000);
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  try {
    for (let round = 0; round < 4; round++) {
      const stream = client.beta.messages.stream({
        model: AI_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: [
          { type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Today is ' + new Date().toUTCString() + '.\nLive portfolio snapshot:\n' + context },
        ],
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        messages,
      });
      stream.on('text', (t) => res.write(t));
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'server_tool_use') res.write('\u0000S');
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
      if (msg.stop_reason === 'refusal') res.write('\n\nSorry, I can\'t help with that one.');
      if (msg.stop_reason === 'max_tokens') res.write('\n\n(Answer cut short.)');
      break;
    }
  } catch (e) {
    console.error('chat error', e && e.status, e && e.message);
    res.write('\n\nSorry, the assistant ran into a problem' + (e && e.status === 401 ? ' (API key not accepted).' : '. Please try again.'));
  }
  res.end();
}
// Each view fetches extra history so a 200-day moving average is complete from the first visible point.
const HIST_RANGES = { '1y': ['2y', '1d'], '5y': ['10y', '1wk'], '10y': ['max', '1wk'], 'max': ['max', '1mo'] };
const histCache = new Map();
async function history(sym, rng) {
  const key = sym + rng + 'v2', hit = histCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${HIST_RANGES[rng][0]}&interval=${HIST_RANGES[rng][1]}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = (await r.json()).chart.result[0], t = [], c = [];
  j.timestamp.forEach((ts, i) => { const v = j.indicators.quote[0].close[i]; if (v != null) { t.push(ts * 1000); c.push(Math.round(v * 100) / 100); } });
  const data = { symbol: sym, range: rng, t, c };
  histCache.set(key, { at: Date.now(), data });
  return data;
}
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
  if (url.pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (url.pathname === '/api/chat/status') return json(res, 200, { ready: !!aiKey(), model: AI_MODEL });
  if (url.pathname === '/api/history') {
    const sym = String(url.searchParams.get('s') || '').toUpperCase();
    const rng = String(url.searchParams.get('r') || 'max');
    if (!SYMBOLS.includes(sym) || !HIST_RANGES[rng]) return json(res, 400, { error: 'bad request' });
    try { return json(res, 200, await history(sym, rng)); }
    catch (e) { return json(res, 502, { error: 'history unavailable' }); }
  }
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
