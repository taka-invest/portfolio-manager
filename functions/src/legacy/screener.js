// Netlify Function: バッチスクリーナー専用エンジン
// 10銘柄/コール、5並列処理、シグナルスコア算出

import { getJson } from '../sec-gateway.js';
const fetchJson = url => getJson(url);

// ── CIK一括解決 ─────────────────────────────────
async function resolveCiks(tickers) {
  const data = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  const map = {};
  for (const val of Object.values(data)) {
    map[val.ticker.toUpperCase()] = {
      cik:  String(val.cik_str).padStart(10, "0"),
      name: val.title,
    };
  }
  const result = {};
  for (const t of tickers) result[t] = map[t] ?? null;
  return result;
}

// ── 四半期フィルタ ───────────────────────────────
function quarterFilter(d) {
  if (d.start && d.end) {
    const days = (new Date(d.end) - new Date(d.start)) / 86400000;
    return days >= 75 && days <= 110;
  }
  return false;
}

function quarterLabel(endDate) {
  const d = new Date(endDate + "T00:00:00Z");
  const m = d.getUTCMonth() + 1;
  const y = d.getUTCFullYear();
  return `${y} ${m <= 3 ? "Q1" : m <= 6 ? "Q2" : m <= 9 ? "Q3" : "Q4"}`;
}

function dedupeByEnd(arr) {
  const seen = new Map();
  for (const item of arr) if (!seen.has(item.end)) seen.set(item.end, item);
  return [...seen.values()];
}

function bestConcept(g, concepts, unit = "USD") {
  let best = [], bestEnd = "";
  for (const c of concepts) {
    let vals = (g[c]?.units?.[unit] ?? []).filter(quarterFilter);
    vals = vals.sort((a, b) => b.end.localeCompare(a.end)).slice(0, 12);
    if (vals.length > 0 && vals[0].end > bestEnd) { bestEnd = vals[0].end; best = vals; }
  }
  return dedupeByEnd(best);
}

const REV_C  = ["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","RevenueFromContractWithCustomerIncludingAssessedTax"];
const COGS_C = ["CostOfRevenue","CostOfGoodsAndServicesSold","CostOfGoodsAndServices","CostOfSales"];
const OP_C   = ["OperatingIncomeLoss"];
const FINANCIAL_TICKERS = new Set(['SOFI','SQ','PYPL','V','MA','JPM','BAC','GS','WFC','AFRM',
  'UPST','COIN','HOOD','NU','LC','OPEN','NRDS','MKTX','SCHW','MS','C','BLK','BX','KKR','ALLY']);

