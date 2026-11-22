'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Data = require('../app/data.js');
const Stage = require('../app/staged-funding.js');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const CLOSE = Date.parse('2026-11-20T21:00:00Z');
const PRICES = { PLTR: 143.49, NVDA: 125.53, AVGO: 304.41, CRDO: 99.86,
  APP: 348.29, SOFI: 12.48, RKLB: 45.42 };
const lot = (ticker, shares, basis = 12000, id = ticker) => ({
  id, ticker, kind: 'stock', accountType: 'specific', broker: 'Monex',
  account: '', shares, currency: 'JPY', unitCost: basis, costJpy: shares * basis,
  referenceJpy: null, layer: 1, note: ''
});
function market(fx = 158.54, prices = PRICES) {
  return { fx: { rate: fx, date: '2026-11-22', at: NOW, kind: 'spot' },
    quotes: Object.fromEntries(Object.entries(prices).map(([ticker, usd]) =>
      [ticker, { usd, at: CLOSE }])) };
}
function state(overrides = {}) {
  const base = { ...Data.blank(), confirmed: true,
    positions: [lot('PLTR', 1100, 12357), lot('APP', 120, 50000),
      lot('SOFI', 600, 1700), lot('RKLB', 100, 9000), lot('NVDA', 25, 22000)],
    cash: { jpy: 250000, usd: 0, extraJpy: 0, extraIncluded: true } };
  const prepared = { ...base, ...overrides };
  return { ...prepared, stagedFunding: overrides.stagedFunding === undefined ?
    Stage.snapshot(prepared, NOW) : overrides.stagedFunding };
}
function reconciled(current, out, prices, fx) {
  const positions = current.positions.map(p => ({ ...p }));
  const held = positions.find(p => p.ticker === 'PLTR');
  const oldQty = held.shares;
  held.shares -= out.sale.shares;
  held.costJpy = held.costJpy * held.shares / oldQty;
  for (const row of out.rows) {
    if (row.qty > 0) positions.push(lot(row.ticker, row.qty,
      prices[row.ticker] * fx, 'buy-' + row.ticker));
  }
  return state({ ...current, positions,
    cash: { ...current.cash, jpy: current.cash.jpy + out.sale.net - out.buyTotal },
    stagedFunding: current.stagedFunding });
}

test('new plan must explicitly snapshot initial quantities; backup validation preserves snapshot', () => {
  const s = state({ stagedFunding: null });
  assert.ok(Stage.calc(s, market(), 1, NOW).errors.length);
  const plan = Stage.snapshot(s, NOW);
  assert.deepEqual(plan.baselineShares, { NVDA: 25, AVGO: 0, CRDO: 0 });
  const stored = Data.validate({ ...s, stagedFunding: plan });
  assert.deepEqual(stored.stagedFunding, plan);
  assert.equal(Data.validate(Data.blank()).stagedFunding, null);
});

test('A/B/C are cumulative 50/80/100% of live shortage, not fixed yen amounts', () => {
  const s = state();
  const amounts = [];
  for (let step = 1; step <= 3; step++) {
    const out = Stage.calc(s, market(), step, NOW);
    assert.deepEqual(out.errors, []);
    assert.equal(out.stagePct, [50, 80, 100][step - 1]);
    assert.ok(out.idealBudget > 0);
    assert.ok(out.rows.every(r => Number.isSafeInteger(r.qty) && r.qty <= r.maxQty));
    assert.ok(out.buyTotal <= out.sale.net + 1e-3);
    assert.ok(out.sale.shares === 0 || out.afterPltrPct >= 30 - 1e-8);
    amounts.push(out.idealBudget);
  }
  assert.ok(amounts[0] < amounts[1] && amounts[1] < amounts[2]);
  assert.notEqual(Math.round(amounts[0]), 5000000);
  assert.notEqual(Math.round(amounts[1]), 3000000);
  assert.notEqual(Math.round(amounts[2]), 2000000);
});

