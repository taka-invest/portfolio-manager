// Ported from the Netlify production source (masya_app, 2026-09-17). Changes:
//  1. every upstream request goes through ../sec-gateway.js (SEC UA, pacing, cache, retry)
//  2. getFinancials() takes its base data from ../sec/legacy-adapter.js (corrected
//     quarters/annuals); the legacy signal/score/valuation code is otherwise unchanged
//  3. small fixes marked FIX (missing growth not treated as 0; 2021 peak needs 10y range)
// Netlify Function: 伝説の会計学 分析エンジン v3
// 参入シグナル検知 / RoF40 / 営業レバレッジ / 16四半期対応
// APP・MU等の複数XBRLタグ対応（最新データ優先）

import { getJson } from '../sec-gateway.js';
import { legacyBase } from '../sec/legacy-adapter.js';
import { earningsOutlook } from '../sec/estimates.js';
const fetchJson = url => getJson(url);

// ── 1. CIK取得 ───────────────────────────────────
async function getCik(ticker) {
  const data = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  for (const val of Object.values(data)) {
    if (val.ticker.toUpperCase() === ticker.toUpperCase()) {
      return { cik: String(val.cik_str).padStart(10, "0"), name: val.title };
    }
  }
  throw new Error(`ティッカー "${ticker}" が見つかりません`);
}

// ── 2. 最新Filing情報 ────────────────────────────
async function getLatestFilings(cik) {
  const data = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const { form, filingDate, accessionNumber, primaryDocument } = data.filings.recent;
  const result = {};
  for (let i = 0; i < form.length; i++) {
    const f = form[i];
    if ((f === "10-Q" || f === "10-K") && !result[f]) {
      result[f] = { date: filingDate[i], accession: accessionNumber[i], doc: primaryDocument[i] };
    }
    if (result["10-Q"] && result["10-K"]) break;
  }
  return result;
}

// ── 3. XBRL財務データ ────────────────────────────
async function getFinancials(cik) {
  const data = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  // CORRECTED DATA EXTRACTION (see ../sec/legacy-adapter.js): Q4 synthesis, latest
  // filing per period, date-matched YoY/QoQ, one row per fiscal year. Everything
  // below (signals, scores, valuation) is the unchanged legacy logic.
  const { revA, cogsA, opA, netIncA, cashA, debtA, eqA, issA, bbA, apicA, reA,
    sharesLatest, sharesAnnual, baseTrend } = legacyBase(data);

  // --- 参入シグナル / 派生指標を追加 ---
  const trend = baseTrend.map((q, i) => {
    const prev = baseTrend[i + 1]; // 1期前（古い方）

    // 1. 営業レバレッジ比率: (ΔOpIncome% / ΔRevenue%)
    let opLeverage = null;
    if (prev && q.opM !== null && prev.opM !== null && prev.revM > 0 && q.revM > 0) {
      const revChange = (q.revM - prev.revM) / prev.revM;
      if (Math.abs(revChange) > 0.005 && prev.opM !== 0) {
        const opChange = (q.opM - prev.opM) / Math.abs(prev.opM);
        opLeverage = +(Math.min(Math.max(opChange / revChange, -9.9), 19.9)).toFixed(2);
      }
    }

    // 2. Rule of 40 = YoY成長率 + 営業利益率
    const rof40 = (q.revYoY !== null && q.opMargin !== null)
      ? +(q.revYoY + q.opMargin).toFixed(1) : null;

    // 3. YoY加速度（2階微分）— prev が undefined のとき false になるよう明示チェック
    const yoyAccel = (q.revYoY !== null && prev != null && prev.revYoY !== null)
      ? +(q.revYoY - prev.revYoY).toFixed(1) : null;

    // 4. OpMデルタ（QoQ）
    const opMDelta = (q.opMargin !== null && prev != null && prev.opMargin !== null)
      ? +(q.opMargin - prev.opMargin).toFixed(1) : null;

    // 5. 参入シグナル検知
    const prevRof40 = (prev != null && prev.revYoY !== null && prev.opMargin !== null)
      ? prev.revYoY + prev.opMargin : null;

    const prevOpMargin = (prev != null) ? prev.opMargin : null;

    const signals = {
      redToBlack:     q.opMargin !== null && q.opMargin > 0 && (prevOpMargin === null || prevOpMargin <= 0),
      opMInflection:  opMDelta !== null && opMDelta >= 5,
      rof40Cross40:   rof40 !== null && rof40 >= 40 && (prevRof40 === null || prevRof40 < 40),
      rof40Cross60:   rof40 !== null && rof40 >= 60 && (prevRof40 === null || prevRof40 < 60),
      rof40Cross80:   rof40 !== null && rof40 >= 80 && (prevRof40 === null || prevRof40 < 80),
      opLevHigh:      opLeverage !== null && opLeverage >= 2.5,
      yoyAccelStrong: yoyAccel !== null && yoyAccel >= 10,
    };

    // シグナルレベル（優先度順）
    const inflectionLevel =
      (signals.redToBlack || signals.opMInflection || signals.rof40Cross40) ? "inflection" :
      (signals.rof40Cross60 || signals.yoyAccelStrong)                       ? "acceleration" :
      signals.rof40Cross80                                                    ? "hyper" : null;

    return { ...q, opLeverage, rof40, yoyAccel, opMDelta, signals, inflectionLevel };
  });

  // ── シグナル確度スコア計算（第2パス）────────────────
  // trend[0]=最新, trend[N-1]=最古。trend[i+1]以降が「より古いデータ」
  for (let i = 0; i < trend.length; i++) {
    const q       = trend[i];
    const prevQ   = trend[i + 1] ?? null;       // 1Q前（古い方）
    const olderQs = trend.slice(i + 1);          // さらに古いデータ群
    const s = q.signals;

    // ── 基本ポイント ──
    let pts = 0;
    if (s.redToBlack)     pts += 40;  // 赤字→黒字: 稀少・構造転換
    if (s.rof40Cross40)   pts += 30;  // RoF40 初突破
    if (s.rof40Cross60)   pts += 25;  // RoF60 突破
    if (s.rof40Cross80)   pts += 30;  // RoF80 突破（レア）
    if (s.opMInflection)  pts += 20;  // OpM +5pp 急拡大
    if (s.yoyAccelStrong) pts += 15;  // YoY加速 +10pp
    if (s.opLevHigh)      pts += 20;  // OpLev ≥ 2.5x

    // OpMDelta 強度ボーナス
    if (q.opMDelta !== null && q.opMDelta >= 15) pts += 10;
    if (q.opMDelta !== null && q.opMDelta >= 20) pts += 10;

    let mult = 1.0;

    // RoF40 過去最高値更新ボーナス（過去平均20以上のケースのみ）
    const prevRof40Max = olderQs
      .map(p => p.rof40).filter(r => r !== null)
      .reduce((m, r) => Math.max(m, r), 0);
    if (q.rof40 !== null && q.rof40 > prevRof40Max && prevRof40Max > 20) {
      mult *= 1.5;
    }

    // 構造シグナル反復ペナルティ（前Qで同じ構造シグナル発火済みなら価値低下）
    if (prevQ) {
      const ps = prevQ.signals;
      const repeatStructural = ['redToBlack','rof40Cross40','rof40Cross60','rof40Cross80']
        .some(k => s[k] && ps[k]);
      if (repeatStructural) mult *= 0.25;
    }

    // モメンタムシグナル2つ以上継続ボーナス（構造変化が定着中）
    if (prevQ) {
      const ps = prevQ.signals;
      const persistCount = ['opMInflection','yoyAccelStrong','opLevHigh']
        .filter(k => s[k] && ps[k]).length;
      if (persistCount >= 2) mult *= 1.3;
    }

    q.signalScore = Math.min(100, Math.round(pts * mult));

    // 粗利率デルタ（QoQ）
    q.grMarginDelta = (q.grossMargin !== null && prevQ != null && prevQ.grossMargin !== null)
      ? +(q.grossMargin - prevQ.grossMargin).toFixed(1) : null;
    // 粗利率改善シグナル: +2pp以上
    q.grMarginSignal = q.grMarginDelta !== null && q.grMarginDelta >= 2;
    // 修正RoF40（Phase1用: YoY + 粗利率）
    q.rof40Gross = (q.revYoY !== null && q.grossMargin !== null)
      ? +(q.revYoY + q.grossMargin).toFixed(1) : null;
    // OpExレバレッジ: OpEx比率が前期より低下 = スケール効果出始め
    q.opExImproving = (q.opExRatio !== null && prevQ?.opExRatio != null)
      ? q.opExRatio < prevQ.opExRatio : null;
  }

  return { revA, cogsA, opA, netIncA, cashA, debtA, eqA, issA, bbA, apicA, reA, sharesLatest, sharesAnnual, trend };
}

