'use strict';
// Corrected SEC financial layer. Expected values are calculated by hand from the
// synthetic companyfacts below, which mimics real EDGAR shapes:
//  - 10-Q: discrete 3M income-statement facts + YTD (6M/9M) facts, with prior-year comparatives
//  - cash flow reported ONLY as YTD (3M/6M/9M/FY)
//  - Q4 never filed directly (only the 10-K full year)
//  - 10-K includes prior-year full-year comparatives (must not duplicate)
//  - a 10-Q/A restates Q2 2024 revenue (latest filing must win)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const load = () => import('file://' + join(__dirname, '..', 'functions/src/sec/financials.js'));

const P = {
  q1_23: ['2023-01-01', '2023-03-31'], q2_23: ['2023-04-01', '2023-06-30'], q3_23: ['2023-07-01', '2023-09-30'],
  h1_23: ['2023-01-01', '2023-06-30'], m9_23: ['2023-01-01', '2023-09-30'], fy23: ['2023-01-01', '2023-12-31'],
  fy22: ['2022-01-01', '2022-12-31'],
  q1_24: ['2024-01-01', '2024-03-31'], q2_24: ['2024-04-01', '2024-06-30'], q3_24: ['2024-07-01', '2024-09-30'],
  h1_24: ['2024-01-01', '2024-06-30'], m9_24: ['2024-01-01', '2024-09-30'], fy24: ['2024-01-01', '2024-12-31']
};
const F = { // filings: [form, filed, accn]
  q1_23: ['10-Q', '2023-05-01', 'a1'], q2_23: ['10-Q', '2023-08-01', 'a2'], q3_23: ['10-Q', '2023-11-01', 'a3'],
  k23: ['10-K', '2024-02-20', 'a4'], q1_24: ['10-Q', '2024-05-01', 'b1'], q2_24: ['10-Q', '2024-08-01', 'b2'],
  q3_24: ['10-Q', '2024-11-01', 'b3'], k24: ['10-K', '2025-02-20', 'b4'], q2_24a: ['10-Q/A', '2024-09-15', 'b2a']
};
const fact = (period, val, filing) => ({ start: P[period][0], end: P[period][1], val,
  form: F[filing][0], filed: F[filing][1], accn: F[filing][2] });
const usd = facts => ({ units: { USD: facts } });

const revenue = [
  fact('q1_23', 100, 'q1_23'), fact('q2_23', 110, 'q2_23'), fact('h1_23', 210, 'q2_23'),
  fact('q3_23', 120, 'q3_23'), fact('m9_23', 330, 'q3_23'), fact('fy23', 460, 'k23'), fact('fy22', 300, 'k23'),
  fact('q1_24', 150, 'q1_24'), fact('q1_23', 100, 'q1_24'),
  fact('q2_24', 160, 'q2_24'), fact('h1_24', 310, 'q2_24'), fact('q2_23', 110, 'q2_24'),
  fact('q2_24', 165, 'q2_24a'), // restated
  fact('q3_24', 170, 'q3_24'), fact('m9_24', 480, 'q3_24'),
  fact('fy24', 660, 'k24'), fact('fy23', 460, 'k24'), fact('fy22', 300, 'k24')
];
const opIncome = [
  fact('q1_23', 10, 'q1_23'), fact('q2_23', 11, 'q2_23'), fact('q3_23', 12, 'q3_23'), fact('fy23', 50, 'k23'),
  fact('q1_24', 15, 'q1_24'), fact('q2_24', 16, 'q2_24'), fact('q3_24', 17, 'q3_24'), fact('fy24', 70, 'k24')
];
const ytd = (y, vals, filings) => ['q1_' + y, 'h1_' + y, 'm9_' + y, 'fy' + y].map((p, i) => fact(p, vals[i], filings[i]));
const ocf = [...ytd('23', [30, 70, 120, 180], ['q1_23', 'q2_23', 'q3_23', 'k23']),
  ...ytd('24', [50, 110, 180, 260], ['q1_24', 'q2_24', 'q3_24', 'k24'])];
const capex = [...ytd('23', [5, 10, 15, 20], ['q1_23', 'q2_23', 'q3_23', 'k23']),
  ...ytd('24', [10, 20, 30, 40], ['q1_24', 'q2_24', 'q3_24', 'k24'])];
const eps = { units: { 'USD/shares': [
  fact('q1_24', 0.10, 'q1_24'), fact('q2_24', 0.11, 'q2_24'), fact('q3_24', 0.12, 'q3_24'), fact('fy24', 0.50, 'k24')] } };

const companyfacts = { facts: { 'us-gaap': {
  RevenueFromContractWithCustomerExcludingAssessedTax: usd(revenue),
  OperatingIncomeLoss: usd(opIncome),
  NetCashProvidedByUsedInOperatingActivities: usd(ocf),
  PaymentsToAcquirePropertyPlantAndEquipment: usd(capex),
  EarningsPerShareDiluted: eps
} } };

