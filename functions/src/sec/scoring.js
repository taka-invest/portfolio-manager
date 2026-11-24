// "マシャ式" scoring, exit signals and 10-year price model on CORRECTED SEC data.
// The owner's methodology, point weights and thresholds are kept exactly as in the
// legacy engine (functions/src/legacy/analyze.js: masyaCostGrade, investmentJudgment,
// exitSignalEngine, masyaCalc). What changed (docs/FINANCIAL_VERIFICATION.md):
//   * inputs come from functions/src/sec/financials.js (Q4 present, date-matched YoY);
//   * missing inputs are NEVER replaced by 0 — the rule is skipped and listed in `missing`;
//   * the 10-year model does not assume a sector target margin for loss-making
//     companies, and reports a share-dilution variant next to the constant-shares one;
//   * every assumption is returned in `assumptions`.
'use strict';

const finite = v => typeof v === 'number' && Number.isFinite(v);
const r = (v, d = 1) => finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;

export function masyaCostGrade(costRatio) {
  if (!finite(costRatio)) return { level: null, label: 'データ不足' };
  if (costRatio < 0.15) return { level: 5, label: '最強・化け物級' };
  if (costRatio < 0.20) return { level: 4, label: '優秀' };
  if (costRatio < 0.30) return { level: 3, label: '良（マシャ基準）' };
  if (costRatio < 0.50) return { level: 2, label: '合格（バフェット水準）' };
  if (costRatio < 0.70) return { level: 1, label: '要注意' };
  return { level: 0, label: '危険水域' };
}

export const SECTOR_PER = {
  software: { bear: 40, standard: 60, name: 'SaaS/ソフトウェア' },
  internet: { bear: 25, standard: 40, name: 'インターネット/プラットフォーム' },
  semiconductor: { bear: 20, standard: 30, name: '半導体' },
  default: { bear: 25, standard: 40, name: 'テック成長株' },
  manufacturing: { bear: 12, standard: 18, name: '製造業' },
  energy: { bear: 8, standard: 12, name: 'エネルギー' }
};
export const SECTOR_TARGET_OPM = { software: 30, internet: 25, semiconductor: 22, default: 20, manufacturing: 12, energy: 10 };

export function inferSector(ticker, costRatio) {
  const t = ticker.toUpperCase();
  if (['AMD', 'NVDA', 'MU', 'QCOM', 'ARM', 'INTC', 'AVGO', 'TSM', 'SNDK', 'AMAT', 'LRCX', 'CRDO'].includes(t)) return 'semiconductor';
  if (['PLTR', 'MNDY', 'NOW', 'FRSH', 'CRM', 'SNOW', 'DDOG', 'NET', 'ZS', 'CRWD', 'INOD', 'GRRR'].includes(t)) return 'software';
  if (['APP', 'TTD', 'META', 'GOOGL', 'GOOG', 'AMZN', 'PINS', 'RKLB'].includes(t)) return 'internet';
  if (['CLF', 'X', 'NUE', 'FCX', 'CVX', 'XOM', 'SLB'].includes(t)) return 'energy';
  if (['GE', 'BA', 'CAT', 'HON', 'DE', 'MMM'].includes(t)) return 'manufacturing';
  if (!finite(costRatio)) return 'default';
  if (costRatio < 0.30) return 'software';
  if (costRatio < 0.45) return 'internet';
  if (costRatio < 0.60) return 'default';
  if (costRatio < 0.72) return 'semiconductor';
  if (costRatio < 0.82) return 'manufacturing';
  return 'energy';
}

/** Core metrics used by the judgment, from corrected quarterly rows. */
export function coreMetrics(fin) {
  const l = fin.latest;
  const missing = [];
  if (!l) return { missing: ['quarters'] };
  const costRatio = finite(l.costRatioTtmPct) ? l.costRatioTtmPct / 100 : null;
  if (costRatio === null) missing.push('TTM原価率');
  const revGrowth = l.revenueTtmYoYPct;
  if (!finite(revGrowth)) missing.push('TTM売上成長率');
  const opNow = l.operatingIncomeTtm, opPrev = l.operatingIncomeTtmPrev;
  const opUp = finite(opNow) && finite(opPrev) ? opNow > opPrev : null;
  if (opUp === null) missing.push('TTM営業利益の前年比較');
  const isCashRich = costRatio === null || opUp === null ? null : costRatio < 0.5 && opUp;
  const equity = fin.balance?.equity?.val;
  const bsOk = finite(equity) ? equity > 0 : null;
  if (bsOk === null) missing.push('自己資本');
  return { costRatio, costGrade: masyaCostGrade(costRatio), revGrowth, opMarginTtm: l.operatingMarginTtmPct,
    isCashRich, bsOk, missing };
}