// ── 4a. Yahoo Finance アナリスト予想データ ──────────
// Yahoo v10 quoteSummary and v7 quote require a session crumb and answer 401 to
// server requests (checked 2026-11-26). They are skipped rather than called and
// failed on every analysis; the fields stay empty exactly as when the calls failed.
const YAHOO_CRUMB_APIS = false;

async function getAnalystData(ticker) {
  try {
    if (!YAHOO_CRUMB_APIS) throw new Error('Yahoo quoteSummary requires a crumb (skipped)');
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=earningsHistory%2CearningsTrend`;
    const data = await fetchJson(url);
    const res = data?.quoteSummary?.result?.[0] ?? {};

    // 直近4四半期のEPS実績 vs 予想
    const histRaw = res.earningsHistory?.history ?? [];
    const epsHistory = histRaw.map(h => ({
      quarter:      h.quarter?.fmt ?? null,
      epsActual:    h.epsActual?.raw   ?? null,
      epsEstimate:  h.epsEstimate?.raw ?? null,
      beatPct:      h.surprisePercent?.raw ?? null,  // %
      epsDiff:      h.epsDifference?.raw ?? null,
    })).reverse(); // 古い順→新しい順

    // 今後の予想（今四半期・来四半期・今年度・来年度）
    const trendRaw = res.earningsTrend?.trend ?? [];
    const forwardEstimates = trendRaw.map(t => {
      const periodMap = { '0q': '今四半期', '+1q': '来四半期', '0y': '今年度', '+1y': '来年度' };
      return {
        period:       t.period ?? null,
        label:        periodMap[t.period] ?? t.period,
        endDate:      t.endDate?.fmt ?? null,
        revAvgM:      t.revenueEstimate?.avg?.raw ? +(t.revenueEstimate.avg.raw / 1_000_000).toFixed(0) : null,
        revLowM:      t.revenueEstimate?.low?.raw ? +(t.revenueEstimate.low.raw / 1_000_000).toFixed(0) : null,
        revHighM:     t.revenueEstimate?.high?.raw ? +(t.revenueEstimate.high.raw / 1_000_000).toFixed(0) : null,
        revGrowthPct: t.revenueEstimate?.growth?.raw != null ? +(t.revenueEstimate.growth.raw * 100).toFixed(1) : null,
        epsAvg:       t.earningsEstimate?.avg?.raw ?? null,
        epsLow:       t.earningsEstimate?.low?.raw ?? null,
        epsHigh:      t.earningsEstimate?.high?.raw ?? null,
        epsGrowthPct: t.earningsEstimate?.growth?.raw != null ? +(t.earningsEstimate.growth.raw * 100).toFixed(1) : null,
        analystCount: t.earningsEstimate?.numberOfAnalysts?.raw ?? null,
      };
    });

    // ビート率平均（直近4Q）
    const beatPcts = epsHistory.map(h => h.beatPct).filter(v => v !== null);
    const avgBeatPct = beatPcts.length > 0
      ? +(beatPcts.reduce((a, b) => a + b, 0) / beatPcts.length).toFixed(1) : null;
    // Beat加速度: 最古→最新でビート幅が拡大しているか
    const beatAccel = beatPcts.length >= 2
      ? +(beatPcts[beatPcts.length - 1] - beatPcts[0]).toFixed(1) : null;
    const maxBeatPct = beatPcts.length > 0 ? +Math.max(...beatPcts).toFixed(1) : null;

    // 目標株価 & アナリスト評価（financialData モジュール）
    let targetLowPrice = null, targetMeanPrice = null, targetHighPrice = null;
    let recommendationKey = null, numberOfAnalysts = null, recommendationBreakdown = null;
    try {
      const url2 = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData%2CrecommendationTrend`;
      const data2 = await fetchJson(url2);
      const fd  = data2?.quoteSummary?.result?.[0]?.financialData ?? {};
      const rec = (data2?.quoteSummary?.result?.[0]?.recommendationTrend?.trend ?? [])[0] ?? {};
      targetLowPrice   = fd.targetLowPrice?.raw  ?? null;
      targetMeanPrice  = fd.targetMeanPrice?.raw  ?? null;
      targetHighPrice  = fd.targetHighPrice?.raw  ?? null;
      recommendationKey = fd.recommendationKey    ?? null;
      numberOfAnalysts  = fd.numberOfAnalystOpinions?.raw ?? null;
      recommendationBreakdown = {
        strongBuy: rec.strongBuy ?? 0, buy: rec.buy ?? 0,
        hold: rec.hold ?? 0, sell: rec.sell ?? 0, strongSell: rec.strongSell ?? 0,
      };
    } catch(e2) { /* price target unavailable */ }

    return {
      epsHistory, forwardEstimates, avgBeatPct, beatAccel, maxBeatPct,
      targetLowPrice, targetMeanPrice, targetHighPrice,
      recommendationKey, numberOfAnalysts, recommendationBreakdown,
    };
  } catch (e) {
    if (YAHOO_CRUMB_APIS) console.error("Analyst data error:", e.message);
    return {
      epsHistory: [], forwardEstimates: [], avgBeatPct: null,
      beatAccel: null, maxBeatPct: null,
      targetLowPrice: null, targetMeanPrice: null, targetHighPrice: null,
      recommendationKey: null, numberOfAnalysts: null, recommendationBreakdown: null,
    };
  }
}

