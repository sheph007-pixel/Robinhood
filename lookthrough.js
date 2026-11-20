// Look-through of the funds the account holds: every company inside VTI and VXUS (Vanguard's
// published holdings, refreshed monthly), with sector, industry and size from Robinhood.
// Weights are fractions of each fund; the page scales them by what the user holds.
const VG = s => `https://investor.vanguard.com/vmf/api/${s}/portfolio-holding/stock.json`;
const FUNDS = ['VTI', 'VXUS'];
const SECTOR_N = 200;          // largest US companies sent to Robinhood for sector/size (~80% of VTI)
const DAY = 864e5;

async function vgPage(sym, start) {
  const r = await fetch(VG(sym) + (start > 1 ? `?start=${start}&count=500` : ''), { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('vanguard ' + r.status);
  return r.json();
}
async function vgHoldings(sym) {
  const first = await vgPage(sym, 1), size = +first.size || 0, rows = [...first.fund.entity];
  const starts = []; for (let s = 501; s <= size; s += 500) starts.push(s);
  for (let i = 0; i < starts.length; i += 5) {
    const pages = await Promise.all(starts.slice(i, i + 5).map(s => vgPage(sym, s)));
    pages.forEach(p => rows.push(...p.fund.entity));
  }
  return { asOf: String(first.asOfDate || '').slice(0, 10), size, rows };
}
const company = n => String(n || '').replace(/\s+Class\s+[A-Z]\b.*$/i, '').replace(/\s+(Cl|Series)\s+[A-Z]$/i, '').trim();
const rhSym = t => String(t || '').trim().replace(/\s+/g, '.');
const SIZE = [['Mega', 200e9], ['Large', 10e9], ['Mid', 2e9], ['Small', 0]];
const band = cap => SIZE.find(b => cap >= b[1])[0];

async function rhFundamentals(rh, syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 20) {
    try {
      const r = await rh.call('get_equity_fundamentals', { symbols: syms.slice(i, i + 20) });
      ((r && r.data && r.data.results) || []).forEach(x => { out[x.symbol] = x; });
    } catch (e) { console.log('lookthrough fundamentals', e.message); }
  }
  return out;
}

async function build(rh) {
  const connected = rh && rh.connected();
  const raw = {}; for (const s of FUNDS) raw[s] = await vgHoldings(s);
  // Robinhood: fund-level valuation plus sector/industry/market cap for the biggest US companies.
  const vti = raw.VTI.rows.slice().sort((a, b) => b.marketValue - a.marketValue);
  const syms = [...new Set(vti.slice(0, SECTOR_N).map(h => rhSym(h.ticker)).filter(Boolean))];
  const F = connected ? await rhFundamentals(rh, ['VTI', 'VXUS', 'ASML', ...syms]) : {};
  const funds = {};
  for (const s of FUNDS) {
    const rows = raw[s].rows.filter(h => h.marketValue > 0), tot = rows.reduce((a, h) => a + h.marketValue, 0);
    const byCo = new Map(), countries = {}, sectors = {}, industries = {}, size = {};
    let hh = 0, secCov = 0;
    // Scale from "dollars this fund holds" to "company market cap", calibrated on companies Robinhood priced.
    const ratios = [];
    rows.forEach(h => { const f = F[rhSym(h.ticker)]; if (f && +f.market_cap > 0 && (s === 'VTI' ? (h.isin || '').startsWith('US') : h.ticker === 'ASML')) ratios.push(+f.market_cap / h.marketValue); });
    ratios.sort((a, b) => a - b); const k = ratios.length ? ratios[ratios.length >> 1] : null;
    rows.forEach(h => {
      const w = h.marketValue / tot, name = company(h.longName), c = (h.isin || '??').slice(0, 2);
      const e = byCo.get(name) || { name, ticker: h.ticker, w: 0 }; e.w += w; byCo.set(name, e);
      const cc = s === 'VTI' ? 'US' : c; countries[cc] = (countries[cc] || 0) + w;
      const f = s === 'VTI' ? F[rhSym(h.ticker)] : null;
      if (f && f.sector && f.sector !== 'Miscellaneous') { secCov += w; sectors[f.sector] = (sectors[f.sector] || 0) + w; if (f.industry) industries[f.industry] = (industries[f.industry] || 0) + w; }
      const cap = f && +f.market_cap > 0 ? +f.market_cap : k ? h.marketValue * k : null;
      if (cap) size[band(cap)] = (size[band(cap)] || 0) + w;
    });
    byCo.forEach(e => { hh += e.w * e.w; });
    const norm = (o, d) => { const r = {}; Object.keys(o).forEach(x => { r[x] = o[x] / d; }); return r; };
    const fv = F[s] || {};
    funds[s] = {
      asOf: raw[s].asOf, count: byCo.size, hh,
      top: [...byCo.values()].sort((a, b) => b.w - a.w).slice(0, 40),
      countries, sectors: secCov ? norm(sectors, secCov) : null, sectorCoverage: secCov,
      industries: secCov ? Object.entries(norm(industries, secCov)).sort((a, b) => b[1] - a[1]).slice(0, 12) : null,
      size: Object.keys(size).length ? norm(size, Object.values(size).reduce((a, b) => a + b, 0)) : null,
      pe: +fv.pe_ratio || null, pb: +fv.pb_ratio || null, dy: +fv.dividend_yield || null,
    };
  }
  return { at: Date.now(), robinhood: !!connected, funds };
}

module.exports = function makeLookthrough(rh, fs, file) {
  let mem = null, inflight = null;
  try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* none yet */ }
  return async function get() {
    if (mem && Date.now() - mem.at < DAY && (mem.robinhood || !rh.connected())) return mem;
    if (!inflight) inflight = build(rh).then(d => { mem = d; try { fs.writeFileSync(file, JSON.stringify(d)); } catch (e) { /* ignore */ } return d; }).finally(() => { inflight = null; });
    try { return await inflight; } catch (e) { if (mem) return mem; throw e; }
  };
};
