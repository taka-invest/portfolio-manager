// Corrected SEC XBRL (companyfacts) financial-statement layer.
// Pure functions: no network, no clock except where passed in. Every value that
// cannot be established from filed data is `null` — never 0.
//
// Fixes relative to the legacy Netlify engine (docs/MIGRATION_AUDIT.md §3):
//  * De-duplicates facts by exact period; the MOST RECENTLY FILED value wins
//    (amendments / restatements such as 10-Q/A, 10-K/A, and later comparatives).
//  * 10-K prior-year comparatives no longer create duplicate annual rows.
//  * Discrete quarters are derived from year-to-date (YTD) cumulative facts, so
//    Q4 (= FY − 9M) and cash-flow quarters (10-Qs report 6M/9M YTD) exist.
//  * YoY and TTM are matched by period END DATE, never by array position.
//  * FCF = operating cash flow − capital expenditure (both required).
//  * EPS uses diluted EPS; definitions are returned with the numbers.
'use strict';

const DAY = 86_400_000;
const dayNum = iso => Math.round(Date.parse(iso + 'T00:00:00Z') / DAY);
const isoOf = n => new Date(n * DAY).toISOString().slice(0, 10);
const span = f => dayNum(f.end) - dayNum(f.start) + 1;

export const QUARTER = [80, 100];
export const ANNUAL = [350, 380];
const within = (d, [a, b]) => d >= a && d <= b;
const finite = v => typeof v === 'number' && Number.isFinite(v);