// ── 4b. 投資判断エンジン ─────────────────────────
function investmentJudgment(calc, analyst, companyPhase) {
  const signals = [];
  let bullScore = 0;   // プラス材料の合計点
  let bearScore = 0;   // マイナス材料の合計点

  // ── 成長性（TTM優先）──
  // FIX: missing growth is no longer treated as 0% ("普通" +5pt); it is reported as data-missing.
  const revGrowth = calc.ttmRevGrowth ?? calc.revGrowth ?? null;
  const revGrowthSrc = calc.ttmRevGrowth != null ? 'TTM' : '年次';
  const _rg = revGrowth != null ? revGrowth.toFixed(1) : '—';
  const _rs = revGrowthSrc;
  if (revGrowth == null)    { signals.push({ type: 'neutral', icon: '❔', text: '売上成長率データ不足（加点・減点なし）' }); }
  else if (revGrowth >= 50)      { bullScore += 25; signals.push({ type: 'bull', icon: '🔥', text: `売上成長率 +${_rg}%（化け物級）[${_rs}]` }); }
  else if (revGrowth >= 30) { bullScore += 18; signals.push({ type: 'bull', icon: '🚀', text: `売上成長率 +${_rg}%（高成長）[${_rs}]` }); }
  else if (revGrowth >= 16) { bullScore += 12; signals.push({ type: 'bull', icon: '📈', text: `売上成長率 +${_rg}%（注目水準）[${_rs}]` }); }
  else if (revGrowth >= 0)  { bullScore +=  5; signals.push({ type: 'neutral', icon: '➡️', text: `売上成長率 +${_rg}%（普通）[${_rs}]` }); }
  else                      { bearScore += 15; signals.push({ type: 'bear', icon: '📉', text: `売上マイナス成長 ${_rg}%[${_rs}]` }); }

  // ── 収益の質（原価率グレード）──
  const costLevel = calc.masyaCostGrade?.level ?? 0;
  if (costLevel >= 5)      { bullScore += 20; signals.push({ type: 'bull', icon: '🏆', text: '原価率<15%（化け物水準・強力な経済的堀）' }); }
  else if (costLevel >= 4) { bullScore += 15; signals.push({ type: 'bull', icon: '✨', text: '原価率<20%（優秀水準）' }); }
  else if (costLevel >= 3) { bullScore += 10; signals.push({ type: 'bull', icon: '✅', text: '原価率<30%（マシャ基準クリア）' }); }
  else if (costLevel <= 1) { bearScore += 10; signals.push({ type: 'bear', icon: '⚠️', text: '原価率50%超（収益の壁あり）' }); }

  // ── キャッシュリッチ ──
  if (calc.isCashRich) { bullScore += 10; signals.push({ type: 'bull', icon: '💰', text: 'キャッシュリッチ条件クリア' }); }
  else                 { bearScore +=  5; signals.push({ type: 'bear', icon: '❌', text: 'キャッシュリッチ条件未達' }); }

  // ── 10年後期待リターン（標準価格ベース）──
  const stdPrice = calc.standardPrice10yr;
  const curPrice = calc.price;
  const returnMult = (stdPrice && curPrice && curPrice > 0) ? stdPrice / curPrice : null;
  if (returnMult !== null) {
    if (returnMult >= 5)      { bullScore += 20; signals.push({ type: 'bull', icon: '🚀', text: `期待リターン ${returnMult.toFixed(1)}倍（年率CAGR ${((Math.pow(returnMult, 0.1) - 1) * 100).toFixed(0)}%）` }); }
    else if (returnMult >= 3) { bullScore += 15; signals.push({ type: 'bull', icon: '📈', text: `期待リターン ${returnMult.toFixed(1)}倍（年率${((Math.pow(returnMult, 0.1) - 1) * 100).toFixed(0)}%）` }); }
    else if (returnMult >= 2) { bullScore +=  8; signals.push({ type: 'bull', icon: '➡️', text: `期待リターン ${returnMult.toFixed(1)}倍（年率${((Math.pow(returnMult, 0.1) - 1) * 100).toFixed(0)}%）` }); }
    else if (returnMult >= 1) { bearScore +=  5; signals.push({ type: 'bear', icon: '⚡', text: `期待リターン ${returnMult.toFixed(1)}倍（低い）` }); }
    else                      { bearScore += 15; signals.push({ type: 'bear', icon: '🚨', text: `割高（現在株価が10年後目標超え）` }); }
  }

  // ── アナリストEPSビート ──
  const avgBeat = analyst.avgBeatPct;
  if (avgBeat !== null) {
    if (avgBeat >= 10)     { bullScore += 15; signals.push({ type: 'bull', icon: '🎯', text: `EPS平均ビート率 +${avgBeat}%（強力なサプライズ力）` }); }
    else if (avgBeat >= 5) { bullScore += 10; signals.push({ type: 'bull', icon: '✅', text: `EPS平均ビート率 +${avgBeat}%（安定ビート）` }); }
    else if (avgBeat >= 0) { bullScore +=  3; signals.push({ type: 'neutral', icon: '➡️', text: `EPS平均ビート率 +${avgBeat}%（微妙）` }); }
    else                   { bearScore += 10; signals.push({ type: 'bear', icon: '⚠️', text: `EPSミス傾向（平均${avgBeat}%）` }); }
  }

  // ── アナリスト予想成長率（来四半期売上）──
  const nextQEst = analyst.forwardEstimates?.find(e => e.period === '+1q');
  if (nextQEst?.revGrowthPct != null) {
    const g = nextQEst.revGrowthPct;
    if (g >= 30)     { bullScore += 10; signals.push({ type: 'bull', icon: '📊', text: `来四半期売上予想 +${g}%成長（アナリスト）` }); }
    else if (g >= 0) { bullScore +=  3; signals.push({ type: 'neutral', icon: '📊', text: `来四半期売上予想 +${g}%（アナリスト）` }); }
    else             { bearScore +=  8; signals.push({ type: 'bear', icon: '📊', text: `来四半期売上予想 ${g}%（前年割れ予測）` }); }
  }

  // ── 総合スコアと判定 ──
  const total = bullScore + bearScore;
  const bullRatio = total > 0 ? bullScore / total : 0.5;

  let judgment, judgmentColor, judgmentBg, judgmentEmoji;
  if      (bullRatio >= 0.80 && bullScore >= 60) { judgment = '強い買い';  judgmentColor = 'text-yellow-300'; judgmentBg = 'bg-yellow-500/20'; judgmentEmoji = '🔥'; }
  else if (bullRatio >= 0.65 && bullScore >= 40) { judgment = '買い';      judgmentColor = 'text-emerald-300'; judgmentBg = 'bg-emerald-500/20'; judgmentEmoji = '✅'; }
  else if (bullRatio >= 0.50 && bullScore >= 20) { judgment = '様子見';    judgmentColor = 'text-blue-300';  judgmentBg = 'bg-blue-500/20'; judgmentEmoji = '👀'; }
  else if (bullRatio >= 0.35)                    { judgment = '弱気';      judgmentColor = 'text-orange-300'; judgmentBg = 'bg-orange-500/20'; judgmentEmoji = '⚡'; }
  else                                           { judgment = '売り';      judgmentColor = 'text-red-300';  judgmentBg = 'bg-red-500/20'; judgmentEmoji = '🚨'; }

  return {
    judgment, judgmentColor, judgmentBg, judgmentEmoji,
    bullScore, bearScore,
    bullRatio: +(bullRatio * 100).toFixed(0),
    signals,
  };
}

