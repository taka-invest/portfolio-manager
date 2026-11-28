// Market data for the 市場分析 screen: request validation and the Fear & Greed reader.
// Charts/quotes come from ./providers.js (Finnhub + Massive free tiers; plan B).
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


export async function fearGreed(fetchJson = getJson) {
  const raw = await fetchJson('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/');
  const score = raw?.fear_and_greed?.score;
  if (!(typeof score === 'number' && score >= 0 && score <= 100)) { const e = new Error('no fear & greed'); e.status = 404; throw e; }
  return {
    fear_and_greed: { score, rating: raw.fear_and_greed.rating ?? null, timestamp: raw.fear_and_greed.timestamp ?? null },
    source: { provider: 'CNN Fear & Greed Index（非公式エンドポイント）', retrievedAt: new Date().toISOString() }
  };
}