export const CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues',
    'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueNet'],
  grossProfit: ['GrossProfit'],
  operatingIncome: ['OperatingIncomeLoss'],
  netIncome: ['NetIncomeLoss'],
  epsDiluted: ['EarningsPerShareDiluted'],
  epsBasic: ['EarningsPerShareBasic'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
  dilutedShares: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
  buyback: ['PaymentsForRepurchaseOfCommonStock'],
  stockIssued: ['ProceedsFromIssuanceOfCommonStock']
};
// Point-in-time (balance sheet) concepts.
export const INSTANT_CONCEPTS = {
  cash: ['CashAndCashEquivalentsAtCarryingValue'],
  equity: ['StockholdersEquity'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebt']
};
const UNITS = { epsDiluted: 'USD/shares', epsBasic: 'USD/shares', dilutedShares: 'shares' };
// Per-share and share-count values cannot be differenced into quarters.
const ADDITIVE = new Set(['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'operatingCashFlow', 'capex',
  'costOfRevenue', 'buyback', 'stockIssued']);

/** All duration facts for a metric, merged across fallback tags, one per exact period. */
export function durationFacts(companyfacts, metric) {
  const gaap = companyfacts?.facts?.['us-gaap'] ?? {};
  const unit = UNITS[metric] ?? 'USD';
  const best = new Map(); // "start|end" -> fact
  CONCEPTS[metric].forEach((tag, priority) => {
    for (const f of gaap[tag]?.units?.[unit] ?? []) {
      if (!f.start || !f.end || !finite(f.val)) continue;
      const key = f.start + '|' + f.end;
      const cand = { start: f.start, end: f.end, val: f.val, form: f.form, filed: f.filed,
        accn: f.accn, fy: f.fy, fp: f.fp, tag, priority, days: 0 };
      cand.days = span(cand);
      const old = best.get(key);
      if (!old || cand.filed > old.filed || (cand.filed === old.filed && priority < old.priority)) best.set(key, cand);
    }
  });
  return [...best.values()].sort((a, b) => a.end.localeCompare(b.end) || a.start.localeCompare(b.start));
}

/** Period ends whose filed values differ between filings by > tolerance (restatements). */
export function restatedPeriods(companyfacts, metric, tolerance = 0.005) {
  const gaap = companyfacts?.facts?.['us-gaap'] ?? {};
  const unit = UNITS[metric] ?? 'USD';
  const seen = new Map(); // start|end -> [vals]
  for (const tag of CONCEPTS[metric]) {
    for (const f of gaap[tag]?.units?.[unit] ?? []) {
      if (!f.start || !f.end || !finite(f.val)) continue;
      const k = f.start + '|' + f.end;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(f.val);
    }
  }
  const out = new Set();
  for (const [k, vals] of seen) {
    const min = Math.min(...vals), max = Math.max(...vals);
    if (max > 0 && (max - min) / max > tolerance) out.add(k.split('|')[1]);
  }
  return out;
}

/** Latest point-in-time value (balance sheet), most recently filed for the latest date. */
export function latestInstant(companyfacts, metric) {
  const gaap = companyfacts?.facts?.['us-gaap'] ?? {};
  let best = null;
  INSTANT_CONCEPTS[metric].forEach((tag, priority) => {
    for (const f of gaap[tag]?.units?.USD ?? []) {
      if (f.start || !f.end || !finite(f.val)) continue;
      const better = !best || f.end > best.end || (f.end === best.end && (f.filed > best.filed ||
        (f.filed === best.filed && priority < best.priority)));
      if (better) best = { end: f.end, val: f.val, filed: f.filed, form: f.form, tag, priority };
    }
  });
  return best;
}

/** Shares outstanding from the cover page (dei), summed across share classes on the latest date. */
export function sharesOutstanding(companyfacts) {
  const list = companyfacts?.facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares ?? [];
  if (!list.length) return null;
  const latest = list.reduce((m, f) => (f.end > m ? f.end : m), '');
  const onDate = list.filter(f => f.end === latest && finite(f.val));
  // One value per filing per class; take the most recent filing on that date.
  const filed = onDate.reduce((m, f) => (f.filed > m ? f.filed : m), '');
  const vals = onDate.filter(f => f.filed === filed);
  return { end: latest, val: vals.reduce((s, f) => s + f.val, 0), classes: vals.length };
}

/** Discrete fiscal quarters: direct ~3-month facts, plus differences of YTD cumulatives. */
export function quarters(facts, { additive = true, q4Approx = false } = {}) {
  const out = new Map(); // end -> quarter
  const put = (q, direct) => {
    const old = out.get(q.end);
    if (!old || (direct && !old.direct)) out.set(q.end, q);
  };
  for (const f of facts) {
    if (within(f.days, QUARTER)) put({ start: f.start, end: f.end, val: f.val, derived: false, direct: true, src: f }, true);
  }
  if (additive) {
    // Group cumulative (YTD) facts by fiscal-year start date.
    const byStart = new Map();
    for (const f of facts) {
      if (!byStart.has(f.start)) byStart.set(f.start, []);
      byStart.get(f.start).push(f);
    }
    for (const list of byStart.values()) {
      const cum = list.filter(f => f.days <= ANNUAL[1]).sort((a, b) => a.days - b.days);
      if (cum.length < 2) continue;
      for (let i = 1; i < cum.length; i++) {
        const prev = cum[i - 1], cur = cum[i];
        const qDays = dayNum(cur.end) - dayNum(prev.end);
        if (!within(qDays, QUARTER)) continue;
        put({ start: isoOf(dayNum(prev.end) + 1), end: cur.end, val: cur.val - prev.val,
          derived: true, direct: false, src: { minuend: cur, subtrahend: prev } }, false);
      }
    }
  }
  if (additive || q4Approx) {
    // Fallback when no 9M YTD fact exists: Q4 = FY − (Q1+Q2+Q3) for three contiguous quarters.
    // For per-share values (q4Approx) this is an approximation (share count changes).
    for (const fy of facts.filter(f => within(f.days, ANNUAL))) {
      if (out.has(fy.end)) continue;
      const inside = [...out.values()].filter(q => q.start >= fy.start && q.end < fy.end)
        .sort((a, b) => a.end.localeCompare(b.end));
      if (inside.length !== 3 || inside[0].start !== fy.start) continue;
      const contiguous = inside.every((q, k) => k === 0 || dayNum(q.start) - dayNum(inside[k - 1].end) === 1);
      const qDays = dayNum(fy.end) - dayNum(inside[2].end);
      if (!contiguous || !within(qDays, QUARTER)) continue;
      put({ start: isoOf(dayNum(inside[2].end) + 1), end: fy.end, val: fy.val - inside.reduce((s, q) => s + q.val, 0),
        derived: true, approx: !additive, direct: false, src: { annual: fy, quarters: inside.map(q => q.end) } }, false);
    }
  }
  // Collapse the same quarter tagged with end dates a few days apart (seen in old
  // NVDA filings: 2010-07-31 vs 2010-08-01). Prefer direct, then most recently filed.
  const sorted = [...out.values()].sort((a, b) => a.end.localeCompare(b.end));
  const merged = [];
  const filed = q => q.src?.filed ?? q.src?.minuend?.filed ?? q.src?.annual?.filed ?? '';
  for (const q of sorted) {
    const last = merged.at(-1);
    if (last && dayNum(q.end) - dayNum(last.end) <= 7) {
      const better = (q.direct && !last.direct) || (q.direct === last.direct && filed(q) > filed(last));
      if (better) merged[merged.length - 1] = q;
      continue;
    }
    merged.push(q);
  }
  return merged;
}

export function annuals(facts) {
  return facts.filter(f => within(f.days, ANNUAL))
    .map(f => ({ start: f.start, end: f.end, val: f.val, src: f }))
    .sort((a, b) => a.end.localeCompare(b.end));
}

/** Value of the series whose period ends ~one year before `end` (±10 days). */
export function yearAgo(series, end) {
  const target = dayNum(end) - 365;
  let hit = null;
  for (const p of series) {
    const d = Math.abs(dayNum(p.end) - target);
    if (d <= 10 && (!hit || d < Math.abs(dayNum(hit.end) - target))) hit = p;
  }
  return hit;
}

export function growthPct(cur, prev) {
  if (!finite(cur) || !finite(prev) || prev <= 0) return null;
  return (cur / prev - 1) * 100;
}

/** Trailing twelve months ending at `end`: 4 contiguous quarters spanning ~1 year. */
export function ttm(qs, end) {
  const i = qs.findIndex(q => q.end === end);
  if (i < 3) return null;
  const four = qs.slice(i - 3, i + 1);
  for (let k = 1; k < 4; k++) {
    const gap = dayNum(four[k].start) - dayNum(four[k - 1].end);
    if (gap < 0 || gap > 4) return null;
  }
  const days = dayNum(four[3].end) - dayNum(four[0].start) + 1;
  if (!within(days, ANNUAL)) return null;
  return { start: four[0].start, end, val: four.reduce((s, q) => s + q.val, 0), derived: four.some(q => q.derived) };
}

const round = (v, d = 1) => finite(v) ? Math.round(v * 10 ** d) / 10 ** d : null;
const pct = (num, den) => finite(num) && finite(den) && den > 0 ? (num / den) * 100 : null;

/**
 * Build the corrected quarterly table and headline metrics.
 * @returns {{quarters: object[], annual: object[], latest: object|null, definitions: object}}
 */
export function analyzeFacts(companyfacts) {
  const series = {};
  for (const metric of Object.keys(CONCEPTS)) {
    const facts = durationFacts(companyfacts, metric);
    series[metric] = { q: quarters(facts, { additive: ADDITIVE.has(metric), q4Approx: metric === 'epsDiluted' }), a: annuals(facts) };
  }
  const rev = series.revenue.q;
  const at = (metric, end) => series[metric].q.find(q => q.end === end) ?? null;
  const rows = rev.map(r => {
    const ocf = at('operatingCashFlow', r.end), cap = at('capex', r.end);
    const op = at('operatingIncome', r.end), gp = at('grossProfit', r.end), ni = at('netIncome', r.end);
    const eps = at('epsDiluted', r.end);
    const fcf = ocf && cap ? ocf.val - cap.val : null;
    const prev = yearAgo(rev, r.end);
    const revTtm = ttm(rev, r.end), revTtmPrev = prev ? ttm(rev, prev.end) : null;
    const fcfTtmParts = ['operatingCashFlow', 'capex'].map(m => ttm(series[m].q, r.end));
    const fcfTtm = fcfTtmParts.every(Boolean) ? fcfTtmParts[0].val - fcfTtmParts[1].val : null;
    const opTtm = ttm(series.operatingIncome.q, r.end);
    const opPrev = yearAgo(series.operatingIncome.q, r.end);
    const opTtmPrev = opPrev ? ttm(series.operatingIncome.q, opPrev.end) : null;
    // Exact full-year diluted EPS when the TTM window is a fiscal year; otherwise sum of quarters.
    const fyEps = series.epsDiluted.a.find(a => a.end === r.end);
    const epsTtm = fyEps ? { val: fyEps.val, derived: false } : ttm(series.epsDiluted.q, r.end);
    const epsPrev = yearAgo(series.epsDiluted.q, r.end);
    const cogs = at('costOfRevenue', r.end);
    const cogsTtm = ttm(series.costOfRevenue.q, r.end);
    const opYoY = growthPct(op?.val, yearAgo(series.operatingIncome.q, r.end)?.val);
    const revYoY = growthPct(r.val, prev?.val);
    const revTtmYoY = growthPct(revTtm?.val, revTtmPrev?.val);
    const opTtmYoY = growthPct(opTtm?.val, opTtmPrev?.val);
    return {
      start: r.start, end: r.end, revenueDerived: r.derived,
      revenue: r.val, grossProfit: gp?.val ?? null, operatingIncome: op?.val ?? null,
      netIncome: ni?.val ?? null, epsDiluted: eps ? (eps.derived ? round(eps.val, 2) : eps.val) : null, epsDilutedDerived: eps?.derived ?? null,
      operatingCashFlow: ocf?.val ?? null, capex: cap?.val ?? null, fcf,
      costOfRevenue: cogs?.val ?? null,
      costRatioPct: round(pct(cogs?.val, r.val)), costRatioTtmPct: round(pct(cogsTtm?.val, revTtm?.val)),
      operatingLeverageQ: finite(opYoY) && finite(revYoY) && revYoY >= 1 ? round(opYoY / revYoY, 2) : null,
      operatingMarginTtmPct: round(pct(opTtm?.val, revTtm?.val)),
      operatingIncomeTtmPrev: opTtmPrev?.val ?? null,
      grossMarginPct: round(pct(gp?.val, r.val)), operatingMarginPct: round(pct(op?.val, r.val)),
      fcfMarginPct: round(pct(fcf, r.val)),
      revenueYoYPct: round(revYoY),
      revenueTtm: revTtm?.val ?? null, revenueTtmYoYPct: round(revTtmYoY),
      operatingIncomeTtm: opTtm?.val ?? null, fcfTtm,
      fcfMarginTtmPct: round(pct(fcfTtm, revTtm?.val)),
      epsDilutedTtm: epsTtm ? round(epsTtm.val, 2) : null,
      epsDilutedYoYPct: round(growthPct(eps?.val, epsPrev?.val)),
      ruleOf40: finite(revTtmYoY) && finite(pct(fcfTtm, revTtm?.val)) ? round(revTtmYoY + pct(fcfTtm, revTtm.val)) : null,
      ruleOf40Legacy: finite(revYoY) && finite(pct(op?.val, r.val)) ? round(revYoY + pct(op.val, r.val)) : null,
      operatingLeverage: finite(opTtmYoY) && finite(revTtmYoY) && revTtmYoY >= 1 ? round(opTtmYoY / revTtmYoY, 2) : null
    };
  });
  rows.forEach((row, i) => {
    const prior = rows.slice(0, i).reverse().find(r => dayNum(row.end) - dayNum(r.end) <= 100);
    row.revenueYoYAccelPts = finite(row.revenueYoYPct) && finite(prior?.revenueYoYPct)
      ? round(row.revenueYoYPct - prior.revenueYoYPct) : null;
  });
  return {
    quarters: rows,
    annual: series.revenue.a.map(a => ({ start: a.start, end: a.end, revenue: a.val, accn: a.src.accn, filed: a.src.filed,
      operatingIncome: series.operatingIncome.a.find(x => x.end === a.end)?.val ?? null,
      netIncome: series.netIncome.a.find(x => x.end === a.end)?.val ?? null })),
    latest: rows.at(-1) ?? null,
    annualFlows: Object.fromEntries(['buyback', 'stockIssued', 'netIncome', 'operatingIncome'].map(m =>
      [m, series[m].a.map(a => ({ end: a.end, val: a.val }))])),
    balance: Object.fromEntries(Object.keys(INSTANT_CONCEPTS).map(m => [m, latestInstant(companyfacts, m)])),
    shares: sharesOutstanding(companyfacts),
    restatedRevenueEnds: [...restatedPeriods(companyfacts, 'revenue')].sort(),
    dilutedSharesSeries: series.dilutedShares.q.map(q => ({ end: q.end, val: q.val })),
    latestDilutedShares: series.dilutedShares.q.at(-1)?.val ?? null,
    definitions: {
      quarter: '80〜100日の会計期間。10-Qの単独四半期値、またはYTD累計の差分（Q4＝通期−9か月、CFの各四半期）。derived=trueは差分で算出',
      dedupe: '同一期間の値は最新提出（修正報告・後年の比較表示を含む）を採用',
      yoy: '同じ指標の約1年前（期末日±10日）の四半期と比較。前年が0以下・欠損ならnull',
      ttm: '連続する4四半期の合計（期間350〜380日）。欠けがあればnull',
      eps: '希薄化後EPS（EarningsPerShareDiluted）。Q4は通期EPS−(Q1+Q2+Q3)の近似（epsDilutedDerived=true）。TTMは期末が会計年度末なら通期EPS（正確）、それ以外は4四半期の合計（近似）',
      restatement: '最新提出値を採用するため、事業売却等で継続事業ベースに修正再表示された過去値（例: APPの2024年売上 4,709.2→3,224.1百万ドル）は修正後の値になる',
      fcf: '営業CF − 設備投資（PaymentsToAcquirePropertyPlantAndEquipment）。どちらか欠損ならnull',
      ruleOf40: 'TTM売上成長率(%) + TTM FCFマージン(%)',
      ruleOf40Legacy: '旧アプリ互換：単四半期の前年同期比売上成長率 + 同四半期のGAAP営業利益率',
      operatingLeverage: 'TTM営業利益成長率 ÷ TTM売上成長率（売上成長率1%未満はnull）。operatingLeverageQは単四半期の前年比どうし',
      costRatio: '売上原価（CostOfRevenue / CostOfGoodsAndServicesSold）÷ 売上'
    }
  };
}
