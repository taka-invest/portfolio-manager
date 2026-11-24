// Feeds the legacy Netlify analyze engine (functions/src/legacy/analyze.js) with
// CORRECTED base data while keeping its exact output shape, so the legacy UI
// (index.html) can be used unchanged. Only the data-extraction step is replaced:
//   * quarters: Q4 synthesised (FY − 9M / FY − Q1..Q3), YTD differencing,
//     latest-filed value per period (amendments), near-duplicate ends merged
//   * YoY / QoQ / EPS YoY matched by period END DATE (legacy used array positions)
//   * annual series: one row per fiscal year (legacy kept 10-K comparatives as duplicates)
// The legacy derived metrics (opLeverage, rof40, signals, signalScore, …) are still
// computed by the unchanged legacy code from these rows.
import { factsForTags, quarters, annuals, yearAgo } from './financials.js';

const M = 1_000_000;
const finite = v => typeof v === 'number' && Number.isFinite(v);

const REV = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'SalesRevenueGoodsNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'];
const COGS = ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsAndServices', 'CostOfSales', 'CostOfGoodsSold'];
const OP = ['OperatingIncomeLoss'];
const AMORT = ['AmortizationOfIntangibleAssets', 'FiniteLivedIntangibleAssetsAmortizationExpense', 'AcquiredFiniteLivedIntangibleAssetsAmortizationExpense'];
const NI = ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'];
const SGA = ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'];
const RD = ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'];
const EPS = ['EarningsPerShareDiluted', 'EarningsPerShareBasic'];
const ISS = ['ProceedsFromIssuanceOfCommonStock', 'ProceedsFromIssuanceOfCommonStockUnderStockOptionPlans'];
const BB = ['PaymentsForRepurchaseOfCommonStock'];

export function quarterLabel(endDate) {
  const d = new Date(endDate + 'T00:00:00Z');
  const m = d.getUTCMonth() + 1;
  return `${d.getUTCFullYear()} ${m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4'}`;
}

/** Annual flow rows, newest first, legacy item shape ({end,val,form,fp,fy,filed}). */
function annualFlows(cf, tags, n = 6) {
  return annuals(factsForTags(cf, tags)).reverse().slice(0, n)
    .map(a => ({ end: a.end, val: a.val, start: a.start, form: a.src.form, fp: a.src.fp, fy: a.src.fy, filed: a.src.filed }));
}

/** Annual point-in-time rows (10-K FY balances), one per date, latest filing wins, newest first. */
function annualInstants(cf, tags, n = 6, unit = 'USD') {
  const gaap = cf?.facts?.['us-gaap'] ?? {};
  const best = new Map();
  tags.forEach((tag, priority) => {
    for (const f of gaap[tag]?.units?.[unit] ?? []) {
      if (f.start || !f.end || !finite(f.val) || f.form !== '10-K' || f.fp !== 'FY') continue;
      const old = best.get(f.end);
      if (!old || f.filed > old.filed || (f.filed === old.filed && priority < old.priority)) best.set(f.end, { ...f, priority });
    }
  });
  return [...best.values()].sort((a, b) => b.end.localeCompare(a.end)).slice(0, n);
}

