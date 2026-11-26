// Analyst consensus for the next earnings report and the recent EPS surprises (Finnhub,
// free endpoints). Server-side so the key stays off the analysis page (whose CSP only
// allows the own API). Reference data only: never merged into SEC actuals and not used
// by the legacy 投資判断 score.
import { getJson } from '../sec-gateway.js';

const BASE = 'https://finnhub.io/api/v1/';
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const day = t => new Date(t).toISOString().slice(0, 10);

/**
 * @returns {Promise<{ next, epsHistory, source } | null>} null when no key is configured.
 * Upstream failures are reported as `error` (no URL or key is ever included).
 */
export async function earningsOutlook(ticker, { fetchJson = getJson, apiKey = process.env.FINNHUB_API_KEY, now = () => Date.now() } = {}) {
  if (!apiKey) return null;
  const token = encodeURIComponent(apiKey);
  const today = now();
  const out = { next: null, epsHistory: [], source: { provider: 'Finnhub（アナリスト予想の平均）', retrievedAt: new Date(today).toISOString() } };
  const errors = [];
  try {
    const cal = await fetchJson(`${BASE}calendar/earnings?from=${day(today - 86400000)}&to=${day(today + 150 * 86400000)}&symbol=${encodeURIComponent(ticker)}&token=${token}`);
    const upcoming = (cal?.earningsCalendar ?? [])
      .filter(e => e && e.symbol === ticker && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && Date.parse(e.date) >= Date.parse(day(today)))
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    if (upcoming) out.next = {
      date: upcoming.date, hour: ['bmo', 'amc', 'dmh'].includes(upcoming.hour) ? upcoming.hour : null,
      fiscalYear: num(upcoming.year), fiscalQuarter: num(upcoming.quarter),
      epsEstimate: num(upcoming.epsEstimate),
      revenueEstimateM: num(upcoming.revenueEstimate) !== null ? upcoming.revenueEstimate / 1e6 : null
    };
  } catch { errors.push('calendar'); }
  try {
    const hist = await fetchJson(`${BASE}stock/earnings?symbol=${encodeURIComponent(ticker)}&token=${token}`);
    out.epsHistory = (Array.isArray(hist) ? hist : [])
      .filter(h => h && /^\d{4}-\d{2}-\d{2}$/.test(h.period))
      .sort((a, b) => b.period.localeCompare(a.period)).slice(0, 4)
      .map(h => ({ period: h.period, epsActual: num(h.actual), epsEstimate: num(h.estimate),
        surprisePct: num(h.surprisePercent) }));
  } catch { errors.push('history'); }
  if (errors.length) out.error = errors.length === 2 ? 'アナリスト予想を取得できませんでした' : '一部の予想データを取得できませんでした';
  return out;
}
