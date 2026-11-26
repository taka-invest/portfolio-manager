// Batch screener on CORRECTED SEC data. Entry-signal rules, points, multipliers and
// phase rules are the legacy ones (functions/src/legacy/screener.js analyzeOneTicker);
// the inputs now include synthesised Q4 and date-matched YoY, and missing values are
// never treated as 0.
import { getJson } from '../sec-gateway.js';
import { analyzeFacts } from './financials.js';
import { coreMetrics, masyaScore, exitSignals } from './scoring.js';
import { resolveCik, latestPrice } from './company.js';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const r1 = v => finite(v) ? Math.round(v * 10) / 10 : null;

export const FINANCIAL_TICKERS = new Set(['SOFI', 'SQ', 'PYPL', 'V', 'MA', 'JPM', 'BAC', 'GS', 'WFC', 'AFRM',
  'UPST', 'COIN', 'HOOD', 'NU', 'LC', 'OPEN', 'NRDS', 'MKTX', 'SCHW', 'MS', 'C', 'BLK', 'BX', 'KKR', 'ALLY']);

/** Legacy entry signals on newest-first quarters (legacy rof40 = quarterly YoY + op margin). */
export function entrySignals(quartersOldestFirst) {
  const trend = [...quartersOldestFirst].reverse().filter(q => finite(q.revenue) && q.revenue > 0).map(q => ({
    end: q.end, revYoY: q.revenueYoYPct, opMargin: q.operatingMarginPct, grossMargin: q.grossMarginPct,
    costRatio: finite(q.costRatioPct) ? q.costRatioPct / 100 : null, rof40: q.ruleOf40Legacy, derived: q.revenueDerived
  }));
  trend.forEach((q, i) => {
    const prev = trend[i + 1] ?? null;
    const prevRof40 = prev && finite(prev.revYoY) && finite(prev.opMargin) ? prev.revYoY + prev.opMargin : null;
    const prevOpM = prev?.opMargin ?? null;
    const opMDelta = finite(q.opMargin) && finite(prevOpM) ? q.opMargin - prevOpM : null;
    const yoyAccel = finite(q.revYoY) && finite(prev?.revYoY) ? q.revYoY - prev.revYoY : null;
    const s = {
      redToBlack: finite(q.opMargin) && q.opMargin > 0 && finite(prevOpM) && prevOpM <= 0,
      opMInflection: finite(opMDelta) && opMDelta >= 5,
      rof40Cross40: finite(q.rof40) && q.rof40 >= 40 && finite(prevRof40) && prevRof40 < 40,
      rof40Cross60: finite(q.rof40) && q.rof40 >= 60 && finite(prevRof40) && prevRof40 < 60,
      rof40Cross80: finite(q.rof40) && q.rof40 >= 80 && finite(prevRof40) && prevRof40 < 80,
      yoyAccelStrong: finite(yoyAccel) && yoyAccel >= 10
    };
    let pts = 0;
    if (s.redToBlack) pts += 40;
    if (s.rof40Cross40) pts += 30;
    if (s.rof40Cross60) pts += 25;
    if (s.rof40Cross80) pts += 30;
    if (s.opMInflection) pts += 20;
    if (s.yoyAccelStrong) pts += 15;
    let mult = 1;
    const prevMax = trend.slice(i + 1).map(p => p.rof40).filter(finite).reduce((m, v) => Math.max(m, v), 0);
    if (finite(q.rof40) && q.rof40 > prevMax && prevMax > 20) mult *= 1.5;
    if (prev?.signals && ['redToBlack', 'rof40Cross40', 'rof40Cross60', 'rof40Cross80'].some(k => s[k] && prev.signals[k])) mult *= 0.25;
    Object.assign(q, { signals: s, opMDelta: r1(opMDelta), yoyAccel: r1(yoyAccel), signalScore: Math.min(100, Math.round(pts * mult)) });
  });
  return trend;
}