test('Q4 is synthesised as FY − 9M and cash-flow quarters come from YTD differences', async () => {
  const { analyzeFacts } = await load();
  const { quarters } = analyzeFacts(companyfacts);
  assert.deepEqual(quarters.map(q => q.end),
    ['2023-03-31', '2023-06-30', '2023-09-30', '2023-12-31', '2024-03-31', '2024-06-30', '2024-09-30', '2024-12-31']);
  const q4 = quarters.at(-1);
  assert.equal(q4.revenue, 180);            // 660 − 480
  assert.equal(q4.revenueDerived, true);
  assert.equal(q4.start, '2024-10-01');
  assert.equal(q4.operatingIncome, 22);     // no 9M fact: FY − (Q1+Q2+Q3) = 70 − 48
  assert.equal(q4.operatingCashFlow, 80);   // 260 − 180
  assert.equal(q4.capex, 10);
  assert.equal(q4.fcf, 70);
  assert.equal(quarters[5].operatingCashFlow, 60); // Q2'24 = 110 − 50
});

test('restated 10-Q/A value wins and 10-K comparatives do not duplicate annual rows', async () => {
  const { analyzeFacts } = await load();
  const out = analyzeFacts(companyfacts);
  assert.equal(out.quarters.find(q => q.end === '2024-06-30').revenue, 165);
  assert.deepEqual(out.annual.map(a => [a.end, a.revenue]), [['2022-12-31', 300], ['2023-12-31', 460], ['2024-12-31', 660]]);
});

test('YoY, TTM, Rule of 40 (both definitions) and operating leverage are matched by date', async () => {
  const { analyzeFacts } = await load();
  const l = analyzeFacts(companyfacts).latest;
  assert.equal(l.revenueYoYPct, 38.5);        // 180/130 − 1
  assert.equal(l.revenueTtm, 665);            // 150+165+170+180
  assert.equal(l.revenueTtmYoYPct, 44.6);     // 665/460 − 1
  assert.equal(l.fcfTtm, 220);                // (260) − (40)
  assert.equal(l.fcfMarginTtmPct, 33.1);      // 220/665
  assert.equal(l.ruleOf40, 77.6);             // 44.565 + 33.083
  assert.equal(l.operatingMarginPct, 12.2);   // 22/180
  assert.equal(l.ruleOf40Legacy, 50.7);       // 38.46 + 12.22
  assert.equal(l.operatingLeverage, 0.9);     // (70/50 − 1) / (665/460 − 1)
  const q2 = analyzeFacts(companyfacts).quarters.find(q => q.end === '2024-06-30');
  assert.equal(q2.revenueYoYPct, 50);         // 165/110 − 1 (restated value)
});

test('per-share values are never differenced; missing inputs stay null, never 0', async () => {
  const { analyzeFacts } = await load();
  const l = analyzeFacts(companyfacts).latest;
  assert.equal(Math.round(l.epsDiluted * 100) / 100, 0.17); // Q4 ≈ FY 0.50 − (0.10+0.11+0.12), flagged approx
  assert.equal(l.epsDilutedDerived, true);
  assert.equal(l.epsDilutedTtm, 0.5);         // fiscal-year end: exact FY diluted EPS, not a sum
  const q3 = analyzeFacts(companyfacts).quarters.find(q => q.end === '2024-09-30');
  assert.equal(q3.epsDilutedTtm, null);       // 2023 quarterly EPS not filed -> no TTM, never 0
  const noCapex = structuredClone(companyfacts);
  delete noCapex.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment;
  const m = analyzeFacts(noCapex).latest;
  assert.equal(m.fcf, null);
  assert.equal(m.fcfTtm, null);
  assert.equal(m.ruleOf40, null);
  assert.equal(m.revenue, 180);
  const empty = analyzeFacts({ facts: {} });
  assert.equal(empty.latest, null);
  assert.deepEqual(empty.quarters, []);
});

test('legacy engine defect is real: position-based YoY would compare against the wrong quarter', async () => {
  // Without Q4 synthesis the legacy array skips Q4 2023, so "i+4" lands 15 months back.
  const { durationFacts } = await load();
  const legacyQuarters = durationFacts(companyfacts, 'revenue').filter(f => f.days >= 75 && f.days <= 110);
  const ends = legacyQuarters.map(q => q.end);
  assert.ok(!ends.includes('2023-12-31') && !ends.includes('2024-12-31'));
  const latest = legacyQuarters.at(-1), fourBack = legacyQuarters.at(-5);
  assert.equal(latest.end, '2024-09-30');
  assert.equal(fourBack.end, '2023-06-30'); // legacy partner for YoY: 15 months back, not 2023-09-30
});

test('companyFinancials resolves CIK, returns source metadata and 404s unknown tickers', async () => {
  const { companyFinancials } = await import('file://' + join(__dirname, '..', 'functions/src/sec/company.js'));
  const urls = [];
  const fetchJson = async url => {
    urls.push(url);
    if (url.endsWith('company_tickers.json')) return { 0: { cik_str: 1234, ticker: 'ACME', title: 'Acme Corp' } };
    return { ...companyfacts, entityName: 'ACME CORP' };
  };
  const out = await companyFinancials('ACME', { fetchJson, now: () => new Date('2026-11-24T00:00:00Z') });
  assert.equal(out.cik, '0000001234');
  assert.equal(out.name, 'ACME CORP');
  assert.equal(out.source.url, 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000001234.json');
  assert.equal(out.source.retrievedAt, '2026-11-24T00:00:00.000Z');
  assert.equal(out.source.currency, 'USD');
  assert.equal(out.status, 'verification-pending');
  assert.equal(out.latest.revenue, 180);
  await assert.rejects(companyFinancials('NOPE', { fetchJson }), e => e.status === 404);
});