/** マシャ総合スコア (0-100), same weights as legacy; unknown inputs earn nothing and are listed. */
export function masyaScore(core) {
  let score = 0;
  if (core.costGrade?.level != null) score += core.costGrade.level * 10;
  if (core.isCashRich === true) score += 15;
  if (finite(core.revGrowth)) {
    if (core.revGrowth >= 50) score += 20;
    else if (core.revGrowth >= 30) score += 15;
    else if (core.revGrowth >= 16) score += 10;
    else if (core.revGrowth >= 0) score += 5;
  }
  if (finite(core.opMarginTtm) && core.opMarginTtm > 0) score += 5;
  if (core.bsOk === true) score += 5;
  return { score: Math.min(100, score), complete: core.missing.length === 0, missing: core.missing };
}

/**
 * 10-year EPS × PER three-price model. Returns null prices with a reason instead of
 * inventing profitability.
 */
export function tenYearModel(fin, { sector, price, shares }) {
  const assumptions = {};
  const ann = fin.annual;
  const latestA = ann.at(-1);
  const revNow = latestA?.revenue;
  // Use only years reported on the SAME basis: values filed in the latest 10-K (it restates
  // prior years after divestitures, e.g. APP). Older years from earlier 10-Ks may be on a
  // different basis, so a 3-year CAGR is used only if all points share the latest filing.
  const restated = new Set(fin.restatedRevenueEnds ?? []);
  const annualRestated = ann.some(a => restated.has(a.end));
  // No restatement: legacy behaviour (all annual rows). Restatement: same-filing rows only.
  const sameBasis = annualRestated ? ann.filter(a => a.accn && a.accn === latestA?.accn) : ann;
  let revCAGR = null, cagrBasis = null;
  for (const years of [3, 2, 1]) {
    const base = sameBasis.at(-1 - years);
    if (finite(revNow) && finite(base?.revenue) && base.revenue > 0) {
      revCAGR = (revNow / base.revenue) ** (1 / years) - 1;
      cagrBasis = (annualRestated ? `修正再表示あり：最新10-Kと同一基準の` : '') + `直近${years}年の通期売上CAGR（${base.end}→${latestA.end}）`;
      break;
    }
  }
  if (revCAGR === null) return { prices: null, reason: '通期売上の履歴が不足', assumptions };
  let projected = revCAGR;
  if (projected > 0.50) projected = (projected + 0.20) / 2;
  else if (projected > 0.30) projected *= 0.80;
  projected = Math.max(Math.min(projected, 0.40), 0.02);
  Object.assign(assumptions, { cagrBasis, historicalCagrPct: r(revCAGR * 100), projectedCagrPct: r(projected * 100),
    cagrRule: '50%超は(実績+20%)/2、30〜50%は×0.8、上限40%・下限2%（旧ロジックと同じ）' });

  const opmNow = fin.latest?.operatingMarginTtmPct;
  if (!finite(opmNow)) return { prices: null, reason: 'TTM営業利益率が不明', assumptions };
  if (opmNow <= 0) {
    return { prices: null, reason: '赤字（TTM営業利益率≦0）のため、業種目標利益率を当てはめた推定は行わない', assumptions };
  }
  const target = SECTOR_TARGET_OPM[sector] ?? 20;
  const opm = Math.min(Math.max(opmNow, target), 45);
  const rev10 = revNow * (1 + projected) ** 10;
  const warnings = [];
  if (rev10 > 1e12) warnings.push(`10年後売上が${r(rev10 / 1e12, 1)}兆ドル（成長率の前提が長期で維持できるか要確認）`);
  if (projected >= 0.40) warnings.push('想定成長率が上限40%に張り付いている（10年間持続する前提）');
  const ni10 = rev10 * (opm / 100) * 0.75;
  Object.assign(assumptions, { operatingMarginNowPct: opmNow, sectorTargetPct: target, operatingMargin10yPct: r(opm),
    marginRule: '現在のTTM営業利益率と業種目標の高い方（上限45%）。黒字企業のみ', taxFactor: 0.75,
    revenue10yUsd: Math.round(rev10) });

  if (!finite(shares?.val) || shares.val <= 1e6) return { prices: null, reason: '株数が不明', assumptions };
  const per = SECTOR_PER[sector] ?? SECTOR_PER.default;
  // Annual share growth from diluted weighted shares (last 4 quarters vs a year earlier).
  const dil = fin.dilutedSharesSeries ?? [];
  let shareGrowth = null;
  const last = dil.at(-1);
  if (last) {
    const target = Date.parse(last.end) - 365 * 864e5;
    const prior = dil.find(d => Math.abs(Date.parse(d.end) - target) <= 10 * 864e5);
    if (prior && finite(last.val) && finite(prior.val) && prior.val > 0) shareGrowth = last.val / prior.val - 1;
  }
  const eps10 = ni10 / shares.val;
  const eps10Diluted = finite(shareGrowth) && shareGrowth > 0 ? ni10 / (shares.val * (1 + shareGrowth) ** 10) : eps10;
  Object.assign(assumptions, { sharesBasis: shares.basis, shares: shares.val, per,
    annualShareGrowthPct: finite(shareGrowth) ? r(shareGrowth * 100, 2) : null,
    dilutionRule: '希薄化版は直近1年の希薄化後株数増加率が10年続く前提（減少時は株数一定）',
    discounting: 'なし（10年後の名目株価）' });
  const three = eps => (Math.abs(eps) < 500 ? {
    eps10y: r(eps, 2), bear: r(eps * per.bear, 2), standard: r(eps * per.standard, 2), bull: r(eps * per.standard * 2, 2)
  } : null);
  const prices = { constantShares: three(eps10), withDilution: three(eps10Diluted) };
  const ref = prices.withDilution?.standard;
  const returnMultiple = finite(ref) && finite(price) && price > 0 ? r(ref / price, 2) : null;
  return { prices, warnings, price: finite(price) ? price : null, returnMultiple,
    impliedAnnualReturnPct: finite(returnMultiple) && returnMultiple > 0 ? r((returnMultiple ** 0.1 - 1) * 100) : null,
    assumptions };
}