// ── 1銘柄分析（軽量版）────────────────────────────
async function analyzeOneTicker(ticker, cikInfo) {
  const { cik, name } = cikInfo;

  const data = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  const g = data?.facts?.["us-gaap"] ?? {};

  const revQ  = bestConcept(g, REV_C);
  const cogsQ = bestConcept(g, COGS_C);
  const opQ   = bestConcept(g, OP_C);

  // 最大10四半期でトレンド構築
  const trend = revQ.slice(0, 10).map((r, i) => {
    const end      = r.end;
    const revM     = r.val / 1_000_000;
    const cogsE    = cogsQ.find(c => c.end === end);
    const opE      = opQ.find(o => o.end === end);
    const cogsM    = cogsE ? cogsE.val / 1_000_000 : null;
    const opM      = opE   ? opE.val   / 1_000_000 : null;
    const costRatio  = cogsE ? cogsE.val / r.val : null;
    const opMargin   = opE   ? opE.val  / r.val * 100 : null;
    const grossMargin= cogsE ? (1 - cogsE.val / r.val) * 100 : null;
    const prev4R   = revQ[i + 4];
    const prevR    = revQ[i + 1];
    const revYoY   = (prev4R && r.val) ? (r.val / prev4R.val - 1) * 100 : null;
    const revQoQ   = (prevR  && r.val) ? (r.val / prevR.val  - 1) * 100 : null;
    const rof40    = (revYoY !== null && opMargin !== null) ? +(revYoY + opMargin).toFixed(1) : null;
    return { end, label: quarterLabel(end), revM, cogsM, opM, costRatio, opMargin, grossMargin, revYoY, revQoQ, rof40 };
  }).filter(q => q.revM > 0);

  if (trend.length === 0) return null;

  // シグナルスコア計算
  trend.forEach((q, i) => {
    const prev = trend[i + 1] ?? null;
    const prevRof40 = prev && prev.revYoY !== null && prev.opMargin !== null
      ? prev.revYoY + prev.opMargin : null;
    const prevOpM = prev?.opMargin ?? null;
    const opMDelta = q.opMargin !== null && prev != null && prev.opMargin !== null
      ? q.opMargin - prev.opMargin : null;
    const yoyAccel = q.revYoY !== null && prev != null && prev.revYoY !== null
      ? q.revYoY - prev.revYoY : null;

    const s = {
      redToBlack:     q.opMargin !== null && q.opMargin > 0 && (prevOpM === null || prevOpM <= 0),
      opMInflection:  opMDelta !== null && opMDelta >= 5,
      rof40Cross40:   q.rof40 !== null && q.rof40 >= 40 && (prevRof40 === null || prevRof40 < 40),
      rof40Cross60:   q.rof40 !== null && q.rof40 >= 60 && (prevRof40 === null || prevRof40 < 60),
      rof40Cross80:   q.rof40 !== null && q.rof40 >= 80 && (prevRof40 === null || prevRof40 < 80),
      yoyAccelStrong: yoyAccel !== null && yoyAccel >= 10,
    };
    q.signals = s; q.opMDelta = opMDelta; q.yoyAccel = yoyAccel;

    let pts = 0;
    if (s.redToBlack)     pts += 40;
    if (s.rof40Cross40)   pts += 30;
    if (s.rof40Cross60)   pts += 25;
    if (s.rof40Cross80)   pts += 30;
    if (s.opMInflection)  pts += 20;
    if (s.yoyAccelStrong) pts += 15;

    let mult = 1.0;
    const prevMax = trend.slice(i+1).map(p => p.rof40).filter(r => r !== null)
      .reduce((m, r) => Math.max(m, r), 0);
    if (q.rof40 !== null && q.rof40 > prevMax && prevMax > 20) mult *= 1.5;
    if (prev?.signals) {
      const repeat = ['redToBlack','rof40Cross40','rof40Cross60','rof40Cross80']
        .some(k => s[k] && prev.signals[k]);
      if (repeat) mult *= 0.25;
    }
    q.signalScore = Math.min(100, Math.round(pts * mult));
  });

  // フェーズ判定
  const recent4 = trend.slice(0, 4);
  const avgCostRatio = recent4.filter(q => q.costRatio !== null)
    .reduce((s, q, _, a) => s + q.costRatio / a.length, 0);
  const isFinancial = FINANCIAL_TICKERS.has(ticker) || avgCostRatio > 1.0;
  const lossCount   = recent4.filter(q => q.opMargin !== null && q.opMargin < 0).length;
  const profitCount = recent4.filter(q => q.opMargin !== null && q.opMargin > 3).length;
  let phase;
  if (isFinancial) phase = 'financial';
  else if (lossCount >= 3 || (lossCount >= 2 && (trend[0]?.revYoY ?? 0) > 40)) phase = 'phase1';
  else if (profitCount >= 3 && (trend[0]?.rof40 ?? 0) >= 40) phase = 'phase3';
  else phase = 'phase2';

  const latest  = trend[0];
  // 直近4Qで最高スコアの四半期
  const bestSig = trend.slice(0, 4).reduce((best, q) =>
    (q.signalScore ?? 0) > (best.signalScore ?? 0) ? q : best, trend[0]);

  // 粗利率改善連続チェック
  let gmImproveStreak = 0;
  for (let i = 0; i < Math.min(trend.length - 1, 5); i++) {
    if (trend[i].grossMargin !== null && trend[i+1].grossMargin !== null &&
        trend[i].grossMargin > trend[i+1].grossMargin) gmImproveStreak++;
    else break;
  }

  return {
    ticker,
    name: (name ?? '').substring(0, 35),
    latestQ:       latest?.label ?? null,
    rof40:         latest?.rof40 ?? null,
    opMargin:      latest?.opMargin !== undefined ? +latest.opMargin.toFixed(1) : null,
    grossMargin:   latest?.grossMargin !== undefined ? +latest.grossMargin.toFixed(1) : null,
    revYoY:        latest?.revYoY !== null ? +latest.revYoY.toFixed(1) : null,
    yoyAccel:      latest?.yoyAccel !== null ? +latest.yoyAccel.toFixed(1) : null,
    revM:          latest?.revM !== undefined ? +latest.revM.toFixed(0) : null,
    signalScore:   bestSig?.signalScore ?? 0,
    signalQ:       bestSig?.label ?? null,
    signalFlags:   bestSig?.signals ?? {},
    phase,
    isFinancial,
    gmImproveStreak,
  };
}

// ── Yahoo Finance 株価取得（バッチ）──────────────
async function getPrices(tickers) {
  const result = {};
  try {
    const symbols = tickers.join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`;
    const data = await fetchJson(url);
    for (const q of (data?.quoteResponse?.result ?? [])) {
      result[q.symbol] = {
        price:  q.regularMarketPrice  ?? null,
        mktcap: q.marketCap           ?? null,
        chg1d:  q.regularMarketChangePercent ?? null,
      };
    }
  } catch(e) { /* price取得失敗は無視 */ }
  return result;
}

// ── Netlify Handler ──────────────────────────────
export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  let tickers = [];
  try {
    const body = JSON.parse(event.body || '{}');
    tickers = (body.tickers ?? []).slice(0, 10).map(t => t.toUpperCase().trim()).filter(Boolean);
  } catch(e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  if (tickers.length === 0)
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "tickersが必要です" }) };

  try {
    // CIK一括解決（1コール）
    const cikMap = await resolveCiks(tickers);

    // SEC分析: 5並列
    const CONC = 5;
    const secResults = [];
    for (let i = 0; i < tickers.length; i += CONC) {
      const batch = tickers.slice(i, i + CONC);
      const batchR = await Promise.allSettled(
        batch.map(t => {
          if (!cikMap[t]) return Promise.resolve({ ticker: t, error: 'CIK not found', signalScore: 0 });
          return analyzeOneTicker(t, cikMap[t]);
        })
      );
      secResults.push(...batchR);
    }

    // Yahoo価格（一括）
    const prices = await getPrices(tickers);

    // 結果マージ
    const output = secResults.map((r, i) => {
      const base = r.status === 'fulfilled' && r.value
        ? r.value
        : { ticker: tickers[i], error: r.reason?.message ?? 'Failed', signalScore: 0, phase: 'unknown' };
      const priceInfo = prices[tickers[i]] ?? {};
      return { ...base, ...priceInfo };
    });

    return { statusCode: 200, headers: cors, body: JSON.stringify(output) };
  } catch(err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};