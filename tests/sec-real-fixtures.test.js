'use strict';
// Verification against REAL SEC EDGAR companyfacts snapshots (tests/fixtures/sec/*.json,
// fetched 2026-11-24 via scripts/fetch-sec-fixtures.mjs). Expected figures are values
// filed with the SEC (10-K/10-Q) or arithmetic on them, cross-checked against the
// legacy Netlify engine output for the same quarters (docs/FINANCIAL_VERIFICATION.md).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const load = () => import('file://' + join(__dirname, '..', 'functions/src/sec/financials.js'));
const fixture = t => JSON.parse(readFileSync(join(__dirname, 'fixtures/sec', t + '.json'), 'utf8'));
const M = v => Math.round(v / 1e5) / 10; // USD -> $M with 1 decimal

async function run(t) { const { analyzeFacts } = await load(); return analyzeFacts(fixture(t)); }
const q = (out, end) => out.quarters.find(x => x.end === end);

test('quarter series are continuous (Q4 synthesised) for PLTR, APP, NVDA', async () => {
  for (const t of ['PLTR', 'APP', 'NVDA']) {
    const out = await run(t);
    assert.ok(out.quarters.length >= 16, t + ' has at least 16 quarters');
    for (let i = 1; i < out.quarters.length; i++) {
      const gap = (Date.parse(out.quarters[i].end) - Date.parse(out.quarters[i - 1].end)) / 864e5;
      assert.ok(gap >= 80 && gap <= 100, `${t} gap ${out.quarters[i - 1].end} -> ${out.quarters[i].end}`);
    }
  }
});

test('annual revenue: one row per fiscal year, filed values', async () => {
  const pltr = await run('PLTR'), nvda = await run('NVDA');
  const ann = (out, end) => out.annual.filter(a => a.end === end);
  assert.equal(ann(pltr, '2024-12-31').length, 1);
  assert.equal(M(ann(pltr, '2023-12-31')[0].revenue), 2225.0);
  assert.equal(M(ann(pltr, '2024-12-31')[0].revenue), 2865.5);
  assert.equal(M(ann(nvda, '2024-01-28')[0].revenue), 60922.0);
  assert.equal(M(ann(nvda, '2025-01-26')[0].revenue), 130497.0);
});

test('NVDA Q2 FY2026 (2025-07-27): revenue, operating cash flow, capex, FCF', async () => {
  const r = q(await run('NVDA'), '2025-07-27');
  assert.equal(M(r.revenue), 46743.0);
  assert.equal(M(r.operatingCashFlow), 15365.0);   // derived: 6M YTD − Q1
  assert.equal(M(r.capex), 1895.0);
  assert.equal(M(r.fcf), 13470.0);
});

test('YoY is matched by date: PLTR 2026-09-30 compares with 2025-09-30, not 2025-06-30', async () => {
  const out = await run('PLTR');
  const cur = q(out, '2026-09-30'), prev = q(out, '2025-09-30');
  assert.equal(M(cur.revenue), 2313.4);
  assert.equal(M(prev.revenue), 1181.1);
  assert.equal(cur.revenueYoYPct, 95.9);           // legacy engine showed 130.5 (vs 2025-06-30)
});

test('Q4 synthesis equals FY − 9M on real filings (PLTR FY2025, NVDA FY2026)', async () => {
  const pltr = await run('PLTR');
  const p = q(pltr, '2025-12-31');
  assert.equal(p.revenueDerived, true);
  assert.equal(M(p.revenue), 1406.8);
  const nvda = await run('NVDA');
  const n = q(nvda, '2026-01-25');
  assert.equal(n.revenueDerived, true);
  assert.equal(M(n.revenue), 68127.0);
  const fy = nvda.annual.find(a => a.end === '2026-01-25').revenue;
  const nine = ['2025-04-27', '2025-07-27', '2025-10-26'].reduce((s, e) => s + q(nvda, e).revenue, 0);
  assert.equal(n.revenue, fy - nine);
});

test('APP: restated continuing-operations revenue is used; missing capex keeps FCF null (not 0)', async () => {
  const app = await run('APP');
  assert.equal(M(app.annual.find(a => a.end === '2024-12-31').revenue), 3224.1); // originally 4,709.2
  const latest = app.latest;
  assert.equal(M(latest.revenue), 2184.8);
  assert.equal(latest.capex, null);
  assert.equal(latest.fcf, null);
  assert.equal(latest.ruleOf40, null);
  assert.equal(latest.revenueYoYPct, 55.5);
});
