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

const page = path.join(__dirname, 'index.html');

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
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log(`Listening on ${PORT}`));