/** Legacy phase rules; missing values no longer count as 0. */
export function phaseOf(ticker, trend) {
  const recent = trend.slice(0, 4);
  const costs = recent.map(q => q.costRatio).filter(finite);
  const avgCost = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null;
  if (FINANCIAL_TICKERS.has(ticker) || (finite(avgCost) && avgCost > 1)) return 'financial';
  const loss = recent.filter(q => finite(q.opMargin) && q.opMargin < 0).length;
  const profit = recent.filter(q => finite(q.opMargin) && q.opMargin > 3).length;
  if (loss >= 3 || (loss >= 2 && finite(trend[0]?.revYoY) && trend[0].revYoY > 40)) return 'phase1';
  if (profit >= 3 && finite(trend[0]?.rof40) && trend[0].rof40 >= 40) return 'phase3';
  return 'phase2';
}

export function screenFacts(ticker, companyfacts) {
  const fin = analyzeFacts(companyfacts);
  if (!fin.latest) return { ticker, error: 'SECの四半期売上データがありません' };
  const trend = entrySignals(fin.quarters.slice(-16));
  const best = trend.slice(0, 4).reduce((b, q) => ((q.signalScore ?? 0) > (b.signalScore ?? 0) ? q : b), trend[0]);
  let gmStreak = 0;
  for (let i = 0; i < Math.min(trend.length - 1, 5); i++) {
    if (finite(trend[i].grossMargin) && finite(trend[i + 1].grossMargin) && trend[i].grossMargin > trend[i + 1].grossMargin) gmStreak++;
    else break;
  }
  const core = coreMetrics(fin);
  const l = fin.latest;
  return {
    ticker, name: companyfacts.entityName ?? null, latestQ: l.end,
    revenueM: finite(l.revenue) ? Math.round(l.revenue / 1e5) / 10 : null,
    revenueYoYPct: l.revenueYoYPct, revenueTtmYoYPct: l.revenueTtmYoYPct, yoyAccelPts: l.revenueYoYAccelPts,
    operatingMarginPct: l.operatingMarginPct, grossMarginPct: l.grossMarginPct, costRatioTtmPct: l.costRatioTtmPct,
    ruleOf40: l.ruleOf40, ruleOf40Legacy: l.ruleOf40Legacy, fcfMarginTtmPct: l.fcfMarginTtmPct,
    signalScore: best?.signalScore ?? 0, signalQ: best?.end ?? null,
    signalFlags: best?.signals ?? {}, phase: phaseOf(ticker, trend), gmImproveStreak: gmStreak,
    masyaScore: masyaScore(core).score, masyaComplete: masyaScore(core).complete,
    exitLabel: exitSignals(fin.quarters)?.exitLabel ?? null
  };
}

// The function is killed at 180s (timeoutSeconds). Stop starting new tickers well
// before that so a slow upstream yields partial rows plus "retry" rows, not a 5xx.
export const SCREEN_BUDGET_MS = 90_000;
export const TIMEOUT_ERROR = '時間切れ（混雑のため未取得。再スキャンしてください）';

/** Screen up to 10 tickers sequentially (SEC pacing is enforced by the gateway). */
export async function screenTickers(tickers, { fetchJson = getJson, withPrice = true, now = () => Date.now(), budgetMs = SCREEN_BUDGET_MS } = {}) {
  const out = [];
  const deadline = now() + budgetMs;
  for (const ticker of tickers) {
    if (now() > deadline) { out.push({ ticker, error: TIMEOUT_ERROR }); continue; }
    try {
      const { cik } = await resolveCik(ticker, fetchJson);
      const facts = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
      const row = screenFacts(ticker, facts);
      const quote = withPrice && now() <= deadline ? await latestPrice(ticker, fetchJson) : null;
      out.push({ ...row, price: quote?.price ?? null, priceAsOf: quote?.asOf ?? null });
    } catch (err) {
      out.push({ ticker, error: err.status === 404 ? 'SECの企業一覧に見つかりません' : '取得に失敗しました' });
    }
  }
  return {
    rows: out,
    source: { provider: 'SEC EDGAR XBRL companyfacts', retrievedAt: new Date().toISOString(),
      price: 'Yahoo Finance chart API（非公式）', note: 'シグナル・フェーズの規則は旧スクリーナーと同じ。入力は修正版データ' },
    status: 'verification-pending'
  };
}
