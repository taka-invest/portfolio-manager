// Ported verbatim from the Netlify production source (masya_app, 2026-09-17) except
// that every upstream request goes through ../sec-gateway.js (SEC UA, pacing, cache,
// retry). Do not fix financial logic here: corrected logic lives in ../sec/.
// Netlify Function: バッチスクリーナー専用エンジン
// 10銘柄/コール、5並列処理、シグナルスコア算出


// SEC EDGAR 用（SEC推奨フォーマット）
import { getJson } from '../sec-gateway.js';
const fetchJson = url => getJson(url);
const fetchJsonBrowser = url => getJson(url);

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
    opMargin:      Number.isFinite(latest?.opMargin) ? +latest.opMargin.toFixed(1) : null /* FIX: null/undefined crashed the whole screener */,
    grossMargin:   Number.isFinite(latest?.grossMargin) ? +latest.grossMargin.toFixed(1) : null /* FIX: null/undefined crashed the whole screener */,
    revYoY:        Number.isFinite(latest?.revYoY) ? +latest.revYoY.toFixed(1) : null /* FIX: null/undefined crashed the whole screener */,
    yoyAccel:      Number.isFinite(latest?.yoyAccel) ? +latest.yoyAccel.toFixed(1) : null /* FIX: null/undefined crashed the whole screener */,
    revM:          Number.isFinite(latest?.revM) ? +latest.revM.toFixed(0) : null /* FIX: null/undefined crashed the whole screener */,
    signalScore:   bestSig?.signalScore ?? 0,
    signalQ:       bestSig?.label ?? null,
    signalFlags:   bestSig?.signals ?? {},
    phase,
    isFinancial,
    gmImproveStreak,
  };
}

// ── Yahoo Finance 株価取得（v8/chart 個別呼び出し、最大5並列）──────────────
// v7/quote はcrumb認証が必要になり空を返す。v8/chart はanalyze.jsで動作確認済み。
async function getPrices(tickers) {
  const result = {};
  const CONC = 5;
  for (let i = 0; i < tickers.length; i += CONC) {
    const batch = tickers.slice(i, i + CONC);
    const batchR = await Promise.allSettled(batch.map(async (ticker) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;
      const data = await fetchJsonBrowser(url);
      const meta = data?.chart?.result?.[0]?.meta ?? {};
      return {
        ticker,
        price:      meta.regularMarketPrice ?? meta.chartPreviousClose ?? null,
        mktcap:     meta.marketCap  ?? null,
        chg1d:      meta.regularMarketChangePercent ?? null,
        chg52wHigh: null,  // v8/chartではregularMarketDayHigh等はあるが52週乖離なし
      };
    }));
    for (const r of batchR) {
      if (r.status === 'fulfilled' && r.value?.ticker) {
        const { ticker, ...rest } = r.value;
        result[ticker] = rest;
      }
    }
  }
  return result;
}

// ── 動的スキャン用プール（$10B+確実な約80銘柄）──────────────
// フロントエンドがこのリストを取得してバッチスキャンに使う
export const DYNAMIC_POOL = [
  // AI/Megacap
  'NVDA','MSFT','GOOGL','META','AMZN','AAPL','TSLA','ORCL',
  // AI Infrastructure & Security
  'ARM','ANET','DELL','VRT','SMCI','PLTR','APP','CRWD','DDOG','ZS','NET','PANW','FTNT','S',
  // SaaS
  'NOW','CRM','ADBE','INTU','TEAM','MNDY','HUBS','TTD','GTLB','CFLT','FOUR','VEEV','WDAY','MDB','BILL',
  // Semiconductor
  'AMD','AVGO','QCOM','MU','AMAT','LRCX','KLAC','TXN','MRVL','ON','NXPI','ASML','TSM','MPWR',
  // Consumer Tech
  'NFLX','SPOT','UBER','ABNB','BKNG','SHOP','MELI','RBLX',
  // FinTech
  'V','MA','COIN','PYPL','SQ','NU','SOFI','SCHW','KKR','BX','BLK',
  // Healthcare
  'ISRG','LLY','NVO','VRTX','REGN','AMGN','GILD','TMO','DHR','SYK','DXCM',
  // Defense/Industrial
  'AXON','LMT','GD','RTX','GE','HON','ETN',
  // Consumer/Lifestyle
  'DECK','RCL','HLT','ONON','NKE',
  // Emerging Growth
  'RDDT','DUOL','CELH','CAVA',
];

// ── 複合スコア計算 ────────────────────────────────
// Phase 1: ボーナスシステム（決算予想修正・ガイダンス検出）
function calcCompositeScore(signalScore, revYoY, chg52wHigh, epsRevisionBonus = 0, guidanceBonus = 0) {
  const sigPart  = (signalScore ?? 0) * 0.60;
  const yoyNorm  = Math.min(100, Math.max(0, (revYoY ?? 0) * 1.5));  // 67%YoY→100pt
  const yoyPart  = yoyNorm * 0.25;
  const momNorm  = Math.min(100, Math.max(0, 100 + (chg52wHigh ?? -50)));  // 52週高値=100pt
  const momPart  = momNorm * 0.15;

  // Phase 1: 先行シグナルボーナス（既存signalScoreの20%まで追加可能）
  const bonusMax = (signalScore ?? 0) * 0.20;
  const totalBonus = Math.min(bonusMax, (epsRevisionBonus ?? 0) + (guidanceBonus ?? 0));

  return Math.round(sigPart + yoyPart + momPart + totalBonus);
}

// ── Netlify Handler ──────────────────────────────
export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const cors_ok = (data) => ({ statusCode: 200, headers: cors, body: JSON.stringify(data) });
  const cors_err = (msg, code = 400) => ({ statusCode: code, headers: cors, body: JSON.stringify({ error: msg }) });

  // ── 動的プール取得モード（即座に銘柄リストのみ返す）──────────
  if (body.mode === 'getpool') {
    return cors_ok(DYNAMIC_POOL);
  }

  // ── 通常モード（既存: セクタータブ等）──────────────
  const tickers = (body.tickers ?? []).slice(0, 10).map(t => t.toUpperCase().trim()).filter(Boolean);
  if (tickers.length === 0) return cors_err("tickersが必要です");

  try {
    const cikMap = await resolveCiks(tickers);
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
    const prices = await getPrices(tickers);
    const output = secResults.map((r, i) => {
      const base = r.status === 'fulfilled' && r.value
        ? r.value
        : { ticker: tickers[i], error: r.reason?.message ?? 'Failed', signalScore: 0, phase: 'unknown' };
      const priceInfo = prices[tickers[i]] ?? {};
      return { ...base, ...priceInfo };
    });
    return cors_ok(output);
  } catch(err) {
    return cors_err(err.message, 500);
  }
};