test('existing initial NVDA shares reduce A purchase; B subtracts ACTUAL A orders at current market prices', () => {
  const s = state();
  const a = Stage.calc(s, market(), 1, NOW);
  const adjusted = reconciled(s, a, PRICES, 158.54);
  assert.ok(adjusted.positions.find(p => p.id === 'buy-NVDA'));
  assert.deepEqual(adjusted.stagedFunding.baselineShares, s.stagedFunding.baselineShares);
  const b = Stage.calc(adjusted, market(162.15, { ...PRICES, NVDA: 140.0, AVGO: 290.0 }), 2, NOW);
  assert.deepEqual(b.errors, []);
  assert.equal(b.stagePct, 80);
  assert.ok(b.total !== a.total);
  const nvda = b.rows.find(r => r.ticker === 'NVDA');
  assert.equal(nvda.initialShares, 25);
  assert.equal(nvda.currentShares, 25 + a.rows.find(r => r.ticker === 'NVDA').qty);
  const expected = Math.max(0, Math.min(
    0.8 * Math.max(0, nvda.targetValue - nvda.initialValue) - nvda.executedValue,
    nvda.targetValue - nvda.currentValue));
  assert.ok(Math.abs(expected - nvda.gap) < 1);
  assert.ok(b.sale.shares === 0 || b.afterPltrPct >= 30 - 1e-8);
});

test('market-only repricing changes A budget even with identical positions', () => {
  const s = state();
  const original = Stage.calc(s, market(), 1, NOW);
  const moved = Stage.calc(s, market(163.6, { ...PRICES, NVDA: 180, AVGO: 325 }), 1, NOW);
  assert.deepEqual(original.errors, []);
  assert.deepEqual(moved.errors, []);
  assert.notEqual(Math.round(original.total), Math.round(moved.total));
  assert.notEqual(Math.round(original.idealBudget), Math.round(moved.idealBudget));
});

test('PLTR sell floor blocks additional liquidation; visible shortage is retained', () => {
  const s = state({ positions: [lot('PLTR', 100, 12000), lot('APP', 1000, 40000)] });
  const out = Stage.calc(s, market(), 1, NOW);
  assert.deepEqual(out.errors, []);
  assert.equal(out.maxShares, 0);
  assert.equal(out.sale.shares, 0);
  assert.equal(out.buyTotal, 0);
  assert.ok(out.shortage > 0);
  assert.ok(out.alerts.some(a => a.includes('30%')));
});

test('quotes missing, daily FX, unconfirmed holdings or cost basis missing block plan', () => {
  const s = state();
  assert.ok(Stage.calc({ ...s, confirmed: false }, market(), 1, NOW).errors.length);
  const rates = market();
  rates.fx = { rate: 158.54, date: '2026-11-20' };
  assert.ok(Stage.calc(s, rates, 1, NOW).errors.length);
  const quotes = market();
  quotes.quotes.AVGO.at -= 86400000;
  assert.ok(Stage.calc(s, quotes, 1, NOW).errors.length);
  const broken = state();
  broken.positions[0] = { ...broken.positions[0], costJpy: null };
  assert.ok(Stage.calc(broken, market(), 1, NOW).errors.length);
});

test('fully satisfied target never unnecessarily sells PLTR', () => {
  const s = state({ positions: [
    lot('PLTR', 1100, 12000), lot('APP', 80, 12000),
    lot('NVDA', 1000, 10000), lot('AVGO', 600, 15000), lot('CRDO', 600, 5000)
  ] });
  // Start plan when all target positions are already held.
  s.stagedFunding = Stage.snapshot(s, NOW);
  const out = Stage.calc(s, market(), 3, NOW);
  assert.deepEqual(out.errors, []);
  assert.equal(out.sale.shares, 0);
  assert.ok(out.rows.every(r => r.qty === 0));
});


test('keyless FX endpoint provides timestamped quote; timestamp-free hourly fallback never authorizes staged trades', async () => {
  const Market = require('../app/market.js');
  const now = Date.now();
  const spot = await Market.fetchFx(async url => {
    assert.ok(url.endsWith('/rates'));
    return { ok: true, json: async () => [
      { currency: 'USD/JPY', bid: '159.40', ask: '159.42', timestamp: String(now) }
    ] };
  });
  assert.equal(spot.kind, 'spot');
  assert.ok(Math.abs(spot.rate - 159.41) < 0.000001);
  assert.equal(Market.fxStatus(spot), 'ready');

  const fallback = await Market.fetchFx(async url => {
    if (url.endsWith('/rates')) throw new Error('quota');
    if (url.includes('exchangerate.fun')) return { ok: true, json: async () =>
      ({ base: 'USD', date: new Date().toISOString().slice(0, 10), rates: { JPY: 159.43 } }) };
    throw new Error('unexpected');
  });
  assert.equal(fallback.kind, 'reference');
  assert.ok(Stage.calc(state(), { ...market(), fx: fallback }, 1, NOW).errors.length);
});
