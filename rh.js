// Direct Robinhood connection: OAuth (MCP authorization with PKCE + dynamic client
// registration), a small MCP client, a read-only tool allowlist for Ask AI, and the
// server-side sync of the Core account.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MCP_URL = 'https://agent.robinhood.com/mcp/trading';
const AS_META = 'https://agent.robinhood.com/.well-known/oauth-authorization-server';
const CORE_ACCOUNT = process.env.RH_ACCOUNT || '5PY38555';
const PROTOCOL = '2025-06-18';

// Read-only tools the site may call. Banking, credit card and every write/trade tool are excluded.
const READ_TOOLS = [
  'get_equity_positions', 'get_portfolio', 'get_equity_orders', 'get_equity_quotes',
  'get_equity_historicals', 'get_equity_fundamentals', 'get_equity_analyst_ratings',
  'get_index_quotes', 'get_index_historicals', 'get_indexes', 'get_earnings_calendar',
  'get_equity_tax_lots', 'get_realized_pnl', 'search',
];
const ACCOUNT_TOOLS = ['get_equity_positions', 'get_portfolio', 'get_equity_orders', 'get_equity_tax_lots', 'get_realized_pnl'];

module.exports = function makeRh(DATA_DIR) {
  const TOK = path.join(DATA_DIR, 'rh_tokens.json');
  const CLIENT = path.join(DATA_DIR, 'rh_client.json');
  const pending = new Map(); // state -> { verifier, redirect, at }
  let meta = null, session = null, toolsCache = null, rpcId = 1;

  const readJ = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const writeJ = (f, o) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(o), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };
  const b64u = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function getMeta() { if (!meta) meta = await (await fetch(AS_META)).json(); return meta; }

  async function getClient(redirect) {
    const c = readJ(CLIENT);
    if (c && c.redirect === redirect && c.client_id) return c;
    const m = await getMeta();
    const r = await fetch(m.registration_endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Hood Investing', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    if (!r.ok) throw new Error('Robinhood client registration failed (' + r.status + ')');
    const j = await r.json();
    const out = { client_id: j.client_id, redirect };
    writeJ(CLIENT, out);
    return out;
  }

  async function startAuth(redirect) {
    const m = await getMeta(), c = await getClient(redirect);
    const verifier = b64u(crypto.randomBytes(48));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const state = b64u(crypto.randomBytes(24));
    pending.set(state, { verifier, redirect, at: Date.now() });
    const u = new URL(m.authorization_endpoint);
    Object.entries({ response_type: 'code', client_id: c.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'internal', resource: MCP_URL })
      .forEach(([k, v]) => u.searchParams.set(k, v));
    return u.toString();
  }

  async function tokenRequest(params) {
    const m = await getMeta();
    const r = await fetch(m.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error('Robinhood token request failed (' + r.status + ')');
    return j;
  }

  async function finishAuth(code, state) {
    const p = pending.get(state); pending.delete(state);
    if (!p || Date.now() - p.at > 15 * 60e3) throw new Error('Login expired. Please try connecting again.');
    const c = await getClient(p.redirect);
    const j = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: p.redirect, client_id: c.client_id, code_verifier: p.verifier, resource: MCP_URL });
    writeJ(TOK, { access: j.access_token, refresh: j.refresh_token || null, exp: Date.now() + (j.expires_in || 3600) * 1000, client_id: c.client_id, connectedAt: new Date().toISOString() });
    session = null; toolsCache = null;
  }

  async function accessToken(force) {
    const t = readJ(TOK); if (!t) throw new Error('Robinhood is not connected');
    if (!force && Date.now() < t.exp - 60e3) return t.access;
    if (!t.refresh) throw new Error('Robinhood session expired. Please reconnect.');
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: t.client_id, resource: MCP_URL });
    Object.assign(t, { access: j.access_token, refresh: j.refresh_token || t.refresh, exp: Date.now() + (j.expires_in || 3600) * 1000 });
    writeJ(TOK, t);
    return t.access;
  }

  function parseRpc(text, ctype, id) {
    if ((ctype || '').includes('text/event-stream')) {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try { const j = JSON.parse(line.slice(5).trim()); if (j.id === id) return j; } catch (e) { /* skip */ }
      }
      throw new Error('No response from Robinhood');
    }
    return JSON.parse(text);
  }

  async function post(body, retried) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL, Authorization: 'Bearer ' + await accessToken(retried === 'auth') };
    if (session) headers['Mcp-Session-Id'] = session;
    const r = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (r.status === 401 && retried !== 'auth') return post(body, 'auth');
    if (r.status === 404 && session && retried !== 'session') { session = null; await init(); return post(body, 'session'); }
    const sid = r.headers.get('mcp-session-id'); if (sid) session = sid;
    if (body.id == null) return null;
    if (!r.ok) throw new Error('Robinhood request failed (' + r.status + ')');
    return parseRpc(await r.text(), r.headers.get('content-type'), body.id);
  }

  async function init() {
    const res = await post({ jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'hood-investing', version: '1.0' } } });
    if (res && res.error) throw new Error(res.error.message || 'Robinhood init failed');
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async function call(name, args) {
    if (!READ_TOOLS.includes(name)) throw new Error('Tool not allowed: ' + name);
    const a = Object.assign({}, args || {});
    if (ACCOUNT_TOOLS.includes(name)) a.account_number = CORE_ACCOUNT; // always the Core account
    if (!session) await init();
    const res = await post({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: a } });
    if (res.error) throw new Error(res.error.message || 'Robinhood error');
    const text = (res.result && res.result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (res.result && res.result.isError) throw new Error(text || 'Robinhood error');
    try { return JSON.parse(text); } catch (e) { return text; }
  }

  async function tools() {
    if (toolsCache) return toolsCache;
    if (!session) await init();
    const res = await post({ jsonrpc: '2.0', id: rpcId++, method: 'tools/list', params: {} });
    toolsCache = ((res.result && res.result.tools) || []).filter(t => READ_TOOLS.includes(t.name));
    return toolsCache;
  }

  // Pull the Core account and return the payload shape that /api/rh-sync expects.
  async function syncPayload() {
    const [pos, port] = await Promise.all([call('get_equity_positions', {}), call('get_portfolio', {})]);
    const since = new Date(Date.now() - 35 * 864e5).toISOString().slice(0, 10);
    const orders = []; let cursor;
    for (let i = 0; i < 10; i++) {
      const r = await call('get_equity_orders', Object.assign({ placed_agent: 'recurring', created_at_gte: since }, cursor ? { cursor } : {}));
      const d = (r && r.data) || {};
      (d.orders || []).forEach(o => orders.push({ date: String(o.created_at).slice(0, 10), symbol: o.symbol, side: o.side, state: o.state,
        amount: +(o.dollar_based_amount && o.dollar_based_amount.amount) || 0, price: +o.average_price || null, shares: +o.cumulative_quantity || null }));
      cursor = d.next; if (!cursor) break;
    }
    const positions = (((pos && pos.data) || {}).positions || []).map(p => ({ symbol: p.symbol, quantity: p.quantity, average_buy_price: p.average_buy_price }));
    const cash = +((port && port.data) || {}).cash || 0;
    return { account: CORE_ACCOUNT, positions, cash, orders };
  }

  return {
    connected: () => !!readJ(TOK),
    connectedAt: () => (readJ(TOK) || {}).connectedAt || null,
    disconnect: () => { try { fs.unlinkSync(TOK); } catch (e) { /* none */ } session = null; toolsCache = null; },
    startAuth, finishAuth, call, tools, syncPayload, READ_TOOLS,
  };
};