// ── 撤退シグナルエンジン ────────────────────────────────────────────────────
// trend配列（新しい順）を受け取り、変曲点・警戒シグナルを定量スコア化する
function exitSignalEngine(trend) {
  if (!trend || trend.length < 4) return null;

  const signals = [];
  let exitScore = 0;

  // ── 1. YoY売上成長率の連続減速カウント ──────────────────────
  // trend[0]=最新、trend[1]=1期前...（新しい順）
  // YoY成長率が「前の四半期より低い」状態が何期続いているか
  let decelCount = 0;
  for (let i = 0; i < Math.min(trend.length - 1, 6); i++) {
    const curr = trend[i]?.revYoY;
    const prev = trend[i + 1]?.revYoY;
    if (curr != null && prev != null && curr < prev) {
      decelCount++;
    } else {
      break; // 連続が途切れたら終了
    }
  }
  if (decelCount >= 3) {
    exitScore += 30;
    signals.push({ level: 'danger', icon: '🚨', text: `売上YoY成長率が${decelCount}四半期連続で減速中（最重要警戒）` });
  } else if (decelCount === 2) {
    exitScore += 18;
    signals.push({ level: 'warning', icon: '⚠️', text: `売上YoY成長率が2四半期連続で減速（注意）` });
  } else if (decelCount === 1) {
    exitScore += 7;
    signals.push({ level: 'caution', icon: '👀', text: `売上YoY成長率が直近1四半期で減速（経過観察）` });
  } else {
    signals.push({ level: 'ok', icon: '✅', text: `売上YoY成長率は加速・維持中` });
  }

  // ── 2. 売上成長率の絶対水準低下 ──────────────────────────────
  const latestYoY = trend[0]?.revYoY ?? null;
  const prev4YoY  = trend[4]?.revYoY ?? null;  // 1年前の成長率
  if (latestYoY != null) {
    if (latestYoY < 0) {
      exitScore += 25;
      signals.push({ level: 'danger', icon: '🚨', text: `売上がマイナス成長（${latestYoY.toFixed(1)}% YoY）— 最大の撤退シグナル` });
    } else if (latestYoY < 10 && prev4YoY != null && prev4YoY >= 30) {
      exitScore += 20;
      signals.push({ level: 'danger', icon: '🚨', text: `成長率が急落（1年前 +${prev4YoY.toFixed(0)}% → 現在 +${latestYoY.toFixed(1)}%）` });
    } else if (latestYoY < 15 && prev4YoY != null && prev4YoY >= 50) {
      exitScore += 15;
      signals.push({ level: 'warning', icon: '⚠️', text: `高成長から普通成長へ移行中（+${prev4YoY.toFixed(0)}% → +${latestYoY.toFixed(1)}%）` });
    }
  }

  // ── 3. 営業利益率（OpM）の継続的圧縮 ───────────────────────────
  const margins = trend.slice(0, 5).map(q => q?.opMargin ?? null).filter(v => v != null);
  if (margins.length >= 3) {
    const latestM = margins[0];
    const avg3prev = (margins[1] + margins[2] + (margins[3] ?? margins[2])) / 3;
    const marginDrop = avg3prev - latestM;
    if (marginDrop > 8) {
      exitScore += 20;
      signals.push({ level: 'danger', icon: '🚨', text: `営業利益率が急速に圧縮（3期平均比 -${marginDrop.toFixed(1)}pt）` });
    } else if (marginDrop > 4) {
      exitScore += 12;
      signals.push({ level: 'warning', icon: '⚠️', text: `営業利益率が低下傾向（3期平均比 -${marginDrop.toFixed(1)}pt）` });
    } else if (marginDrop < -4) {
      signals.push({ level: 'ok', icon: '✅', text: `営業利益率が改善中（3期平均比 +${Math.abs(marginDrop).toFixed(1)}pt）` });
    } else {
      signals.push({ level: 'ok', icon: '✅', text: `営業利益率は安定（${latestM?.toFixed(1)}% OpM）` });
    }
  }

  // ── 4. 営業レバレッジの反転（コスト先行）─────────────────────
  // opLeverageが連続してマイナスまたは1倍未満 = 売上増加でも利益が伸びていない
  const opLevs = trend.slice(0, 4).map(q => q?.opLeverage ?? null).filter(v => v != null);
  const negLevCount = opLevs.filter(v => v < 1.0).length;
  if (negLevCount >= 3) {
    exitScore += 15;
    signals.push({ level: 'warning', icon: '⚠️', text: `営業レバレッジが3期連続1倍未満（売上増加の恩恵が利益に届いていない）` });
  } else if (negLevCount >= 2) {
    exitScore += 7;
    signals.push({ level: 'caution', icon: '👀', text: `営業レバレッジが低下傾向（コスト効率の悪化に注意）` });
  }

  // ── 5. 原価率の上昇トレンド ──────────────────────────────────
  const costs = trend.slice(0, 5).map(q => q?.costRatio ?? null).filter(v => v != null);
  if (costs.length >= 3) {
    const costTrend = costs[0] - costs[2]; // 最新 - 2期前
    if (costTrend > 0.06) {
      exitScore += 12;
      signals.push({ level: 'warning', icon: '⚠️', text: `原価率が上昇中（${(costs[2]*100).toFixed(1)}% → ${(costs[0]*100).toFixed(1)}%）— 競争激化or値下げ圧力` });
    } else if (costTrend > 0.03) {
      exitScore += 6;
      signals.push({ level: 'caution', icon: '👀', text: `原価率が微増（${(costs[2]*100).toFixed(1)}% → ${(costs[0]*100).toFixed(1)}%）— 経過観察` });
    } else if (costTrend < -0.03) {
      signals.push({ level: 'ok', icon: '✅', text: `原価率が改善中（${(costs[2]*100).toFixed(1)}% → ${(costs[0]*100).toFixed(1)}%）` });
    }
  }

  // ── 6. RoF40スコアの低下 ─────────────────────────────────────
  const rof40s = trend.slice(0, 4).map(q => q?.rof40 ?? null).filter(v => v != null);
  if (rof40s.length >= 3) {
    const rof40Now = rof40s[0];
    const rof40Prev = rof40s[2];
    if (rof40Now < 40 && rof40Prev >= 60) {
      exitScore += 15;
      signals.push({ level: 'danger', icon: '🚨', text: `RoF40が60超から40未満に急落（${rof40Prev}→${rof40Now}）— 成長×収益の劣化` });
    } else if (rof40Now < rof40Prev - 30) {
      exitScore += 10;
      signals.push({ level: 'warning', icon: '⚠️', text: `RoF40が大幅低下（${rof40Prev}→${rof40Now}）` });
    }
  }

  // ── 総合撤退レベル判定 ───────────────────────────────────────
  let exitLevel, exitColor, exitBg, exitEmoji, exitLabel;
  if (exitScore >= 55) {
    exitLevel = 'danger';   exitColor = 'text-red-300';    exitBg = 'bg-red-500/15';
    exitEmoji = '🚨'; exitLabel = '撤退検討';
  } else if (exitScore >= 35) {
    exitLevel = 'warning';  exitColor = 'text-orange-300'; exitBg = 'bg-orange-500/15';
    exitEmoji = '⚠️'; exitLabel = '警戒';
  } else if (exitScore >= 18) {
    exitLevel = 'caution';  exitColor = 'text-yellow-300'; exitBg = 'bg-yellow-500/15';
    exitEmoji = '👀'; exitLabel = '注意';
  } else {
    exitLevel = 'ok';       exitColor = 'text-emerald-300'; exitBg = 'bg-emerald-500/15';
    exitEmoji = '✅'; exitLabel = '継続保有';
  }

  return {
    exitScore, exitLevel, exitColor, exitBg, exitEmoji, exitLabel,
    decelCount, signals,
  };
}

// ── 4. Yahoo Finance 株価データ ─────────────────
async function getMarketData(ticker) {
  let currentPrice = null, marketCap = null, peak2021 = null, sharesOutstanding = null;

  try {
    // FIX: 2021 peak needs history back to Jan 2021 (range=5y no longer reaches it).
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=10y`;
    const data = await fetchJson(url);
    const meta   = data?.chart?.result?.[0]?.meta ?? {};
    const quotes = data?.chart?.result?.[0]?.indicators?.quote?.[0] ?? {};
    const timestamps = data?.chart?.result?.[0]?.timestamp ?? [];

    currentPrice      = meta.regularMarketPrice ?? meta.chartPreviousClose;
    sharesOutstanding = meta.sharesOutstanding ?? null;
    marketCap         = meta.marketCap ?? null;

    const highs = quotes.high ?? [];
    let max21 = 0;
    timestamps.forEach((ts, i) => {
      const d = new Date(ts * 1000);
      if (d.getFullYear() === 2021 && highs[i]) max21 = Math.max(max21, highs[i]);
    });
    peak2021 = max21 > 0 ? max21 : null;
  } catch (e) {
    console.error("Yahoo chart API error:", e.message);
  }

  if (!marketCap && YAHOO_CRUMB_APIS) {
    try {
      const url2 = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${ticker}`;
      const data2 = await fetchJson(url2);
      const q = data2?.quoteResponse?.result?.[0] ?? {};
      if (!marketCap)         marketCap         = q.marketCap ?? null;
      if (!currentPrice)      currentPrice      = q.regularMarketPrice ?? null;
      if (!sharesOutstanding) sharesOutstanding = q.sharesOutstanding ?? null;
    } catch (e) {
      console.error("Yahoo quote API error:", e.message);
    }
  }

  return { currentPrice, marketCap, peak2021, sharesOutstanding };
}

// ── 5a. マシャ原価率5段階評価 ────────────────────
function masyaCostGrade(costRatio) {
  if (costRatio === null) return { level: 0, label: "データ不足", color: "gray", badge: "—" };
  if (costRatio < 0.15) return { level: 5, label: "最強・化け物級", color: "gold",   badge: "🏆 最強<15%" };
  if (costRatio < 0.20) return { level: 4, label: "優秀",          color: "emerald", badge: "✨ 優秀<20%" };
  if (costRatio < 0.30) return { level: 3, label: "良（マシャ基準）", color: "green", badge: "✅ 良<30%" };
  if (costRatio < 0.50) return { level: 2, label: "合格（バフェット水準）", color: "yellow", badge: "⚡ 合格<50%" };
  if (costRatio < 0.70) return { level: 1, label: "要注意",         color: "orange", badge: "⚠️ 要注意" };
  return                       { level: 0, label: "危険水域",        color: "red",    badge: "🚨 危険" };
}

