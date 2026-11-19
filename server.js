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
- Data first, always. For any question about prices, today's market, a move, or performance, start by pulling the real numbers: when the robinhood tool is available use it first (get_index_quotes for the S&P 500, Nasdaq and Dow; get_equity_quotes for VTI, VXUS and other tickers; get_index_historicals / get_equity_historicals for trends), and use get_quotes / get_price_history for anything Robinhood doesn't cover (VIX ^VIX, 10-year yield ^TNX, 200-day average). Only after that, use web search for the news behind a move (the "why"), and say when that news is from.
- For "why is the market down/up" questions: lead with how much the major indexes and VTI/VXUS actually moved today (from the data), then the main reasons from the news, then what it means for a long-term holder like the owner.
- When the robinhood tool is available, use it for account questions that need fresher or more detailed data than the snapshot (positions, cost basis, orders, recurring buys, realized gains, fundamentals, analyst ratings, earnings). Only the Core account is used.\n- The portfolio snapshot comes from the owner's Robinhood Core account (synced daily and on request): shares, average cost, cash, recurring buys and recent recurring orders. Margin is intentionally ignored.
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

const AI_TOOLS = [
  { name: 'get_quotes', description: 'Live market quotes for one or more tickers (stocks, ETFs, indexes such as ^GSPC, ^DJI, ^IXIC, ^VIX, or yields such as ^TNX). Returns price, previous close, day change, and 52-week high/low. Use this for any current price or "how did X do today" question before considering web search.', strict: true,
    input_schema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' }, description: 'Ticker symbols, e.g. ["VTI","VXUS","^GSPC"]' } }, required: ['symbols'], additionalProperties: false } },
  { name: 'get_price_history', description: 'Price history summary for one ticker over a period: start and end price, total % change, annualized return, high, low, maximum drawdown, current 200-day moving average (for 1y or longer), and ~24 sampled points. Prices are not dividend-adjusted. Use for performance and trend questions.', strict: true,
    input_schema: { type: 'object', properties: { symbol: { type: 'string' }, range: { type: 'string', enum: ['5d', '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', '10y', 'max'] } }, required: ['symbol', 'range'], additionalProperties: false } },
];
const RH_TOOL = { name: 'robinhood', description: 'Read-only access to the owner\'s Robinhood Core account and Robinhood market data. Call with the name of one allowed Robinhood tool and its arguments; the account number is filled in automatically (Core account only). Allowed tools: get_equity_positions, get_portfolio (account value, cash; ignore negative cash, which is margin), get_equity_orders (e.g. placed_agent "recurring", created_at_gte "YYYY-MM-DD", symbol, state), get_equity_quotes ({symbols:["VTI","VXUS"]}; includes the last session close), get_equity_historicals, get_equity_fundamentals, get_equity_analyst_ratings, get_index_quotes ({symbols:["SPX","NDX"]}; level only, so compare with get_quotes ^GSPC/^IXIC for the day change), get_index_historicals, get_indexes, get_earnings_calendar, get_equity_tax_lots, get_realized_pnl, search. If unsure of a tool\'s arguments, call it with {} and read the error.',
  input_schema: { type: 'object', properties: { tool: { type: 'string', enum: ['get_equity_positions', 'get_portfolio', 'get_equity_orders', 'get_equity_quotes', 'get_equity_historicals', 'get_equity_fundamentals', 'get_equity_analyst_ratings', 'get_index_quotes', 'get_index_historicals', 'get_indexes', 'get_earnings_calendar', 'get_equity_tax_lots', 'get_realized_pnl', 'search'] }, arguments: { type: 'object', description: 'Arguments for that tool (omit account_number).' } }, required: ['tool'] } };
const SYM_RE = /^[A-Za-z0-9.^=\-]{1,15}$/;
async function yChart(sym, range, interval) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`No data for ${sym}`);
  const j = await r.json(); if (!j.chart || !j.chart.result) throw new Error(`No data for ${sym}`);
  return j.chart.result[0];
}
async function runAiTool(name, input) {
  if (name === 'robinhood') {
    if (!rh.connected()) throw new Error('Robinhood is not connected to this site yet.');
    console.log('ai robinhood tool', input.tool);
    const out = await rh.call(String(input.tool || ''), input.arguments || {});
    const txt = JSON.stringify(out); return txt.length > 60000 ? txt.slice(0, 60000) + '…(truncated)' : out;
  }
  if (name === 'get_quotes') {
    const syms = (Array.isArray(input.symbols) ? input.symbols : []).filter(x => SYM_RE.test(x)).slice(0, 10);
    if (!syms.length) throw new Error('No valid symbols');
    return Promise.all(syms.map(async (sym) => {
      try { const m = (await yChart(sym, '1d', '1d')).meta, prev = m.previousClose ?? m.chartPreviousClose;
        return { symbol: sym, name: m.longName || m.shortName, price: m.regularMarketPrice, prevClose: prev, changePct: prev ? +((m.regularMarketPrice / prev - 1) * 100).toFixed(2) : null,
          high52: m.fiftyTwoWeekHigh, low52: m.fiftyTwoWeekLow, asOf: new Date(m.regularMarketTime * 1000).toISOString(), currency: m.currency }; }
      catch (e) { return { symbol: sym, error: e.message }; }
    }));
  }
  if (name === 'get_price_history') {
    const sym = String(input.symbol || ''); if (!SYM_RE.test(sym)) throw new Error('Invalid symbol');
    const range = ['5d', '1mo', '3mo', '6mo', 'ytd', '1y', '2y', '5y', '10y', 'max'].includes(input.range) ? input.range : '1y';
    const interval = { '5d': '1d', '1mo': '1d', '3mo': '1d', '6mo': '1d', ytd: '1d', '1y': '1d', '2y': '1d', '5y': '1wk', '10y': '1wk', max: '1mo' }[range];
    const res = await yChart(sym, range, interval), q = res.indicators.quote[0], pts = [];
    res.timestamp.forEach((t, i) => { if (q.close[i] != null) pts.push([t * 1000, q.close[i]]); });
    if (pts.length < 2) throw new Error('Not enough data');
    const first = pts[0], last = pts[pts.length - 1], yrs = (last[0] - first[0]) / 3.156e10;
    let peak = -Infinity, mdd = 0, hi = -Infinity, lo = Infinity;
    for (const [, c] of pts) { peak = Math.max(peak, c); mdd = Math.min(mdd, c / peak - 1); hi = Math.max(hi, c); lo = Math.min(lo, c); }
    let ma200 = null;
    if (interval === '1d' && pts.length >= 200) ma200 = pts.slice(-200).reduce((s, p) => s + p[1], 0) / 200;
    if (interval === '1wk' && pts.length >= 40) ma200 = pts.slice(-40).reduce((s, p) => s + p[1], 0) / 40;
    const step = Math.max(1, Math.floor(pts.length / 24)), d = t => new Date(t).toISOString().slice(0, 10);
    return { symbol: sym, range, start: { date: d(first[0]), price: +first[1].toFixed(2) }, end: { date: d(last[0]), price: +last[1].toFixed(2) },
      changePct: +((last[1] / first[1] - 1) * 100).toFixed(2), annualizedPct: yrs >= 0.95 ? +((Math.pow(last[1] / first[1], 1 / yrs) - 1) * 100).toFixed(2) : null,
      high: +hi.toFixed(2), low: +lo.toFixed(2), maxDrawdownPct: +(mdd * 100).toFixed(2), ma200: ma200 ? +ma200.toFixed(2) : null,
      samples: pts.filter((_, i) => i % step === 0).map(p => [d(p[0]), +p[1].toFixed(2)]) };
  }
  throw new Error('Unknown tool');
}

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
    for (let round = 0; round < 8; round++) {
      const stream = client.beta.messages.stream({
        model: AI_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: [
          { type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Today is ' + new Date().toUTCString() + '.\nLive portfolio snapshot (synced from the Robinhood Core account):\n' + context },
        ],
        tools: [...AI_TOOLS, ...(rh.connected() ? [RH_TOOL] : []), { type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
        messages,
      });
      stream.on('text', (t) => res.write(t));
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start' && ev.content_block) {
          if (ev.content_block.type === 'server_tool_use') res.write('\u0000S');
          if (ev.content_block.type === 'tool_use') res.write(ev.content_block.name === 'robinhood' ? '\u0000R' : '\u0000Q');
        }
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
      if (msg.stop_reason === 'tool_use') {
        const results = [];
        for (const blk of msg.content.filter(c => c.type === 'tool_use')) {
          let out, isErr = false;
          try { out = await runAiTool(blk.name, blk.input || {}); } catch (e) { out = { error: String(e && e.message || e) }; isErr = true; }
          results.push({ type: 'tool_result', tool_use_id: blk.id, content: JSON.stringify(out), is_error: isErr });
        }
        messages.push({ role: 'assistant', content: msg.content }, { role: 'user', content: results });
        continue;
      }
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
// ---- Login: PIN -> signed session cookie (6 months) ----
const SECRET_FILE = path.join(DATA_DIR, 'session_secret');
function sessionSecret() {
  try { return fs.readFileSync(SECRET_FILE, 'utf8'); } catch (e) {
    const s = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 }); return s;
  }
}
const sign = v => crypto.createHmac('sha256', sessionSecret() + '|' + PIN).update(v).digest('hex');
function sessionCookie() { const exp = String(Date.now() + 180 * 864e5); return exp + '.' + sign(exp); }
function cookieOk(req) {
  const m = /(?:^|;\s*)hs=([0-9]+)\.([a-f0-9]{64})/.exec(req.headers.cookie || ''); if (!m) return false;
  if (+m[1] < Date.now()) return false;
  const a = Buffer.from(m[2]), b = Buffer.from(sign(m[1]));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function authed(req) { return !PIN || cookieOk(req) || (req.headers['x-pin'] && pinOk(req)); }
async function handleLogin(req, res) {
  const ip = clientIp(req), f = fails.get(ip);
  if (f && f.until > Date.now()) return json(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
  let b; try { b = JSON.parse(await readBody(req, 2048)); } catch (e) { b = {}; }
  const got = Buffer.from(String(b.pin || '')), want = Buffer.from(PIN);
  if (!PIN || (got.length === want.length && crypto.timingSafeEqual(got, want))) {
    fails.delete(ip);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `hs=${sessionCookie()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${180 * 86400}` });
    return res.end('{"ok":true}');
  }
  const n = (f ? f.n : 0) + 1; fails.set(ip, { n, until: n >= 10 ? Date.now() + 15 * 60e3 : 0 });
  json(res, 401, { error: 'Wrong PIN' });
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
// ---- Robinhood sync: raw positions/cash/recurring orders in, saved state updated ----
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; } }
function writeState(obj) { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, STATE_FILE); }
function summarizeRecurring(orders) {
  const filled = orders.filter(o => o && o.side === 'buy' && (o.state === 'filled' || !o.state) && +o.amount > 0 && o.date)
    .map(o => ({ symbol: String(o.symbol).toUpperCase(), amount: +o.amount, date: String(o.date).slice(0, 10), price: +o.price || null, shares: +o.shares || null }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const recurring = [];
  for (const sym of [...new Set(filled.map(o => o.symbol))]) {
    const mine = filled.filter(o => o.symbol === sym), last = mine[0].date;
    const amount = mine.filter(o => o.date === last).reduce((s, o) => s + o.amount, 0);
    const days = new Set(mine.filter(o => (Date.parse(last) - Date.parse(o.date)) <= 14 * 864e5).map(o => o.date)).size;
    const freq = days >= 6 ? 'daily' : days >= 2 ? 'weekly' : 'monthly';
    const perMonth = amount * (freq === 'daily' ? 21 : freq === 'weekly' ? 4.33 : 1);
    const last30 = mine.filter(o => (Date.now() - Date.parse(o.date)) <= 30 * 864e5).reduce((s, o) => s + o.amount, 0);
    recurring.push({ symbol: sym, amount: Math.round(amount * 100) / 100, freq, perMonth: Math.round(perMonth), lastDate: last, last30: Math.round(last30) });
  }
  return { recurring, recent: filled.slice(0, 20) };
}
function applySync(b) {
  const st = readState(), pos = Array.isArray(b.positions) ? b.positions : [];
  const q = sym => { const p = pos.find(x => String(x.symbol).toUpperCase() === sym); return p ? +p.quantity : 0; };
  st.shVTI = q('VTI'); st.shVXUS = q('VXUS');
  const ac = sym => { const p = pos.find(x => String(x.symbol).toUpperCase() === sym); return p && +p.average_buy_price ? +p.average_buy_price : null; };
  st.avgCost = { VTI: ac('VTI'), VXUS: ac('VXUS') };
  if (b.cash != null && isFinite(+b.cash)) st.cash = Math.max(0, Math.round(+b.cash * 100) / 100);
  const r = summarizeRecurring(Array.isArray(b.orders) ? b.orders : []);
  st.rh = { account: String(b.account || '').slice(-4), syncedAt: new Date().toISOString(), recurring: r.recurring, recent: r.recent };
  st.rhSync = st.rh.syncedAt;
  writeState(st);
  return { ok: true, shVTI: st.shVTI, shVXUS: st.shVXUS, cash: st.cash, recurring: r.recurring };
}
async function handleRhSync(req, res) {
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  let b; try { b = JSON.parse(await readBody(req, 300 * 1024)); } catch (e) { return json(res, 400, { error: 'bad data' }); }
  json(res, 200, applySync(b));
}

// ---- Saved Ask AI conversations (shared across devices) ----
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');
function readChats() { try { return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')); } catch (e) { return { chats: [] }; } }
function writeChats(o) { fs.mkdirSync(DATA_DIR, { recursive: true }); const t = CHATS_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, CHATS_FILE); }
async function handleChats(req, res, url) {
  const id = decodeURIComponent(url.pathname.slice('/api/chats'.length).replace(/^\//, ''));
  if (id && !/^[a-z0-9-]{6,64}$/i.test(id)) return json(res, 400, { error: 'bad id' });
  const db = readChats();
  if (!id && req.method === 'GET') {
    return json(res, 200, { chats: db.chats.map(c => ({ id: c.id, title: c.title, updated: c.updated, count: c.messages.length })).sort((a, b) => b.updated.localeCompare(a.updated)) });
  }
  const i = db.chats.findIndex(c => c.id === id);
  if (req.method === 'GET') return i < 0 ? json(res, 404, { error: 'not found' }) : json(res, 200, db.chats[i]);
  if (req.method === 'DELETE') { if (i >= 0) { db.chats.splice(i, 1); writeChats(db); } return json(res, 200, { ok: true }); }
  if (req.method === 'PUT') {
    let b; try { b = JSON.parse(await readBody(req, 600 * 1024)); } catch (e) { return json(res, 400, { error: 'bad data' }); }
    const messages = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-200).map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));
    const title = String(b.title || (messages.find(m => m.role === 'user') || {}).content || 'New chat').slice(0, 80);
    const chat = { id, title, updated: new Date().toISOString(), messages };
    if (i >= 0) db.chats[i] = chat; else db.chats.push(chat);
    db.chats.sort((a, b) => b.updated.localeCompare(a.updated)); db.chats = db.chats.slice(0, 300);
    writeChats(db); return json(res, 200, { ok: true });
  }
  json(res, 405, { error: 'method' });
}

async function handleState(req, res) {
  const ip = clientIp(req), f = fails.get(ip);
  if (f && f.until > Date.now()) return json(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
  if (!authed(req)) {
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


const rh = require('./rh')(DATA_DIR);
async function serverSync() { const out = applySync(await rh.syncPayload()); console.log('Robinhood sync ok', out.shVTI, out.shVXUS); return out; }
// Daily sync after the close: weekdays 4:20 PM ET.
let lastAutoSync = '';
setInterval(() => {
  if (!rh.connected()) return;
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date());
  const g = k => p.find(x => x.type === k).value, day = g('year') + g('month') + g('day'), min = (+g('hour') % 24) * 60 + (+g('minute'));
  if (['Sat', 'Sun'].includes(g('weekday')) || min < 16 * 60 + 20 || lastAutoSync === day) return;
  lastAutoSync = day; serverSync().catch(e => console.error('Robinhood auto sync failed', e.message));
}, 60e3);
const RH_LOCAL_REDIRECT = 'http://localhost:8765/callback';
const baseUrl = req => (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);
  if (url.pathname === '/api/me') return authed(req) ? json(res, 200, { ok: true }) : json(res, 401, { error: 'login' });
  const open = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/health' || STATIC[url.pathname];
  if (!open && !authed(req)) {
    if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'login' });
    res.writeHead(302, { Location: '/' }); return res.end();
  }
  if (url.pathname === '/oauth/connect') {
    // Robinhood only accepts approved partner and localhost callbacks, so the login lands on a
    // localhost address and the user pastes that address back into the site (/api/rh/finish).
    try { const to = await rh.startAuth(process.env.RH_REDIRECT || RH_LOCAL_REDIRECT); res.writeHead(302, { Location: to }); return res.end(); }
    catch (e) { res.writeHead(502, { 'Content-Type': 'text/plain' }); return res.end('Could not start Robinhood login: ' + e.message); }
  }
  if (url.pathname === '/oauth/callback') {
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    try {
      if (!code || !state) throw new Error(url.searchParams.get('error_description') || url.searchParams.get('error') || 'Login was cancelled');
      await rh.finishAuth(code, state);
      try { await serverSync(); } catch (e) { console.error('first sync failed', e.message); }
      res.writeHead(302, { Location: '/?rh=connected' }); return res.end();
    } catch (e) { res.writeHead(400, { 'Content-Type': 'text/html' }); return res.end('<p style="font-family:sans-serif">Robinhood connection failed: ' + String(e.message).replace(/[<>&]/g, '') + '</p><p><a href="/">Back to Hood Investing</a></p>'); }
  }
  if (url.pathname === '/api/rh/finish' && req.method === 'POST') {
    try {
      const b = JSON.parse((await readBody(req)) || '{}');
      const raw = String(b.url || '').trim();
      const q = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1).split('#')[0] : raw);
      const code = q.get('code'), state = q.get('state');
      if (!code || !state) throw new Error(q.get('error_description') || q.get('error') || 'That link has no login code. Copy the whole address after approving on Robinhood.');
      await rh.finishAuth(code, state);
      try { await serverSync(); } catch (e) { console.error('first sync failed', e.message); }
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (url.pathname === '/api/rh/status') return json(res, 200, { connected: rh.connected(), connectedAt: rh.connectedAt(), syncedAt: (readState().rh || {}).syncedAt || null });
  if (url.pathname === '/api/rh/sync' && req.method === 'POST') {
    if (!rh.connected()) return json(res, 409, { error: 'not connected' });
    try { return json(res, 200, await serverSync()); } catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (url.pathname === '/api/rh/disconnect' && req.method === 'POST') { rh.disconnect(); return json(res, 200, { ok: true }); }
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
  if (url.pathname === '/api/rh-sync') return handleRhSync(req, res);
  if (url.pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (url.pathname.startsWith('/api/chats')) return handleChats(req, res, url);
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
