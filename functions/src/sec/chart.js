// Normalised price history for the chart screen (replaces raw Yahoo passthrough).
import { getJson } from '../sec-gateway.js';

export const RANGES = { '1y': '1d', '5y': '1wk', '10y': '1mo' };

export function normalizeChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const adj = r.indicators?.adjclose?.[0]?.adjclose;
  const close = adj ?? q.close ?? [];
  const ok = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const r2 = v => Math.round(v * 100) / 100;
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const v = close[i];
    if (!ok(v)) continue;
    const pt = { t: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: r2(v) };
    // OHLC scaled by the same split/dividend factor as the adjusted close.
    const f = adj && ok(q.close?.[i]) ? v / q.close[i] : 1;
    if (ok(q.open?.[i]) && ok(q.high?.[i]) && ok(q.low?.[i])) {
      pt.open = r2(q.open[i] * f); pt.high = r2(q.high[i] * f); pt.low = r2(q.low[i] * f);
    }
    if (typeof q.volume?.[i] === 'number' && q.volume[i] >= 0) pt.volume = q.volume[i];
    points.push(pt);
  }
  return {
    points,
    currency: r.meta?.currency ?? null,
    adjusted: Boolean(r.indicators?.adjclose?.[0]?.adjclose),
    lastPrice: r.meta?.regularMarketPrice ?? null,
    asOf: r.meta?.regularMarketTime ? new Date(r.meta.regularMarketTime * 1000).toISOString() : null
  };
}

export async function priceHistory(ticker, range = '5y', fetchJson = getJson) {
  if (!Object.hasOwn(RANGES, range)) throw new Error('invalid range');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${RANGES[range]}`;
  const data = normalizeChart(await fetchJson(url));
  if (!data || !data.points.length) {
    const err = new Error('no price data');
    err.status = 404;
    throw err;
  }
  return { ticker, range, interval: RANGES[range], ...data,
    source: { provider: 'Yahoo Finance chart API（非公式）', retrievedAt: new Date().toISOString(),
      note: data.adjusted ? '分割・配当調整後の終値' : '終値（調整なし）' } };
}
