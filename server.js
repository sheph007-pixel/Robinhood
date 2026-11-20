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
// Haiku 5.5: plenty for a personal portfolio chat and ~40x cheaper than Opus. Override with AI_MODEL.
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const AI_SYSTEM = `You are the owner's personal financial advisor inside their investing app: think and talk like an experienced CFA and CFP who designed this plan with them and now runs it for them, all inside their Robinhood account. (You are an AI; never claim to be a person or to hold licenses.)

The plan you run together: VTI (the whole US stock market), VXUS (stocks outside the US) and a cash bucket, built up with automatic buys every market day and held for the long run. The app exists to keep the focus on the long run, not daily noise.

How you talk:
- Like a trusted advisor talking with a client they know well: warm, direct, plain English. Say "your plan", "we", "your daily buys".
- No jargon. Say "stocks outside the US" not "ex-US equities", "the ups and downs" not "volatility", "spreading out your buys" not "dollar-cost averaging". If a technical term is truly needed, explain it in a few words.
- Lead with the answer, then the why in a sentence or two, then what it means for them. Short paragraphs; bullets only when they help.
- Round sensibly ($1.28M, $54,180) and do the math carefully.
- Never narrate your process ("let me check", "based on my search", "I didn't verify") and never mention tools. Mention a source only if asked.
- Calm and long-term. Put drops in context; never encourage timing the market or trading on headlines.
- Be a real advisor, not a yes-man. Your job is what is best for them, not agreeing with them. If an idea works against their plan or goal (chasing a hot stock, pausing buys after a drop, piling into cash, an unrealistic goal), say so plainly and kindly, explain why, and offer a better option.
- Keep the plan current. Use the snapshot and today's market to check whether the plan still fits: the mix versus targets, the cash level and what it earns, whether the daily buys are on pace for the goal, and big shifts in rates or valuations that matter for the long run. When something should change, recommend the specific change (e.g. "raise daily VXUS to $1,200", "move the goal age to 58") and why. When nothing needs to change, say the plan is on track and why staying the course is right.
- If you notice something in the snapshot that needs attention, mention it briefly even if they didn't ask.
- Have a real conversation. Don't repeat numbers, facts or points you already made earlier in this chat unless they ask again; build on what was said and move it forward. Vary how you say things. Only bring up a number when it matters to the question.
- You remember the client. Their saved notes come with every request: follow standing instructions there exactly (e.g. never bring up a topic they asked you to drop), use what you know about their goals and life, and don't ask again for things you already know. When they tell you something lasting (goals, timeline, family or job changes, preferences, how they want you to work, decisions you agree on), save it with memory_save without announcing it; if they say "remember", "don't talk about", "from now on" or similar, save it and briefly confirm. Update or remove notes that change (memory_forget). Never save daily prices or balances.
- Get to know them like a real advisor building a long relationship. Use their name once you know it. If your notes are missing basics (their name, spouse or partner, kids and ages, job and income stability, when and how they want to retire, other accounts or a home, big upcoming expenses, how they'd react to a big market drop), ask about one of them when it fits naturally (never a questionnaire, never more than one at a time) and save the answer with memory_save.
- Ask questions like a good advisor would: when the answer depends on something you don't know (their timeline, income changes, risk comfort, big upcoming expenses, what's behind the question), ask one short, specific question. End with a question only when it genuinely helps, not every time.
- Give clear, practical recommendations when asked (how to split new money, whether the cash level fits their targets) with the reasoning. Mention big trade-offs briefly. Add a short "check with a tax pro/attorney" note only for taxes, legal questions or major life decisions.

Facts (get them before answering):
- Every request includes a live snapshot from their Robinhood Core account: holdings, prices, average cost, cash, targets, recurring buys, goal and projections. Use it directly for anything it covers; no lookup needed.
- For fresher or deeper account or market data use the robinhood tool first (get_index_quotes for the S&P 500, Nasdaq and Dow; get_equity_quotes; historicals; orders; fundamentals; analyst ratings; earnings), and get_quotes / get_price_history for anything Robinhood doesn't cover (VIX, 10-year yield, 200-day average).
- Use web search only for the news behind a move ("why") or current expert views, once, then answer.
- For "why did the market move": how much it moved (from the data), the main reasons (from the news), what it means for their plan.
- Only the Core account is used, and margin is intentionally ignored.`;
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
// ---------- advisor memory: durable notes the AI keeps about the client across all chats ----------
const memFile = () => path.join(DATA_DIR, 'memory.json');
function readMemory() { try { return JSON.parse(fs.readFileSync(memFile(), 'utf8')); } catch (e) { return { notes: [] }; } }
function writeMemory(m) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(memFile() + '.tmp', JSON.stringify(m)); fs.renameSync(memFile() + '.tmp', memFile()); }
function memoryText() {
  const n = readMemory().notes; if (!n.length) return 'What you know about the client from past conversations: nothing saved yet.';
  return 'What you know about the client from past conversations (follow any instructions here; use the ids with memory_forget):\n' + n.map(x => '- [' + x.id + '] ' + x.text + ' (' + x.at.slice(0, 10) + ')').join('\n');
}
const MEMORY_TOOLS = [
  { name: 'memory_save', description: 'Save a durable note about the client for all future conversations: their goals and timeline, life events, preferences, how they want you to talk, topics to avoid, decisions you made together, and standing instructions ("don\'t bring up X again", "always show amounts in thousands"). Save when they tell you something lasting or give an instruction. Do not save prices, balances or other numbers that change daily. Write it as one short clear sentence. If it updates an existing note, forget the old one first.', strict: true,
    input_schema: { type: 'object', properties: { note: { type: 'string', description: 'One short sentence, e.g. "Prefers not to discuss crypto." or "Plans to retire at 58 and move to Florida."' } }, required: ['note'], additionalProperties: false } },
  { name: 'memory_forget', description: 'Delete a saved note that is wrong, outdated or that the client asks you to forget. Use the id shown in brackets.', strict: true,
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } },
];
function memoryTool(name, input) {
  const m = readMemory();
  if (name === 'memory_save') {
    const text = String(input.note || '').replace(/\s+/g, ' ').trim().slice(0, 300); if (!text) throw new Error('empty note');
    if (m.notes.some(x => x.text.toLowerCase() === text.toLowerCase())) return { ok: true, note: 'already saved' };
    const note = { id: crypto.randomBytes(3).toString('hex'), text, at: new Date().toISOString() };
    m.notes.push(note); if (m.notes.length > 80) m.notes = m.notes.slice(-80); writeMemory(m); console.log('memory saved'); return { ok: true, id: note.id };
  }
  if (name === 'memory_forget') { const before = m.notes.length; m.notes = m.notes.filter(x => x.id !== String(input.id)); writeMemory(m); console.log('memory forgot'); return { ok: m.notes.length < before }; }
  throw new Error('unknown memory tool');
}
async function runAiTool(name, input) {
  if (name === 'memory_save' || name === 'memory_forget') return memoryTool(name, input);
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

const VOICE_NOTE = '\n\nThis turn is a live voice conversation. Talk like a real person on a phone call with a client you know well: relaxed, warm, natural, 1 to 3 short sentences. Make the first sentence very short. No markdown, lists, symbols or jargon; say amounts the way people say them ("about 1.3 million", "two thousand a day"). Answer from the snapshot whenever it covers the question; look things up only for news or data it does not have. When you use a tool, you may say a brief sentence first.';
// Live market snapshot added to every AI request so most questions need no tool round trip (cached 60s).
const MKT_SYMS = [['^GSPC', 'S&P 500'], ['^IXIC', 'Nasdaq'], ['^DJI', 'Dow'], ['^VIX', 'VIX (fear gauge)'], ['^TNX', '10-year Treasury yield (x10)'], ['VTI', 'VTI'], ['VXUS', 'VXUS']];
let mktCache = { at: 0, text: '' };
async function marketSnapshot() {
  if (mktCache.text && Date.now() - mktCache.at < 60e3) return mktCache.text;
  const rows = await Promise.all(MKT_SYMS.map(async ([sym, label]) => { try { const q = await yahoo(sym);
    return label + ': ' + (+q.price).toFixed(2) + (q.changePct != null ? ' (' + (q.changePct >= 0 ? '+' : '') + q.changePct.toFixed(2) + '% today' : '') + (q.high52 ? ', ' + ((1 - q.price / q.high52) * 100).toFixed(1) + '% below 52-week high' : '') + (q.changePct != null ? ')' : ''); } catch (e) { return null; } }));
  const text = 'Live market (as of ' + new Date().toUTCString() + '): ' + rows.filter(Boolean).join('; ');
  mktCache = { at: Date.now(), text }; return text;
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
  const context = String(body.context || '').slice(0, 20000), voice = !!body.voice, t0 = Date.now(); let firstAt = 0, rounds = 0;
  const mkt = await Promise.race([marketSnapshot(), new Promise(r => setTimeout(() => r(''), 1500))]).catch(() => '');
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  try {
    for (let round = 0; round < 8; round++) {
      const stream = client.messages.stream({
        model: AI_MODEL,
        max_tokens: 16000,
        output_config: { effort: voice ? 'low' : 'medium' },
        ...(voice && /haiku/.test(AI_MODEL) ? { thinking: { type: 'disabled' } } : {}), // voice: skip thinking so it starts talking sooner
        system: [
          { type: 'text', text: AI_SYSTEM, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: memoryText() + '\n\nLive portfolio snapshot (synced from the Robinhood Core account):\n' + context, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: 'Today is ' + new Date().toUTCString() + '.\n' + mkt + (voice ? VOICE_NOTE : '') },
        ],
        tools: [...AI_TOOLS, ...MEMORY_TOOLS, ...(rh.connected() ? [RH_TOOL] : []), { type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
        messages,
      });
      rounds++; stream.on('text', (t) => { if (!firstAt) firstAt = Date.now(); res.write(t); });
      stream.on('streamEvent', (ev) => {
        if (ev.type === 'content_block_start' && ev.content_block) {
          if (ev.content_block.type === 'server_tool_use') res.write('\u0000S');
          if (ev.content_block.type === 'tool_use' && !/^memory_/.test(ev.content_block.name)) res.write(ev.content_block.name === 'robinhood' ? '\u0000R' : '\u0000Q');
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
  console.log('chat timing', voice ? 'voice' : 'text', 'first word ' + (firstAt ? firstAt - t0 : -1) + 'ms', 'total ' + (Date.now() - t0) + 'ms', 'rounds ' + rounds);
  res.end();
}
// Each view fetches extra history so a 200-day moving average is complete from the first visible point.
// A number means 'that many years back' via period1: Yahoo quietly turns range=max into monthly points even when weekly/daily is asked for.
const HIST_RANGES = { '1y': ['2y', '1d'], '5y': ['10y', '1wk'], '10y': [11, '1wk'], '15y': [16, '1wk'], '20y': [21, '1wk'], 'max': ['max', '1mo'] };
const ySpan = v => typeof v === 'number' ? `period1=${Math.floor(Date.now() / 1000 - v * 365.25 * 86400)}&period2=${Math.floor(Date.now() / 1000)}` : `range=${v}`;
const histCache = new Map();
async function history(sym, rng) {
  const key = sym + rng + 'v3', hit = histCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?${ySpan(HIST_RANGES[rng][0])}&interval=${HIST_RANGES[rng][1]}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = (await r.json()).chart.result[0], t = [], c = [];
  j.timestamp.forEach((ts, i) => { const v = j.indicators.quote[0].close[i]; if (v != null) { t.push(ts * 1000); c.push(Math.round(v * 100) / 100); } });
  let dd = null; try { dd = await drawdowns(sym); } catch (e) { /* chart still works without markers */ }
  const data = { symbol: sym, range: rng, t, c, dd };
  histCache.set(key, { at: Date.now(), data });
  return data;
}
// 10%+ drops from the running high, found once on DAILY closes over the fund's whole history, so every
// chart range (daily, weekly or monthly points) shows the same drops with the same depth.
const ddCache = new Map();
async function drawdowns(sym) {
  const hit = ddCache.get(sym); if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=0&period2=${Math.floor(Date.now() / 1000)}&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const j = (await r.json()).chart.result[0], q = j.indicators.quote[0].close, out = [];
  let pk = -1, pt = 0, ep = null;
  j.timestamp.forEach((ts, i) => { const v = q[i]; if (v == null) return; const t = ts * 1000;
    if (v >= pk) { if (ep) { ep.end = t; out.push(ep); ep = null; } pk = v; pt = t; return; }
    const d = v / pk - 1;
    if (!ep && d <= -0.1) ep = { peak: pt, hit: t, trough: t, depth: Math.round(d * 1000) / 1000, end: null };
    if (ep && d < ep.depth) { ep.depth = Math.round(d * 1000) / 1000; ep.trough = t; } });
  if (ep) out.push(ep);
  ddCache.set(sym, { at: Date.now(), data: out });
  return out;
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
let nwTimer = null;
function writeState(obj) { fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = STATE_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, STATE_FILE);
  clearTimeout(nwTimer); nwTimer = setTimeout(() => recordNetWorth(), 1500); } // keep today's net worth current after edits and syncs
const NYSE_HOLIDAYS = new Set(['2026-01-01','2026-01-19','2026-02-16','2026-04-03','2026-05-25','2026-06-19','2026-07-03','2026-09-07','2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26','2027-05-31','2027-06-18','2027-07-05','2027-09-06','2027-11-25','2027-12-24',
  '2028-01-17','2028-02-21','2028-04-14','2028-05-29','2028-06-19','2028-07-04','2028-09-04','2028-11-23','2028-12-25']);
// Latest market day whose recurring buys should already have happened (they're placed around 11:20 AM ET).
function expectedBuyDay() {
  const et = s => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(s);
  const hm = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date()).split(':');
  let d = new Date(), first = true;
  for (let k = 0; k < 10; k++, first = false, d = new Date(d.getTime() - 864e5)) {
    const day = et(d), wd = new Date(day + 'T12:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6 || NYSE_HOLIDAYS.has(day)) continue;
    if (first && (+hm[0] % 24) * 60 + +hm[1] < 12 * 60 + 30) continue; // today's buys not due yet
    return day;
  }
  return '0000-00-00';
}
function summarizeRecurring(orders) {
  const filled = orders.filter(o => o && o.side === 'buy' && (o.state === 'filled' || !o.state) && +o.amount > 0 && o.date)
    .map(o => ({ symbol: String(o.symbol).toUpperCase(), amount: +o.amount, date: String(o.date).slice(0, 10), price: +o.price || null, shares: +o.shares || null }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const recurring = [];
  for (const sym of [...new Set(filled.map(o => o.symbol))]) {
    const mine = filled.filter(o => o.symbol === sym), last = mine[0].date;
    // Current schedule = what all recurring orders bought on the latest day (picks up increases right away).
    const amount = mine.filter(o => o.date === last).reduce((s, o) => s + o.amount, 0);
    const days = new Set(mine.filter(o => (Date.parse(last) - Date.parse(o.date)) <= 14 * 864e5).map(o => o.date)).size;
    const freq = days >= 6 ? 'daily' : days >= 2 ? 'weekly' : 'monthly';
    const perMonth = amount * (freq === 'daily' ? 21 : freq === 'weekly' ? 4.33 : 1);
    const last30 = mine.filter(o => (Date.now() - Date.parse(o.date)) <= 30 * 864e5).reduce((s, o) => s + o.amount, 0);
    recurring.push({ symbol: sym, amount: Math.round(amount * 100) / 100, freq, perMonth: Math.round(perMonth), lastDate: last, last30: Math.round(last30) });
  }
  const days30 = new Set(filled.filter(o => (Date.now() - Date.parse(o.date)) <= 30 * 864e5).map(o => o.date)).size;
  const invested30 = Math.round(filled.filter(o => (Date.now() - Date.parse(o.date)) <= 30 * 864e5).reduce((s, o) => s + o.amount, 0));
  // Streak: consecutive buy days back from the latest one; gaps of up to 4 calendar days (weekends, holidays) don't break it.
  const dates = [...new Set(filled.map(o => o.date))].sort().reverse(); let streak = 0;
  if (dates.length && (Date.now() - Date.parse(dates[0])) <= 5 * 864e5) { streak = 1; for (let i = 1; i < dates.length && (Date.parse(dates[i - 1]) - Date.parse(dates[i])) <= 4 * 864e5; i++) streak++; }
  const streakAll = streak > 0 && streak === dates.length; // reaches the start of the synced history
  // A schedule changed or paused in Robinhood can't be read directly, only the orders it creates. If the most
  // recent market day has passed its buy time with no order, treat that recurring buy as stopped.
  const exp = expectedBuyDay();
  for (const r of recurring) if (r.lastDate < exp) { r.stopped = true; r.freq = 'stopped'; r.perMonth = 0; }
  const yr = String(new Date().getUTCFullYear());
  const buys = filled.filter(o => o.date.startsWith(yr)).map(o => ({ d: o.date, s: o.symbol, a: Math.round(o.amount * 100) / 100, p: o.price ? Math.round(o.price * 100) / 100 : null }));
  return { recurring, recent: filled.slice(0, 20), days30, invested30, streak, streakAll, buys };
}
function applySync(b) {
  const st = readState(), pos = Array.isArray(b.positions) ? b.positions : [];
  const q = sym => { const p = pos.find(x => String(x.symbol).toUpperCase() === sym); return p ? +p.quantity : 0; };
  st.shVTI = q('VTI'); st.shVXUS = q('VXUS');
  const ac = sym => { const p = pos.find(x => String(x.symbol).toUpperCase() === sym); return p && +p.average_buy_price ? +p.average_buy_price : null; };
  st.avgCost = { VTI: ac('VTI'), VXUS: ac('VXUS') };
  if (b.cash != null && isFinite(+b.cash)) st.cash = Math.max(0, Math.round(+b.cash * 100) / 100);
  const r = summarizeRecurring(Array.isArray(b.orders) ? b.orders : []);
  st.rh = { account: String(b.account || '').slice(-4), syncedAt: new Date().toISOString(), recurring: r.recurring, recent: r.recent, days30: r.days30, invested30: r.invested30, streak: r.streak, streakAll: r.streakAll, buys: r.buys };
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
const lookthrough = require('./lookthrough')(rh, fs, path.join(DATA_DIR, 'lookthrough.json'));
// ---------- Markets: AI daily brief (cached; at most a few generations per day) ----------
const BRIEF_FILE = path.join(DATA_DIR, 'brief.json');
const BRIEF_SYSTEM = `You write a short daily market brief inside a personal long-term investing app. The owner holds VTI (US total market) and VXUS (international) and buys both every market day; the app exists to keep them focused on the long run, not daily noise.
Use the tools: pull today's numbers first (robinhood get_index_quotes / get_equity_quotes when available, and get_quotes for VTI, VXUS, ^GSPC, ^IXIC, ^DJI, ^VIX, ^TNX), then one or two web searches for today's market news and current strategist views. Do not invent numbers or quotes.
Write markdown with exactly these sections, each 1-3 short sentences, about 170 words in total:
**Today** - one line: how VTI and VXUS closed (or are trading) with % moves, and the S&P 500.
**Why VTI Moved** - the main US drivers today.
**Why VXUS Moved** - the main international drivers (Europe, Japan, emerging markets, the dollar).
**What to Expect** - the next scheduled catalysts (data releases, Fed, earnings) in the coming days.
**What Experts Think** - the range of current strategist/economist views, attributed to firms where the source names them.
**For You** - one calm sentence tying it to their daily buys and long horizon.
No preamble, no disclaimers, no tables.`;
function etNow() { const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date()), g = t => (p.find(x => x.type === t) || {}).value;
  return { date: g('year') + '-' + g('month') + '-' + g('day'), min: (+g('hour') % 24) * 60 + +g('minute'), wd: g('weekday') }; }
let briefJob = null;
async function makeBrief(phase) {
  const client = aiClient(); if (!client) throw new Error('no_key');
  const q = await quotes().catch(() => ({}));
  const messages = [{ role: 'user', content: memoryText() + '\n\nWrite the ' + (phase === 'close' ? 'end-of-day' : phase === 'open' ? 'midday' : 'latest') + ' brief. Today (US Eastern) is ' + etNow().date + '. Site quote snapshot: ' + JSON.stringify(q).slice(0, 2000) }];
  for (let round = 0; round < 8; round++) {
    const msg = await client.messages.create({ model: AI_MODEL, max_tokens: 4000, output_config: { effort: 'low' }, system: BRIEF_SYSTEM,
      tools: [...AI_TOOLS, ...(rh.connected() ? [RH_TOOL] : []), { type: 'web_search_20250305', name: 'web_search', max_uses: 2 }], messages });
    if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
    if (msg.stop_reason === 'tool_use') {
      const results = [];
      for (const blk of msg.content.filter(c => c.type === 'tool_use')) {
        let out, isErr = false; try { out = await runAiTool(blk.name, blk.input || {}); } catch (e) { out = { error: String(e && e.message || e) }; isErr = true; }
        results.push({ type: 'tool_result', tool_use_id: blk.id, content: JSON.stringify(out), is_error: isErr });
      }
      messages.push({ role: 'assistant', content: msg.content }, { role: 'user', content: results }); continue;
    }
    const text = msg.content.filter(c => c.type === 'text').map(c => c.text).join('').trim();
    if (!text || msg.stop_reason === 'refusal') throw new Error('empty brief');
    return text;
  }
  throw new Error('brief took too many steps');
}
async function getBrief(force) {
  const et = etNow(), weekend = et.wd === 'Sat' || et.wd === 'Sun';
  const phase = weekend ? 'weekend' : et.min >= 16 * 60 + 10 ? 'close' : et.min >= 9 * 60 + 30 ? 'open' : 'pre';
  let b = null; try { b = JSON.parse(fs.readFileSync(BRIEF_FILE, 'utf8')); } catch (e) { /* none */ }
  const age = b ? Date.now() - Date.parse(b.at) : Infinity;
  const fresh = b && (
    (phase === 'close' && b.date === et.date && b.phase === 'close') ||
    (phase === 'open' && b.date === et.date && age < 2 * 3600e3) ||
    ((phase === 'pre' || phase === 'weekend') && age < 12 * 3600e3));
  if (fresh && !(force && age > 15 * 60e3)) return b;
  if (!briefJob) briefJob = makeBrief(phase).then(text => {
    const nb = { text, at: new Date().toISOString(), date: et.date, phase }; fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BRIEF_FILE, JSON.stringify(nb)); return nb;
  }).finally(() => { briefJob = null; });
  try { return await briefJob; } catch (e) { if (b) return Object.assign({ stale: true }, b); throw e; }
}
// ---------- speech-to-text for voice mode where the browser can't (iPhone home-screen apps) ----------
function sttKey() { // OpenAI key for voice: OPENAI_API_KEY, CHATGPT, or any variable holding an OpenAI-style key
  const named = process.env.OPENAI_API_KEY || process.env.CHATGPT || process.env.CHATGPT_API_KEY || process.env.OPENAI_KEY;
  if (named && named.trim()) return named.trim();
  for (const v of Object.values(process.env)) if (typeof v === 'string' && /^\s*sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}/.test(v) && !/^\s*sk-ant-/.test(v)) return v.trim();
  return null; }
function readRaw(req, limit) {
  return new Promise((resolve, reject) => { const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts))); req.on('error', reject); });
}
async function handleStt(req, res) {
  const key = sttKey(); if (!key) return json(res, 503, { error: 'no_stt_key' });
  const ts = Date.now(); let audio; try { audio = await readRaw(req, 10 * 1024 * 1024); } catch (e) { return json(res, 413, { error: 'too large' }); }
  if (!audio.length) return json(res, 400, { error: 'empty' });
  const type = String(req.headers['content-type'] || 'audio/mp4').split(';')[0];
  const ext = type.includes('webm') ? 'webm' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'm4a';
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type }), 'speech.' + ext);
  fd.append('model', process.env.STT_MODEL || 'gpt-4o-mini-transcribe');
  fd.append('language', 'en');
  fd.append('prompt', 'Investing conversation about VTI, VXUS, Robinhood, the S&P 500, dollar-cost averaging and retirement.');
  try {
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('stt error', r.status, j && j.error && j.error.message); return json(res, 502, { error: 'stt failed' }); }
    console.log('stt timing ' + (Date.now() - ts) + 'ms', audio.length + ' bytes');
    return json(res, 200, { text: String(j.text || '').trim() });
  } catch (e) { console.error('stt error', e.message); return json(res, 502, { error: 'stt failed' }); }
}
// Natural-sounding speech for voice mode (plays reliably on iPhone, unlike the browser's built-in voice).
// Natural-sounding speech for voice mode, streamed so playback starts while audio is still being made.
const TTS_INSTRUCTIONS = 'American male voice. A trusted financial advisor on a relaxed phone call with a longtime client: calm, warm, natural and easygoing, with normal conversational rhythm. Brisk pace, slightly faster than normal, no long pauses, never robotic or announcer-like.';
let ttsVoiceBad = new Set();
async function handleTts(req, res, url) {
  const key = sttKey(); if (!key) return json(res, 503, { error: 'no_tts_key' });
  let text = url.searchParams.get('t');
  if (req.method === 'POST') { try { text = JSON.parse(await readBody(req, 8 * 1024)).text; } catch (e) { return json(res, 400, { error: 'bad data' }); } }
  const input = String(text || '').slice(0, 800).trim(); if (!input) return json(res, 400, { error: 'empty' }); const tt = Date.now();
  const voices = [process.env.TTS_VOICE || 'cedar', 'ash'].filter((v, k, a) => a.indexOf(v) === k && !ttsVoiceBad.has(v));
  try {
    for (const voice of voices) {
      const r = await fetch('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.TTS_MODEL || 'gpt-4o-mini-tts', voice, input, response_format: 'mp3', instructions: TTS_INSTRUCTIONS }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); console.error('tts error', voice, r.status, j && j.error && j.error.message);
        if (r.status === 400 && voice !== 'ash') { ttsVoiceBad.add(voice); continue; } return json(res, 502, { error: 'tts failed' }); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
      let first = true; const rd = r.body.getReader();
      for (;;) { const { value, done } = await rd.read(); if (done) break; if (first) { first = false; console.log('tts timing first audio ' + (Date.now() - tt) + 'ms', voice, input.length + ' chars'); } res.write(Buffer.from(value)); }
      return res.end();
    }
    return json(res, 502, { error: 'tts failed' });
  } catch (e) { console.error('tts error', e.message); if (!res.headersSent) return json(res, 502, { error: 'tts failed' }); res.end(); }
}
// ---------- net worth history: one snapshot per day (Robinhood value at live prices + accounts added by hand) ----------
const nwFile = () => path.join(DATA_DIR, 'networth.json');
function readNW() { try { return JSON.parse(fs.readFileSync(nwFile(), 'utf8')); } catch (e) { return { history: [] }; } }
async function recordNetWorth() {
  try {
    const st = readState(); const q = await quotes();
    const pv = s => (q[s] && q[s].price) || (st.px && st.px[s]) || 0;
    const rh = (+st.shVTI || 0) * pv('VTI') + (+st.shVXUS || 0) * pv('VXUS') + (+st.cash || 0);
    const other = (Array.isArray(st.accts) ? st.accts : []).reduce((t, a) => t + (+a.amt || 0), 0);
    if (!(rh + other > 0)) return;
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const nw = readNW(); const row = { d, v: Math.round(rh + other), rh: Math.round(rh), other: Math.round(other) };
    const k = nw.history.findIndex(x => x.d === d); if (k >= 0) nw.history[k] = row; else nw.history.push(row);
    nw.history.sort((a, b) => a.d.localeCompare(b.d)); if (nw.history.length > 4000) nw.history = nw.history.slice(-4000);
    fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(nwFile() + '.tmp', JSON.stringify(nw)); fs.renameSync(nwFile() + '.tmp', nwFile());
  } catch (e) { console.error('net worth snapshot failed', e.message); }
}
setTimeout(recordNetWorth, 15e3); setInterval(recordNetWorth, 30 * 60e3);
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
// Version = 1.<number of the PR that was deployed>, from Railway's build metadata.
const VERSION = (() => {
  const msg = process.env.RAILWAY_GIT_COMMIT_MESSAGE || '', sha = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7);
  const pr = (msg.split('\n')[0].match(/\(#(\d+)\)/) || [])[1];
  return { version: pr ? 'v1.' + pr : (sha ? 'dev' : 'local'), sha };
})();
const RH_LOCAL_REDIRECT = 'http://localhost:8765/callback';
const baseUrl = req => (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/version') return json(res, 200, VERSION);
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
  if (url.pathname === '/api/networth') return json(res, 200, readNW());
  if (url.pathname === '/api/memory' && req.method === 'GET') return json(res, 200, readMemory());
  if (url.pathname.startsWith('/api/memory/') && req.method === 'DELETE') { const id = url.pathname.slice(12); const m = readMemory(); m.notes = m.notes.filter(x => x.id !== id); writeMemory(m); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/brief') {
    try { return json(res, 200, await getBrief(url.searchParams.get('force') === '1')); }
    catch (e) { console.error('brief error', e && e.status, e && e.message); return json(res, e.message === 'no_key' ? 503 : 502, { error: 'unavailable' }); }
  }
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  if (url.pathname === '/api/state') return handleState(req, res);
  if (url.pathname === '/api/rh-sync') return handleRhSync(req, res);
  if (url.pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  if (url.pathname.startsWith('/api/chats')) return handleChats(req, res, url);
  if (url.pathname === '/api/chat/status') return json(res, 200, { ready: !!aiKey(), model: AI_MODEL, stt: !!sttKey(), tts: !!sttKey() });
  if (url.pathname === '/api/stt' && req.method === 'POST') return handleStt(req, res);
  if (url.pathname === '/api/tts' && (req.method === 'POST' || req.method === 'GET')) return handleTts(req, res, url);
  if (url.pathname === '/api/lookthrough') {
    try { return json(res, 200, await lookthrough()); }
    catch (e) { console.error('lookthrough', e.message); return json(res, 502, { error: 'holdings data unavailable' }); }
  }
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
});
server.listen(PORT, () => console.log(`Listening on ${PORT}`));

// Railway sends SIGTERM to the old container on every redeploy. Exit cleanly (code 0)
// so it isn't reported as a crash.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