// 売上成長率カテゴリ（マシャ基準）
function growthCategory(revGrowthPct) {
  if (revGrowthPct === null) return { label: "データ不足", color: "gray" };
  if (revGrowthPct >= 50)  return { label: "🔥 化け物（+50%超）",    color: "gold" };
  if (revGrowthPct >= 30)  return { label: "🚀 高成長（+30-50%）",   color: "emerald" };
  if (revGrowthPct >= 16)  return { label: "📈 注目（+16-30%）",     color: "green" };
  if (revGrowthPct >= 0)   return { label: "➡️ 普通成長",           color: "yellow" };
  return                          { label: "📉 マイナス成長",         color: "red" };
}

// ── 5b. 業種別PERレンジ（マシャ式10年後株価推定用）────
const SECTOR_PER = {
  software:      { bear: 40, standard: 60, name: 'SaaS/ソフトウェア' },
  internet:      { bear: 25, standard: 40, name: 'インターネット/プラットフォーム' },
  semiconductor: { bear: 20, standard: 30, name: '半導体' },
  default:       { bear: 25, standard: 40, name: 'テック成長株' },
  manufacturing: { bear: 12, standard: 18, name: '製造業' },
  energy:        { bear:  8, standard: 12, name: 'エネルギー' },
};

// 業種別 成熟時 目標営業利益率
const SECTOR_TARGET_OPM = {
  software: 30, internet: 25, semiconductor: 22,
  default: 20,  manufacturing: 12, energy: 10,
};

// ── 5a. 業種別原価率基準 ─────────────────────────
const SECTOR_COST_THRESHOLD = {
  software:      { limit: 0.30, label: "SaaS/ソフトウェア基準" },
  internet:      { limit: 0.40, label: "インターネット基準" },
  default:       { limit: 0.50, label: "バフェット水準" },
  semiconductor: { limit: 0.65, label: "半導体業界基準" },
  manufacturing: { limit: 0.70, label: "製造業基準" },
  energy:        { limit: 0.80, label: "エネルギー業界基準" },
};

function inferSector(ticker, revNow, cogsNow) {
  const t = ticker.toUpperCase();
  if (["AMD","NVDA","MU","QCOM","ARM","INTC","AVGO","TSM","SNDK","AMAT","LRCX"].includes(t)) return "semiconductor";
  if (["PLTR","MNDY","NOW","FRSH","CRM","SNOW","DDOG","NET","ZS","CRWD","INOD","GRRR"].includes(t)) return "software";
  if (["APP","TTD","META","GOOGL","GOOG","AMZN","PINS","RKLB"].includes(t)) return "internet";
  if (["CLF","X","NUE","FCX","CVX","XOM","SLB"].includes(t)) return "energy";
  if (["GE","BA","CAT","HON","DE","MMM"].includes(t)) return "manufacturing";
  if (cogsNow && revNow) {
    const r = cogsNow / revNow;
    if (r < 0.30) return "software";
    if (r < 0.45) return "internet";
    if (r < 0.60) return "default";
    if (r < 0.72) return "semiconductor";
    if (r < 0.82) return "manufacturing";
    return "energy";
  }
  return "default";
}

