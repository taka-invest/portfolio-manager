// Market data providers chosen in docs/research/DATA_SOURCE_MIGRATION.md (plan B, 2026-11-27):
//   - latest quote for US stocks/ETFs: Finnhub /quote (free, personal use)
//   - daily bars: Massive (formerly Polygon) free tier - end of day, last 2 years, 5 calls/min
//   - VIX / VXN / SPX index / USD-JPY: no free source that allows this use -> "unavailable"
// Output keeps the Yahoo-chart-compatible shape the screens already read, plus explicit
// source / proxy / truncation metadata so a shortened or substituted series is never silent.
import { getJson } from '../sec-gateway.js';

const MASSIVE = 'https://api.massive.com';
const FINNHUB = 'https://finnhub.io/api/v1';
export const HISTORY_DAYS = 730;                 // Massive free tier: 2 years
const DAY = 86400000;

/** Symbols the screens ask for that are mapped or unavailable on the free plan. */
export const INDEX = { '^NDX': 'I:NDX', '^IXIC': 'I:COMP' };
export const PROXY = { '^GSPC': 'SPY' };
export const UNAVAILABLE = new Set(['^VIX', '^VXN', 'JPY=X', '^DJI', '^RUT']);

const RANGE_DAYS = { '1d': 1, '5d': 7, '1mo': 31, '3mo': 92, '6mo': 183, '1y': 366, '2y': 731, '5y': 1827, '10y': 3653 };
const iso = t => new Date(t).toISOString().slice(0, 10);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function unavailable(symbol) {
  const err = new Error('no free data source for ' + symbol);
  err.status = 404;
  err.code = 'no-source';
  return err;
}

/** Latest quote from Finnhub (stocks / ETFs). Finnhub answers c:0 for unknown symbols. */
export async function finnhubQuote(symbol, { fetchJson = getJson, key = process.env.FINNHUB_API_KEY } = {}) {
  if (!key) throw unavailable(symbol);
  const q = await fetchJson(`${FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`);
  const price = num(q?.c), t = num(q?.t);
  if (!price || price <= 0 || !t) { const e = new Error('no quote'); e.status = 404; throw e; }
  return { price, prevClose: num(q.pc), at: t * 1000 };
}

/** Daily bars (ascending) from Massive, clamped to the free history window. */
export async function massiveDaily(ticker, { from, to, fetchJson = getJson, key = process.env.MASSIVE_API_KEY, now = Date.now() } = {}) {
  if (!key) throw unavailable(ticker);
  const earliest = now - HISTORY_DAYS * DAY;
  const start = Math.max(from ?? earliest, earliest);
  const end = Math.min(to ?? now, now);
  const url = `${MASSIVE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${iso(start)}/${iso(end)}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(key)}`;
  const json = await fetchJson(url);
  const bars = (json?.results ?? []).filter(b => num(b?.t) && num(b?.c) > 0)
    .map(b => ({ t: b.t, o: num(b.o), h: num(b.h), l: num(b.l), c: b.c, v: num(b.v) }));
  return { bars, truncated: (from ?? earliest) < earliest - DAY, earliest: iso(earliest) };
}

/** Group daily bars into weeks (Mon-Sun) or calendar months. */
export function aggregate(bars, interval) {
  if (interval === '1d') return bars;
  const keyOf = t => {
    const d = new Date(t);
    if (interval === '1mo') return d.toISOString().slice(0, 7);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
    return monday.toISOString().slice(0, 10);
  };
  const out = [];
  for (const b of bars) {
    const last = out[out.length - 1];
    if (last && last.key === keyOf(b.t)) {
      last.h = Math.max(last.h ?? b.h, b.h ?? last.h); last.l = Math.min(last.l ?? b.l, b.l ?? last.l);
      last.c = b.c; last.v = (last.v ?? 0) + (b.v ?? 0);
    } else out.push({ key: keyOf(b.t), ...b });
  }
  return out.map(({ key, ...b }) => b);
}

/** Yahoo-chart-compatible JSON (what the screens parse) from bars + metadata. */
export function toChart(symbol, bars, meta = {}) {
  const last = bars[bars.length - 1];
  return {
    chart: { result: [{
      meta: { symbol, currency: 'USD', regularMarketPrice: meta.price ?? last?.c ?? null,
        regularMarketTime: Math.floor((meta.at ?? last?.t ?? 0) / 1000) || null,
        source: meta.source, proxyFor: meta.proxyFor ?? null, truncated: Boolean(meta.truncated),
        historyFrom: meta.historyFrom ?? null },
      timestamp: bars.map(b => Math.floor(b.t / 1000)),
      indicators: { quote: [{ open: bars.map(b => b.o), high: bars.map(b => b.h), low: bars.map(b => b.l),
        close: bars.map(b => b.c), volume: bars.map(b => b.v) }] }
    }], error: null }
  };
}

/**
 * Chart request (validated by marketParams) -> Yahoo-compatible JSON from the free providers.
 * p: { symbol, interval, range } or { symbol, interval, period1, period2 } (seconds).
 */
export async function providerChart(p, deps = {}) {
  const { symbol } = p;
  if (UNAVAILABLE.has(symbol)) throw unavailable(symbol);
  const proxyFor = PROXY[symbol] ? symbol : null;
  const target = PROXY[symbol] || symbol;
  const massiveTicker = INDEX[target] || (target.startsWith('^') ? null : target);
  if (!massiveTicker) throw unavailable(symbol);
  const now = deps.now ?? Date.now();
  // Latest price only: a Finnhub quote for stocks/ETFs (indices have no free quote -> last daily bar).
  if (p.range === '1d' && !INDEX[target]) {
    const q = await finnhubQuote(target, deps);
    return toChart(symbol, [], { ...q, source: 'Finnhub（' + target + '）', proxyFor: proxyFor && target });
  }
  const from = p.period1 !== undefined ? p.period1 * 1000 : now - (RANGE_DAYS[p.range] ?? 366) * DAY;
  const to = p.period2 !== undefined ? p.period2 * 1000 : now;
  const { bars, truncated, earliest } = await massiveDaily(massiveTicker, { ...deps, from, to, now });
  if (!bars.length) { const e = new Error('no bars'); e.status = 404; throw e; }
  return toChart(symbol, aggregate(bars, p.interval || '1d'), {
    source: 'Massive（' + massiveTicker + '、日次終値・分割調整済み）', proxyFor: proxyFor && target,
    truncated, historyFrom: truncated ? earliest : iso(bars[0].t)
  });
}
