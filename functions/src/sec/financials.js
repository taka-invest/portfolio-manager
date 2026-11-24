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
  dilutedShares: ['WeightedAverageNumberOfDilutedSharesOutstanding']
};
const UNITS = { epsDiluted: 'USD/shares', epsBasic: 'USD/shares', dilutedShares: 'shares' };
// Per-share and share-count values cannot be differenced into quarters.
const ADDITIVE = new Set(['revenue', 'grossProfit', 'operatingIncome', 'netIncome', 'operatingCashFlow', 'capex']);

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

/** Discrete fiscal quarters: direct ~3-month facts, plus differences of YTD cumulatives. */
export function quarters(facts, { additive = true } = {}) {
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
  if (additive) {
    // Fallback when no 9M YTD fact exists: Q4 = FY − (Q1+Q2+Q3) for three contiguous quarters.
    for (const fy of facts.filter(f => within(f.days, ANNUAL))) {
      if (out.has(fy.end)) continue;
      const inside = [...out.values()].filter(q => q.start >= fy.start && q.end < fy.end)
        .sort((a, b) => a.end.localeCompare(b.end));
      if (inside.length !== 3 || inside[0].start !== fy.start) continue;
      const contiguous = inside.every((q, k) => k === 0 || dayNum(q.start) - dayNum(inside[k - 1].end) === 1);
      const qDays = dayNum(fy.end) - dayNum(inside[2].end);
      if (!contiguous || !within(qDays, QUARTER)) continue;
      put({ start: isoOf(dayNum(inside[2].end) + 1), end: fy.end, val: fy.val - inside.reduce((s, q) => s + q.val, 0),
        derived: true, direct: false, src: { annual: fy, quarters: inside.map(q => q.end) } }, false);
    }
  }
  return [...out.values()].sort((a, b) => a.end.localeCompare(b.end));
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
    series[metric] = { q: quarters(facts, { additive: ADDITIVE.has(metric) }), a: annuals(facts) };
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
    const epsTtm = ttm(series.epsDiluted.q, r.end);
    const epsPrev = yearAgo(series.epsDiluted.q, r.end);
    const revYoY = growthPct(r.val, prev?.val);
    const revTtmYoY = growthPct(revTtm?.val, revTtmPrev?.val);
    const opTtmYoY = growthPct(opTtm?.val, opTtmPrev?.val);
    return {
      start: r.start, end: r.end, revenueDerived: r.derived,
      revenue: r.val, grossProfit: gp?.val ?? null, operatingIncome: op?.val ?? null,
      netIncome: ni?.val ?? null, epsDiluted: eps?.val ?? null, epsDilutedDerived: eps?.derived ?? null,
      operatingCashFlow: ocf?.val ?? null, capex: cap?.val ?? null, fcf,
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
    annual: series.revenue.a.map(a => ({ start: a.start, end: a.end, revenue: a.val,
      operatingIncome: series.operatingIncome.a.find(x => x.end === a.end)?.val ?? null,
      netIncome: series.netIncome.a.find(x => x.end === a.end)?.val ?? null })),
    latest: rows.at(-1) ?? null,
    definitions: {
      quarter: '80〜100日の会計期間。10-Qの単独四半期値、またはYTD累計の差分（Q4＝通期−9か月、CFの各四半期）。derived=trueは差分で算出',
      dedupe: '同一期間の値は最新提出（修正報告・後年の比較表示を含む）を採用',
      yoy: '同じ指標の約1年前（期末日±10日）の四半期と比較。前年が0以下・欠損ならnull',
      ttm: '連続する4四半期の合計（期間350〜380日）。欠けがあればnull',
      eps: '希薄化後EPS（EarningsPerShareDiluted）。TTMは4四半期の合計（近似）',
      fcf: '営業CF − 設備投資（PaymentsToAcquirePropertyPlantAndEquipment）。どちらか欠損ならnull',
      ruleOf40: 'TTM売上成長率(%) + TTM FCFマージン(%)',
      ruleOf40Legacy: '旧アプリ互換：単四半期の前年同期比売上成長率 + 同四半期のGAAP営業利益率',
      operatingLeverage: 'TTM営業利益成長率 ÷ TTM売上成長率（売上成長率1%未満はnull）'
    }
  };
}