// ── 5. マシャ式計算エンジン ──────────────────────
function masyaCalc(fin, mkt, ticker) {
  const M = 1_000_000;
  const v  = (arr, idx = 0) => arr?.[idx]?.val ?? null;
  const vM = (arr, idx = 0) => { const x = v(arr, idx); return x !== null ? x / M : null; };

  const revNow   = vM(fin.revA, 0);
  const revPrev  = vM(fin.revA, 1);
  const revGrowthRaw = (revNow && revPrev && revPrev > 0) ? ((revNow / revPrev) - 1) * 100 : null;
  const revGrowth = revGrowthRaw !== null ? Math.max(-100, Math.min(2000, revGrowthRaw)) : null;
  const cogsNow  = vM(fin.cogsA, 0);
  const costRatio = (cogsNow && revNow) ? cogsNow / revNow : null;
  const opNow    = vM(fin.opA, 0);
  const opPrev   = vM(fin.opA, 1);

  // 年次純利益
  const niNow  = vM(fin.netIncA, 0);
  const niPrev = vM(fin.netIncA, 1);

  const op2021E  = (fin.opA ?? []).find(d => d.end?.startsWith("2021"));
  const op2021   = op2021E ? op2021E.val / M : null;
  const op2020E  = (fin.opA ?? []).find(d => d.end?.startsWith("2020"));
  const op2020   = op2020E ? op2020E.val / M : null;

  const cashNow    = vM(fin.cashA, 0);
  const debtNow    = vM(fin.debtA, 0);
  const equityNow  = vM(fin.eqA,   0);
  const issuedNow  = vM(fin.issA,  0) ?? 0;
  const buybackNow = vM(fin.bbA,   0) ?? 0;

  // ── マシャ式 株主還元分析 ────────────────────────
  // 累計自社株買い（取得可能な全年分の合計、$M）
  const buybackYears   = (fin.bbA ?? []).map(d => d.val / M).filter(v => v != null);
  const cumBuyback     = buybackYears.reduce((a, b) => a + b, 0);
  const cumBuybackN    = buybackYears.length;
  // 資本の部の変化（最古の取得年 vs 現在）— 過度な還元の検知
  const eqArr          = (fin.eqA ?? []).map(d => ({ end: d.end, v: d.val / M })).filter(d => d.v != null);
  const equityOldest   = eqArr.length >= 2 ? eqArr[eqArr.length - 1].v : null;
  const equityOldestYr = eqArr.length >= 2 ? eqArr[eqArr.length - 1].end?.slice(0, 4) : null;
  const equityChangeRate = (equityNow !== null && equityOldest && equityOldest !== 0)
    ? (equityNow - equityOldest) / Math.abs(equityOldest) : null;
  // 資本の部の内訳（資本剰余金 / 利益剰余金 / その他）
  const apicNow = vM(fin.apicA, 0);
  const reNow   = vM(fin.reA,   0);
  const eqOther = (equityNow !== null && apicNow !== null && reNow !== null)
    ? +(equityNow - apicNow - reNow).toFixed(0) : null;
  // 年間株数減少率（直近 vs 1年前、％。マイナス=減少=還元）
  const shrNow  = fin.sharesAnnual?.[0]?.val ?? null;
  const shrPrev = fin.sharesAnnual?.[1]?.val ?? null;
  const shareChangePct = (shrNow && shrPrev && shrPrev !== 0)
    ? +((shrNow - shrPrev) / shrPrev * 100).toFixed(1) : null;

  const price  = mkt.currentPrice;
  const mktcap = mkt.marketCap ? mkt.marketCap / M : null;
  const peak21 = mkt.peak2021;

  const sector     = inferSector(ticker, revNow, cogsNow);
  const sectorInfo = SECTOR_COST_THRESHOLD[sector];
  const threshold  = sectorInfo.limit;

  let buffettGrade, buffettColor;
  if      (costRatio === null)             { buffettGrade = "データ不足"; buffettColor = "gray"; }
  else if (costRatio < 0.15)               { buffettGrade = `✅ 驚異的低コスト（原価率${pct(costRatio)}）— PLTRクラス`; buffettColor = "green"; }
  else if (costRatio <= threshold)         { buffettGrade = `✅ バフェット水準クリア（原価率${pct(costRatio)}）[${sectorInfo.label}]`; buffettColor = "green"; }
  else if (costRatio < threshold * 1.15)   { buffettGrade = `🔶 業界水準ギリギリ（原価率${pct(costRatio)}）[基準:${pct(threshold)}]`; buffettColor = "yellow"; }
  else if (costRatio < 1.00)               { buffettGrade = `❌ バフェット水準クリアせず（原価率${pct(costRatio)}）[基準:${pct(threshold)}]`; buffettColor = "orange"; }
  else                                     { buffettGrade = `🚨 危険水域（原価率${pct(costRatio)}）ビジネスになっていない`; buffettColor = "red"; }

  const dilutionRatio = (mktcap && issuedNow) ? issuedNow / mktcap : 0;
  let dilutionDiscount, dilutionComment;
  if      (dilutionRatio < 0.03)  { dilutionDiscount = 1.0;  dilutionComment = "軽微（補正なし）"; }
  else if (dilutionRatio < 0.10)  { dilutionDiscount = 0.85; dilutionComment = `希薄化${pct(dilutionRatio)} → ▲15%補正`; }
  else if (dilutionRatio < 0.25)  { dilutionDiscount = 0.70; dilutionComment = `希薄化${pct(dilutionRatio)} → ▲30%補正`; }
  else                             { dilutionDiscount = 0.50; dilutionComment = `🚨 重大な希薄化${pct(dilutionRatio)} → ▲50%補正`; }

  const buybackRatio = (mktcap && buybackNow) ? buybackNow / mktcap : 0;
  // マシャ式: 累計自社株買い比率でピーク株価を底上げ（上限+60%）
  const cumBuybackRatio = (mktcap && cumBuyback > 0) ? cumBuyback / mktcap : 0;
  const buybackUplift   = 1 + Math.min(cumBuybackRatio, 0.60);

  // マシャ式: 資本の部ペナルティ — 過度な還元で資本の部が減少した分、会計目標(保守値)を割引く
  // （ポテンシャル/奥義には適用しない＝上値は相殺しない）
  let equityPenalty = 1.0, overBuyback = false;
  if (equityChangeRate !== null && equityChangeRate < 0) {
    equityPenalty = Math.max(0.5, 1 + equityChangeRate * 0.5); // 資本減少の半分を保守値に反映
    overBuyback   = cumBuybackRatio > 0.10; // 自社株買いを伴う資本減少＝行き過ぎた還元
  }

  const baseProfitYear = op2021 ?? op2020 ?? opPrev;
  let profitMultiple, profitNote;
  if      (baseProfitYear === null || opNow === null) { profitMultiple = 1.0; profitNote = "データ不足 → 倍率1.0x"; }
  else if (baseProfitYear < 0 && opNow > 0)           { profitMultiple = Math.min(10, 2.0 + (opNow / Math.abs(baseProfitYear))); profitNote = `赤字→黒字転換ボーナス: ${profitMultiple.toFixed(2)}x`; }
  else if (baseProfitYear < 0 && opNow < 0)           { profitMultiple = Math.max(0.1, 1 + opNow / Math.abs(baseProfitYear)); profitNote = `赤字継続: ${profitMultiple.toFixed(2)}x`; }
  else if (baseProfitYear > 0 && opNow >= 0)          { profitMultiple = Math.min(10, opNow / baseProfitYear); profitNote = `利益成長: ${profitMultiple.toFixed(2)}x`; }
  else if (baseProfitYear > 0 && opNow < 0)           { profitMultiple = 0.1; profitNote = `黒字→赤字転落 → 最小倍率0.1x`; }
  else                                                { profitMultiple = 1.0; profitNote = "計算不可 → 1.0x"; }

  let accountingPrice = null, potentialPrice = null, leveragePrice = null;
  if (peak21 && profitMultiple) {
    const base = peak21 * dilutionDiscount * buybackUplift;
    potentialPrice  = base * profitMultiple;            // ポテンシャル（資本減少を相殺しない上値）
    accountingPrice = potentialPrice * equityPenalty;   // 会計目標（資本減少を反映した保守値）
    leveragePrice   = potentialPrice * 2.0;             // 奥義
    // 現在値の50倍超 = ピーク比97%超下落などで計算破綻 → null化
    if (price && accountingPrice > price * 50) {
      accountingPrice = null; potentialPrice = null; leveragePrice = null;
    }
  }

  const perCalc = (mktcap && opNow && opNow > 0) ? mktcap / opNow : null;
  let perComment;
  if      (!perCalc)        perComment = "計算不可（赤字）";
  else if (perCalc < 30)    perComment = `PER ${perCalc.toFixed(0)}倍 — 通常の成長企業水準`;
  else if (perCalc < 70)    perComment = `PER ${perCalc.toFixed(0)}倍 — 期待されている成長企業`;
  else if (perCalc < 100)   perComment = `PER ${perCalc.toFixed(0)}倍 — 高い成長が期待されている`;
  else                      perComment = `PER ${perCalc.toFixed(0)}倍 — 非常に高い期待水準`;

  const bsOk = equityNow !== null && equityNow > 0;
  const bsComment = equityNow === null ? "データ不足"
    : bsOk ? `✅ 資本の部プラス（$${fmt(equityNow)}M）— 健全`
    :         `🚨 債務超過（$${fmt(equityNow)}M）— 倒産リスク`;

  let score = 0;
  if (costRatio !== null && costRatio < 0.50) score += 2;
  if (bsOk) score += 1;
  if (cashNow && cashNow > 0) score += 1;
  if (opNow && opNow > 0) score += 2;
  if (dilutionRatio < 0.05) score += 1;
  if (debtNow !== null && revNow && debtNow < revNow) score += 1;

  let verdict, verdictColor;
  if      (score >= 7) { verdict = "⭐⭐⭐ 会計上の優良企業"; verdictColor = "green"; }
  else if (score >= 5) { verdict = "⭐⭐  良好";              verdictColor = "blue"; }
  else if (score >= 3) { verdict = "⭐   要注意";             verdictColor = "yellow"; }
  else                 { verdict = "⚠️  投資要注意";          verdictColor = "red"; }

  const priceGap = (accountingPrice && price) ? ((accountingPrice / price) - 1) * 100 : null;

  // ── マシャ式 10年後EPS×PER 3価格モデル ────────────
  const perRange = SECTOR_PER[sector] ?? SECTOR_PER.default;
  const targetOpm = SECTOR_TARGET_OPM[sector] ?? 20;

  // 売上CAGR（3年実績 or 1年実績）
  const rev3yrAgo = vM(fin.revA, 2);
  const rev2yrAgo = vM(fin.revA, 1);
  let revCAGR = null;
  if (rev3yrAgo && rev3yrAgo > 0 && revNow) {
    revCAGR = Math.pow(revNow / rev3yrAgo, 1/3) - 1;
  } else if (rev2yrAgo && rev2yrAgo > 0 && revNow) {
    revCAGR = Math.sqrt(revNow / rev2yrAgo) - 1;
  } else if (revGrowth !== null) {
    revCAGR = revGrowth / 100;
  }

  // 10年間の成長率: 超高成長は保守的に調整（長期で鈍化する想定）
  let projectedCAGR = revCAGR ?? 0.10;
  if (projectedCAGR > 0.50)      projectedCAGR = (projectedCAGR + 0.20) / 2; // 50%超→平均化
  else if (projectedCAGR > 0.30) projectedCAGR = projectedCAGR * 0.80;       // 30-50%→80%に圧縮
  projectedCAGR = Math.max(Math.min(projectedCAGR, 0.40), 0.02);             // 上限40%/下限2%

  // 10年後売上推定（$M）
  const rev10yr = revNow ? revNow * Math.pow(1 + projectedCAGR, 10) : null;

  // 調整後営業利益率（直近4Q平均）: adjOpMargin 優先、なければ GAAP opMargin
  const recentOpMs = (fin.trend ?? []).slice(0, 4)
    .map(q => q.adjOpMargin ?? q.opMargin).filter(m => m !== null && !isNaN(m));
  const avgCurrentOpM = recentOpMs.length > 0
    ? recentOpMs.reduce((a, b) => a + b, 0) / recentOpMs.length : null;
  // GAAP opMargin も別途保持（UI表示用）
  const recentGaapOpMs = (fin.trend ?? []).slice(0, 4)
    .map(q => q.opMargin).filter(m => m !== null && !isNaN(m));
  const avgGaapOpM = recentGaapOpMs.length > 0
    ? +(recentGaapOpMs.reduce((a, b) => a + b, 0) / recentGaapOpMs.length).toFixed(1) : null;
  const hasAmortAdj = (fin.trend ?? []).slice(0, 4).some(q => q.amortM !== null && q.amortM > 0);

  // 目標営業利益率: 現在値 or セクター目標の高い方（上限45%）
  const projectedOpmPct = Math.min(
    Math.max(avgCurrentOpM ?? 0, targetOpm),
    45
  );
  const projectedOpmRate = projectedOpmPct / 100;

  // 10年後純利益（営業利益率 × 売上 × 0.75 で税・少数株主調整）
  const ni10yr = rev10yr ? rev10yr * projectedOpmRate * 0.75 : null;

  // 発行済株式数（百万株）
  const sharesM = mkt.sharesOutstanding
    ? mkt.sharesOutstanding / 1_000_000
    : (fin.sharesLatest ? fin.sharesLatest / 1_000_000 : null);

  // TTM EPS（直近4四半期合計）
  const ttmEpsArr = (fin.trend ?? []).slice(0, 4)
    .map(q => q.epsQ).filter(e => e !== null);
  const ttmEps = ttmEpsArr.length === 4
    ? +ttmEpsArr.reduce((a, b) => a + b, 0).toFixed(4) : null;

  // ── TTM財務指標（直近4四半期合算）── 年次データのタイムラグを補正
  const ttm4Q  = (fin.trend ?? []).slice(0, 4);
  const prev4Q = (fin.trend ?? []).slice(4, 8);
  const _sum = (arr, key) => arr.map(q => q[key]).filter(v => v != null).reduce((a, b) => a + b, 0);
  const _ok  = (arr, key, n = 3) => arr.filter(q => q[key] != null).length >= n;
  const ttmRevSum  = _sum(ttm4Q, 'revM');
  const ttmCogsSum = _sum(ttm4Q, 'cogsM');
  const ttmOpSum   = _sum(ttm4Q, 'opM');
  const ttmRevOk   = _ok(ttm4Q, 'revM');
  const prevRevSum = _sum(prev4Q, 'revM');
  const prevRevOk  = _ok(prev4Q, 'revM');
  const prevOpSum  = _sum(prev4Q, 'opM');
  const prevOpOk   = _ok(prev4Q, 'opM');
  // TTM原価率・TTM営業利益率・TTM売上成長率
  const ttmCostRatio   = (ttmRevOk && ttmCogsSum > 0 && ttmRevSum > 0) ? ttmCogsSum / ttmRevSum : null;
  const ttmOpMarginPct = (ttmRevOk && ttmRevSum > 0) ? +(ttmOpSum / ttmRevSum * 100).toFixed(1) : null;
  const ttmRevGrowth   = (ttmRevOk && prevRevOk && prevRevSum > 0)
    ? Math.max(-100, Math.min(2000, (ttmRevSum / prevRevSum - 1) * 100)) : null;
  // 投資判断に使う「実効値」: TTM優先、なければ年次
  const effectiveCostRatio = ttmCostRatio ?? costRatio;

  // 10年後EPS（$）— sharesM > 1M株 かつ EPS < $500 のサニティガード
  const eps10yr = (ni10yr !== null && sharesM && sharesM > 1)
    ? +(ni10yr / sharesM).toFixed(2) : null;  // ni10yr は $M 単位、sharesM は百万株
  const eps10yrSafe = (eps10yr !== null && Math.abs(eps10yr) < 500) ? eps10yr : null;

  // 3価格モデル
  const bearPrice10yr     = eps10yrSafe ? +(eps10yrSafe * perRange.bear).toFixed(2)         : null;
  const standardPrice10yr = eps10yrSafe ? +(eps10yrSafe * perRange.standard).toFixed(2)     : null;
  const bullPrice10yr     = eps10yrSafe ? +(eps10yrSafe * perRange.standard * 2).toFixed(2) : null; // 奥義

  // EPS 年次成長率（純利益ベース）
  const epsGrowthYoY = (niNow !== null && niPrev !== null && niPrev !== 0)
    ? +((niNow - niPrev) / Math.abs(niPrev) * 100).toFixed(1) : null;

  // ── マシャ指標 ────────────────────────────────────
  // 原価率5段階評価（TTM優先）
  const masyaCostGradeResult = masyaCostGrade(effectiveCostRatio);

  // 営業利益成長率（年次）
  const opGrowthYoY = (opNow !== null && opPrev !== null && opPrev !== 0)
    ? +((opNow / Math.abs(opPrev) - (opPrev > 0 ? 1 : -1)) * 100).toFixed(1) : null;
  // 簡易版: YoY成長率
  const opGrowthSimple = (opNow !== null && opPrev !== null && opPrev !== 0)
    ? +((opNow - opPrev) / Math.abs(opPrev) * 100).toFixed(1) : null;

  // キャッシュリッチ判定（マシャ2条件）— TTM優先
  // 条件1: 原価率 < 50%（TTM優先）
  // 条件2: 営業利益 前年比プラス（TTM合算優先、なければ年次）
  const cashRichCond1 = effectiveCostRatio !== null && effectiveCostRatio < 0.50;
  const cashRichCond2_ttm = (ttmRevOk && prevOpOk) ? ttmOpSum > prevOpSum : null;
  const cashRichCond2 = cashRichCond2_ttm ?? (opGrowthSimple !== null && opGrowthSimple > 0);
  const isCashRich = cashRichCond1 && !!cashRichCond2;

  // 売上成長率カテゴリ
  const growthCategoryResult = growthCategory(revGrowth);

  // 営業利益率カテゴリ（マシャ基準）— TTM優先
  const latestOpMargin = ttmOpMarginPct ??
    ((opNow !== null && revNow !== null && revNow > 0)
      ? Math.max(-500, Math.min(100, opNow / revNow * 100)) : null);
  let opMarginCategory;
  if (latestOpMargin === null) opMarginCategory = { label: "データ不足", color: "gray" };
  else if (latestOpMargin >= 70) opMarginCategory = { label: "🏆 最強（70%超）", color: "gold" };
  else if (latestOpMargin >= 25) opMarginCategory = { label: "✨ 優秀（25%超）", color: "emerald" };
  else if (latestOpMargin >= 15) opMarginCategory = { label: "✅ キャッシュリッチ水準（15%超）", color: "green" };
  else if (latestOpMargin >= 0)  opMarginCategory = { label: "⚡ 黒字", color: "yellow" };
  else                           opMarginCategory = { label: "📉 赤字", color: "red" };

  // マシャ総合スコア（0-100）
  let masyaScore = 0;
  masyaScore += masyaCostGradeResult.level * 10;  // 原価率: 0-50点
  if (isCashRich) masyaScore += 15;               // キャッシュリッチ: 15点
  if (revGrowth !== null) {
    if (revGrowth >= 50) masyaScore += 20;
    else if (revGrowth >= 30) masyaScore += 15;
    else if (revGrowth >= 16) masyaScore += 10;
    else if (revGrowth >= 0)  masyaScore += 5;
  }
  if (latestOpMargin !== null && latestOpMargin > 0) masyaScore += 5;  // 黒字: 5点
  if (bsOk) masyaScore += 5;
  masyaScore = Math.min(100, masyaScore);

  return {
    revNow, revPrev, revGrowth, cogsNow, costRatio, buffettGrade, buffettColor,
    opNow, opPrev, op2021, op2020, profitMultiple, profitNote,
    cashNow, debtNow, equityNow, bsComment, bsOk,
    issuedNow, buybackNow, dilutionRatio, dilutionComment, buybackRatio,
    peak21, dilutionDiscount, accountingPrice, potentialPrice, leveragePrice, priceGap,
    // マシャ式 株主還元分析
    cumBuyback: +cumBuyback.toFixed(0), cumBuybackN, cumBuybackRatio: +(Math.min(cumBuybackRatio, 1.0) * 100).toFixed(1),
    buybackUplift: +buybackUplift.toFixed(3),
    equityChangeRate: equityChangeRate !== null ? +(Math.max(-2, Math.min(20, equityChangeRate)) * 100).toFixed(1) : null,
    equityOldestYr, equityPenalty: +equityPenalty.toFixed(3), overBuyback,
    apicNow, reNow, eqOther, shareChangePct,
    perCalc, perComment, score, verdict, verdictColor, price, mktcap, baseProfitYear,
    sector, sectorLabel: sectorInfo.label, costThreshold: threshold,
    // マシャ指標
    masyaCostGrade: masyaCostGradeResult,
    growthCategory: growthCategoryResult,
    opGrowthSimple, latestOpMargin, opMarginCategory,
    cashRichCond1, cashRichCond2, isCashRich,
    masyaScore,
    // 10年後EPS×PER 3価格モデル
    ttmEps, eps10yr: eps10yrSafe, rev10yr, ni10yr,
    // TTM vs 年次（フロント参考表示用）
    ttmCostRatio, ttmOpMarginPct, ttmRevGrowth,
    costRatioAnn: costRatio, revGrowthAnn: revGrowth,
    revCAGR: revCAGR !== null ? +(revCAGR * 100).toFixed(1) : null,
    projectedCAGR: +(projectedCAGR * 100).toFixed(1),
    projectedOpmPct,
    sharesM,
    bearPrice10yr, standardPrice10yr, bullPrice10yr,
    projectedOpmGaap: avgGaapOpM,
    hasAmortAdj,
    perBear: perRange.bear, perStandard: perRange.standard,
    perName: perRange.name,
    epsGrowthYoY,
    niNow, niPrev,
  };
}