/** Investment judgment: legacy weights/thresholds; analyst inputs optional (skipped if absent). */
export function investmentJudgment(core, model, analyst = {}) {
  const signals = [];
  let bull = 0, bear = 0;
  const g = core.revGrowth;
  if (!finite(g)) signals.push({ type: 'missing', text: '売上成長率（TTM）データ不足 → 加点・減点なし' });
  else if (g >= 50) { bull += 25; signals.push({ type: 'bull', text: `売上成長率 +${r(g)}%（化け物級）[TTM]` }); }
  else if (g >= 30) { bull += 18; signals.push({ type: 'bull', text: `売上成長率 +${r(g)}%（高成長）[TTM]` }); }
  else if (g >= 16) { bull += 12; signals.push({ type: 'bull', text: `売上成長率 +${r(g)}%（注目水準）[TTM]` }); }
  else if (g >= 0) { bull += 5; signals.push({ type: 'neutral', text: `売上成長率 +${r(g)}%（普通）[TTM]` }); }
  else { bear += 15; signals.push({ type: 'bear', text: `売上マイナス成長 ${r(g)}%[TTM]` }); }

  const lv = core.costGrade?.level;
  if (lv == null) signals.push({ type: 'missing', text: '原価率データ不足 → 加点・減点なし' });
  else if (lv >= 5) { bull += 20; signals.push({ type: 'bull', text: '原価率<15%（化け物水準・強力な経済的堀）' }); }
  else if (lv >= 4) { bull += 15; signals.push({ type: 'bull', text: '原価率<20%（優秀水準）' }); }
  else if (lv >= 3) { bull += 10; signals.push({ type: 'bull', text: '原価率<30%（マシャ基準クリア）' }); }
  else if (lv <= 1) { bear += 10; signals.push({ type: 'bear', text: '原価率50%超（収益の壁あり）' }); }

  if (core.isCashRich === true) { bull += 10; signals.push({ type: 'bull', text: 'キャッシュリッチ条件クリア' }); }
  else if (core.isCashRich === false) { bear += 5; signals.push({ type: 'bear', text: 'キャッシュリッチ条件未達' }); }
  else signals.push({ type: 'missing', text: 'キャッシュリッチ判定不可（データ不足）' });

  const m = model?.returnMultiple;
  if (finite(m)) {
    const cagr = r((m ** 0.1 - 1) * 100, 0);
    if (m >= 5) { bull += 20; signals.push({ type: 'bull', text: `期待リターン ${m}倍（年率${cagr}%）` }); }
    else if (m >= 3) { bull += 15; signals.push({ type: 'bull', text: `期待リターン ${m}倍（年率${cagr}%）` }); }
    else if (m >= 2) { bull += 8; signals.push({ type: 'bull', text: `期待リターン ${m}倍（年率${cagr}%）` }); }
    else if (m >= 1) { bear += 5; signals.push({ type: 'bear', text: `期待リターン ${m}倍（低い）` }); }
    else { bear += 15; signals.push({ type: 'bear', text: '割高（現在株価が10年後標準価格を超過）' }); }
  } else signals.push({ type: 'missing', text: `10年後期待リターン算出不可（${model?.reason ?? '株価未取得'}）` });

  if (finite(analyst.avgBeatPct)) {
    const b = analyst.avgBeatPct;
    if (b >= 10) bull += 15; else if (b >= 5) bull += 10; else if (b >= 0) bull += 3; else bear += 10;
    signals.push({ type: b >= 0 ? 'bull' : 'bear', text: `EPS平均ビート率 ${b}%` });
  }
  if (finite(analyst.nextQRevGrowthPct)) {
    const x = analyst.nextQRevGrowthPct;
    if (x >= 30) bull += 10; else if (x >= 0) bull += 3; else bear += 8;
    signals.push({ type: x >= 0 ? 'bull' : 'bear', text: `来四半期売上予想 ${x}%（アナリスト予想・実績ではない）` });
  }

  const total = bull + bear;
  const ratio = total > 0 ? bull / total : 0.5;
  let judgment;
  if (ratio >= 0.80 && bull >= 60) judgment = '強い買い';
  else if (ratio >= 0.65 && bull >= 40) judgment = '買い';
  else if (ratio >= 0.50 && bull >= 20) judgment = '様子見';
  else if (ratio >= 0.35) judgment = '弱気';
  else judgment = '売り';
  const missingCount = signals.filter(s => s.type === 'missing').length;
  return { judgment, bullScore: bull, bearScore: bear, bullRatio: Math.round(ratio * 100), signals,
    complete: missingCount === 0, note: missingCount ? `${missingCount}項目がデータ不足のため判定は参考値` : null };
}

