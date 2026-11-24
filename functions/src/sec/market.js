// Market data for the 市場分析 screen, fetched server-side so holdings tickers are
// no longer sent to third-party CORS proxies. Returns a trimmed Yahoo-chart-compatible
// shape so the existing UI parsing keeps working, plus source/time.
import { getJson } from '../sec-gateway.js';

export const SYMBOL = /^\^?[A-Z0-9][A-Z0-9.=-]{0,11}$/;
export const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y']);
export const INTERVALS = new Set(['1d', '1wk', '1mo']);

/** Validate query → upstream params. Throws 'invalid …' errors (mapped to HTTP 400). */
export function marketParams(q = {}) {
  if (q.kind === 'feargreed') return { kind: 'feargreed' };
  const symbol = String(q.symbol ?? '').toUpperCase().trim();
  if (!SYMBOL.test(symbol)) throw new Error('invalid symbol');
  const interval = String(q.interval ?? '1d');
  if (!INTERVALS.has(interval)) throw new Error('invalid interval');
  if (q.period1 !== undefined) {
    const p1 = Number(q.period1), p2 = Number(q.period2 ?? Math.floor(Date.now() / 1000));
    if (!Number.isSafeInteger(p1) || !Number.isSafeInteger(p2) || p1 < 0 || p2 <= p1) throw new Error('invalid period');
    return { kind: 'chart', symbol, interval, period1: p1, period2: p2 };
  }
  const range = String(q.range ?? '1d');
  if (!RANGES.has(range)) throw new Error('invalid range');
  return { kind: 'chart', symbol, interval, range };
}

export async function yahooChart(p, fetchJson = getJson) {
  const qs = p.period1 !== undefined
    ? `period1=${p.period1}&period2=${p.period2}&interval=${p.interval}`
    : `range=${p.range}&interval=${p.interval}`;
  const raw = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(p.symbol)}?${qs}`);
  const r = raw?.chart?.result?.[0];
  if (!r) { const e = new Error('no market data'); e.status = 404; throw e; }
  return {
    chart: { result: [{
      meta: { symbol: r.meta?.symbol ?? p.symbol, currency: r.meta?.currency ?? null,
        regularMarketPrice: r.meta?.regularMarketPrice ?? null, regularMarketTime: r.meta?.regularMarketTime ?? null },
      timestamp: r.timestamp ?? [],
      indicators: { quote: [{ close: r.indicators?.quote?.[0]?.close ?? [] }] }
    }] },
    source: { provider: 'Yahoo Finance chart API（非公式）', retrievedAt: new Date().toISOString() }
  };
}

export async function fearGreed(fetchJson = getJson) {
  const raw = await fetchJson('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/');
  const score = raw?.fear_and_greed?.score;
  if (!(typeof score === 'number' && score >= 0 && score <= 100)) { const e = new Error('no fear & greed'); e.status = 404; throw e; }
  return {
    fear_and_greed: { score, rating: raw.fear_and_greed.rating ?? null, timestamp: raw.fear_and_greed.timestamp ?? null },
    source: { provider: 'CNN Fear & Greed Index（非公式エンドポイント）', retrievedAt: new Date().toISOString() }
  };
}