function pct(v)       { return v !== null ? `${(v * 100).toFixed(1)}%` : "N/A"; }
function fmt(v, d = 1){ return v !== null ? v.toLocaleString("en-US", { maximumFractionDigits: d }) : "N/A"; }

// ── Netlify Handler ──────────────────────────────
export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type":                 "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: cors, body: "" };

  const ticker = (event.queryStringParameters?.ticker ?? "").toUpperCase().trim();
  if (!ticker) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "tickerパラメータが必要です" }) };

  try {
    const [{ cik, name }, mkt, analyst, outlook] = await Promise.all([getCik(ticker), getMarketData(ticker), getAnalystData(ticker),
      earningsOutlook(ticker).catch(() => ({ error: 'アナリスト予想を取得できませんでした' }))]);
    const [filings, fin]                = await Promise.all([getLatestFilings(cik), getFinancials(cik)]);

    if (!mkt.marketCap && fin.sharesLatest && mkt.currentPrice) {
      mkt.marketCap         = fin.sharesLatest * mkt.currentPrice;
      mkt.sharesOutstanding = fin.sharesLatest;
    }

    const calc = masyaCalc(fin, mkt, ticker);

    // ── PEG・R&D効率・インクリメンタルROIC ───────────
    {
      const M = 1_000_000;
      // Forward PEG = (Price / TTM EPS) / 来年度EPS成長率%
      const fwdEpsG = analyst.forwardEstimates?.find(e => e.period === '+1y')?.epsGrowthPct;
      calc.pegRatio = (calc.ttmEps > 0 && calc.price && fwdEpsG > 0)
        ? +(calc.price / calc.ttmEps / fwdEpsG).toFixed(2) : null;
      calc.forwardEpsGrowthPct = fwdEpsG ?? null;

      // R&D効率 = 売上成長率 / R&D費成長率（直近4Q平均 vs 前4Q平均）
      const rdC = fin.trend.slice(0,4).map(q=>q.rdM).filter(v=>v!=null);
      const rdP = fin.trend.slice(4,8).map(q=>q.rdM).filter(v=>v!=null);
      const rdAvgC = rdC.length ? rdC.reduce((a,b)=>a+b,0)/rdC.length : null;
      const rdAvgP = rdP.length ? rdP.reduce((a,b)=>a+b,0)/rdP.length : null;
      calc.rdGrowthPct = (rdAvgC && rdAvgP && rdAvgP > 0)
        ? +((rdAvgC - rdAvgP) / rdAvgP * 100).toFixed(1) : null;
      const _revGrowthForRd = calc.ttmRevGrowth ?? calc.revGrowth;
      calc.rdEfficiency = (_revGrowthForRd && calc.rdGrowthPct && calc.rdGrowthPct > 0)
        ? +(_revGrowthForRd / calc.rdGrowthPct).toFixed(2) : null;

      // インクリメンタルROIC = ΔNOPAT / Δ投下資本
      const eqP  = fin.eqA?.[1]?.val   != null ? fin.eqA[1].val   / M : null;
      const debtP = fin.debtA?.[1]?.val != null ? fin.debtA[1].val / M : null;
      const cashP = fin.cashA?.[1]?.val != null ? fin.cashA[1].val / M : null;
      const icNow  = (calc.equityNow??0) + (calc.debtNow??0) - (calc.cashNow??0);
      const icPrev = (eqP??0) + (debtP??0) - (cashP??0);
      const deltaIC    = icNow - icPrev;
      const deltaNOPAT = (calc.opNow && calc.opPrev) ? (calc.opNow - calc.opPrev) * 0.79 : null;
      calc.incrementalROIC = (deltaNOPAT && deltaIC && Math.abs(deltaIC) > 10)
        ? +(deltaNOPAT / Math.abs(deltaIC) * 100).toFixed(1) : null;
    }

    // ── 金融業フラグ ──────────────────────────────
    const FINANCIAL_TICKERS = [
      'SOFI','SQ','PYPL','V','MA','JPM','BAC','GS','WFC','AFRM',
      'UPST','COIN','HOOD','NU','LC','OPEN','NRDS','MKTX','SCHW',
      'MS','C','BLK','BX','KKR','ALLY','IBKR','LCID','NAVI',
    ];
    // 原価率が2期以上100%超 → 金融系P&L構造を誤検知している
    const costAnomalyCount = fin.trend.slice(0, 4)
      .filter(q => q.costRatio !== null && q.costRatio > 1.0).length;
    const isFinancial = FINANCIAL_TICKERS.includes(ticker) || costAnomalyCount >= 2;

    // ── フェーズ検出 ─────────────────────────────
    const trend4 = fin.trend.slice(0, 4);
    const lossCount   = trend4.filter(q => q.opMargin !== null && q.opMargin < 0).length;
    const latestYoY   = fin.trend[0]?.revYoY ?? 0;
    const profitCount = trend4.filter(q => q.opMargin !== null && q.opMargin > 3).length;
    let companyPhase = 'phase2';
    if      (isFinancial)                                           companyPhase = 'financial';
    else if (lossCount >= 3 || (lossCount >= 2 && latestYoY > 40)) companyPhase = 'phase1';
    else if (profitCount >= 3 && (fin.trend[0]?.rof40 ?? 0) >= 40) companyPhase = 'phase3';

    const judgment    = investmentJudgment(calc, analyst, companyPhase);
    const exitSignal  = exitSignalEngine(fin.trend);

    // ── Phase1用 PSGスコア / P/S倍率 ─────────────
    // PSG = P/S ÷ 成長率。< 1.0 = 割安、> 2.0 = 割高
    const annualRevM = (fin.trend[0]?.revM ?? 0) * 4;
    const psRatio    = (calc.mktcap && annualRevM > 0)
      ? +(calc.mktcap / annualRevM).toFixed(2) : null;
    const psgScore   = (psRatio && latestYoY > 0)
      ? +(psRatio / (latestYoY / 100)).toFixed(2) : null;

    // ── IPO後企業フラグ（2021年ピークなし）─────────
    const isPostIpoNoPeak = !mkt.peak2021 && calc.peak21 === null;

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        ticker, companyName: name, cik, filings, market: mkt,
        trend: fin.trend,
        isFinancial, companyPhase, psRatio, psgScore, isPostIpoNoPeak,
        analyst, judgment, exitSignal,
        // Reference only (next-quarter consensus, EPS surprises); not used by judgment.
        outlook: outlook ?? { unavailable: 'サーバーにFinnhubキーが未設定です' },
        financials: {
          revA: fin.revA?.slice(0,3), cogsA: fin.cogsA?.slice(0,3), opA: fin.opA?.slice(0,3),
          cashA: fin.cashA?.slice(0,2), debtA: fin.debtA?.slice(0,2), eqA: fin.eqA?.slice(0,2),
          issA: fin.issA?.slice(0,2), bbA: fin.bbA?.slice(0,2),
        },
        calc,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