/** Exit signals: legacy rules on newest-first corrected quarters (Q4 included, YoY date-matched). */
export function exitSignals(quarters) {
  const t = [...quarters].reverse().map(q => ({ revYoY: q.revenueYoYPct, opMargin: q.operatingMarginPct,
    opLeverage: q.operatingLeverageQ, costRatio: finite(q.costRatioPct) ? q.costRatioPct / 100 : null, rof40: q.ruleOf40Legacy }));
  if (t.length < 4) return null;
  const signals = [];
  let score = 0, decel = 0;
  for (let i = 0; i < Math.min(t.length - 1, 6); i++) {
    if (finite(t[i].revYoY) && finite(t[i + 1].revYoY) && t[i].revYoY < t[i + 1].revYoY) decel++; else break;
  }
  if (decel >= 3) { score += 30; signals.push({ level: 'danger', text: `売上YoY成長率が${decel}四半期連続で減速中` }); }
  else if (decel === 2) { score += 18; signals.push({ level: 'warning', text: '売上YoY成長率が2四半期連続で減速' }); }
  else if (decel === 1) { score += 7; signals.push({ level: 'caution', text: '売上YoY成長率が直近1四半期で減速' }); }
  else signals.push({ level: 'ok', text: '売上YoY成長率は加速・維持中' });
  const now = t[0].revYoY, yearAgo = t[4]?.revYoY;
  if (finite(now)) {
    if (now < 0) { score += 25; signals.push({ level: 'danger', text: `売上がマイナス成長（${r(now)}%）` }); }
    else if (now < 10 && finite(yearAgo) && yearAgo >= 30) { score += 20; signals.push({ level: 'danger', text: `成長率が急落（${r(yearAgo, 0)}% → ${r(now)}%）` }); }
    else if (now < 15 && finite(yearAgo) && yearAgo >= 50) { score += 15; signals.push({ level: 'warning', text: `高成長から普通成長へ（${r(yearAgo, 0)}% → ${r(now)}%）` }); }
  }
  const mg = t.slice(0, 5).map(q => q.opMargin).filter(finite);
  if (mg.length >= 3) {
    const drop = (mg[1] + mg[2] + (mg[3] ?? mg[2])) / 3 - mg[0];
    if (drop > 8) { score += 20; signals.push({ level: 'danger', text: `営業利益率が急速に圧縮（-${r(drop)}pt）` }); }
    else if (drop > 4) { score += 12; signals.push({ level: 'warning', text: `営業利益率が低下傾向（-${r(drop)}pt）` }); }
    else signals.push({ level: 'ok', text: `営業利益率は${drop < -4 ? '改善中' : '安定'}（${r(mg[0])}%）` });
  }
  const lowLev = t.slice(0, 4).map(q => q.opLeverage).filter(finite).filter(v => v < 1).length;
  if (lowLev >= 3) { score += 15; signals.push({ level: 'warning', text: '営業レバレッジが3期で1倍未満' }); }
  else if (lowLev >= 2) { score += 7; signals.push({ level: 'caution', text: '営業レバレッジが低下傾向' }); }
  const cr = t.slice(0, 5).map(q => q.costRatio).filter(finite);
  if (cr.length >= 3) {
    const d = cr[0] - cr[2];
    if (d > 0.06) { score += 12; signals.push({ level: 'warning', text: '原価率が上昇中' }); }
    else if (d > 0.03) { score += 6; signals.push({ level: 'caution', text: '原価率が微増' }); }
  }
  const ro = t.slice(0, 4).map(q => q.rof40).filter(finite);
  if (ro.length >= 3) {
    if (ro[0] < 40 && ro[2] >= 60) { score += 15; signals.push({ level: 'danger', text: `RoF40が急落（${r(ro[2])}→${r(ro[0])}）` }); }
    else if (ro[0] < ro[2] - 30) { score += 10; signals.push({ level: 'warning', text: `RoF40が大幅低下（${r(ro[2])}→${r(ro[0])}）` }); }
  }
  const level = score >= 55 ? '撤退検討' : score >= 35 ? '警戒' : score >= 18 ? '注意' : '継続保有';
  return { exitScore: score, exitLabel: level, decelCount: decel, signals };
}

/** One-call evaluation used by the API. */
export function evaluate(fin, { ticker, price = null, analyst = {} } = {}) {
  const core = coreMetrics(fin);
  const sector = inferSector(ticker, core.costRatio);
  const shares = fin.latestDilutedShares
    ? { val: fin.latestDilutedShares, basis: '直近四半期の希薄化後加重平均株数' }
    : fin.shares ? { val: fin.shares.val, basis: '表紙の発行済株式数（dei）' } : null;
  const model = tenYearModel(fin, { sector, price, shares });
  return { sector, sectorName: (SECTOR_PER[sector] ?? SECTOR_PER.default).name, core,
    masyaScore: masyaScore(core), judgment: investmentJudgment(core, model, analyst),
    exit: exitSignals(fin.quarters), tenYear: model,
    notMigrated: ['2021年高値ベースの会計目標株価（株価履歴の取得元が未決定）', 'アナリスト予想・EPSビート率（Yahoo v10はcrumb必須）'] };
}