/** Corrected replacement for the data-extraction half of legacy getFinancials(). */
export function legacyBase(cf) {
  const gaap = cf?.facts?.['us-gaap'] ?? {};
  const q = (tags, unit = 'USD', additive = true) =>
    quarters(factsForTags(cf, tags, unit), { additive, q4Approx: !additive });
  const revQ = q(REV), cogsQ = q(COGS), opQ = q(OP), amortQ = q(AMORT), sgaQ = q(SGA), rdQ = q(RD), niQ = q(NI);
  const epsQ = q(EPS, 'USD/shares', false);
  const at = (series, end) => series.find(x => x.end === end) ?? null;

  const recent = revQ.slice(-16).reverse(); // newest first, like legacy
  const baseTrend = recent.map(r => {
    const end = r.end;
    const revM = r.val / M;
    const cogsE = at(cogsQ, end), opE = at(opQ, end), amortE = at(amortQ, end);
    const cogsM = cogsE ? cogsE.val / M : null;
    const opM = opE ? opE.val / M : null;
    const costRatio = cogsE ? cogsE.val / r.val : null;
    const opMargin = (opE && r.val >= M) ? Math.max(-500, Math.min(200, opE.val / r.val * 100)) : null;
    const amortM = amortE ? +(amortE.val / M).toFixed(1) : null;
    const adjOpM = opM !== null ? opM + (amortE ? amortE.val / M : 0) : null;
    const adjOpMargin = (adjOpM !== null && r.val > 0) ? +(adjOpM / r.val * 100).toFixed(1) : null;
    // QoQ: immediately preceding quarter by date; YoY: same quarter one year earlier by date.
    const i = revQ.findIndex(x => x.end === end);
    const prevR = i > 0 && (Date.parse(end) - Date.parse(revQ[i - 1].end)) / 864e5 <= 100 ? revQ[i - 1] : null;
    const prev4R = yearAgo(revQ, end);
    const revQoQ = prevR && prevR.val ? (r.val / prevR.val - 1) * 100 : null;
    const revYoY = prev4R && prev4R.val > 0 ? (r.val / prev4R.val - 1) * 100 : null;
    const sgaE = at(sgaQ, end), rdE = at(rdQ, end);
    const sgaM = sgaE ? +(sgaE.val / M).toFixed(1) : null;
    const rdM = rdE ? +(rdE.val / M).toFixed(1) : null;
    const grossProfitM = cogsE ? +(revM - cogsM).toFixed(1) : null;
    const grossMargin = cogsE ? +((1 - cogsE.val / r.val) * 100).toFixed(1) : null;
    const opExM = (cogsM !== null && sgaM !== null) ? +(cogsM + sgaM + (rdM ?? 0)).toFixed(1) : null;
    const opExRatio = (opExM !== null && revM > 0) ? +(opExM / revM * 100).toFixed(1) : null;
    const epsE = at(epsQ, end), niE = at(niQ, end);
    const epsQ_ = epsE ? +Number(epsE.val).toFixed(4) : null;
    const netIncM = niE ? +(niE.val / M).toFixed(2) : null;
    const eps4 = prev4R ? at(epsQ, prev4R.end) : null;
    const epsYoY = (epsQ_ !== null && eps4) ? +(epsQ_ - eps4.val).toFixed(4) : null;
    return { end, label: quarterLabel(end), revM, cogsM, opM, costRatio, opMargin, adjOpMargin, amortM,
      revQoQ, revYoY, sgaM, rdM, grossProfitM, grossMargin, opExM, opExRatio,
      epsQ: epsQ_, netIncM, epsYoY, derivedQ4: Boolean(r.derived) };
  }).filter(x => x.revM > 0);

  const sharesRaw = (gaap.CommonStockSharesOutstanding?.units?.shares ?? []).slice().sort((a, b) => b.end.localeCompare(a.end));
  return {
    revA: annualFlows(cf, REV), cogsA: annualFlows(cf, COGS), opA: annualFlows(cf, OP), netIncA: annualFlows(cf, NI),
    cashA: annualInstants(cf, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsAndShortTermInvestments', 'CashAndCashEquivalentsAndShortTermInvestments'], 4),
    debtA: annualInstants(cf, ['LongTermDebt', 'LongTermDebtNoncurrent', 'LongTermDebtCurrent'], 4),
    eqA: annualInstants(cf, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'], 6),
    issA: annualFlows(cf, ISS), bbA: annualFlows(cf, BB),
    apicA: annualInstants(cf, ['AdditionalPaidInCapital', 'AdditionalPaidInCapitalCommonStock'], 4),
    reA: annualInstants(cf, ['RetainedEarningsAccumulatedDeficit'], 4),
    sharesLatest: sharesRaw[0]?.val ?? null,
    sharesAnnual: annualInstants(cf, ['CommonStockSharesOutstanding'], 6, 'shares'),
    baseTrend
  };
}
