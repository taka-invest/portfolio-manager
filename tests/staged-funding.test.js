'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Data = require('../app/data.js');
const Stage = require('../app/staged-funding.js');
const Market = require('../app/market.js');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const FRIDAY = Date.parse('2026-11-20T21:00:00Z');
const PRICE = { PLTR: 143.49, NVDA: 125.53, AVGO: 304.41, CRDO: 99.86,
  APP: 348.29, SOFI: 12.48, RKLB: 45.42 };
const lot = (ticker, shares, basis = 12000) => ({
  id: 'test-' + ticker, ticker, kind: 'stock', accountType: 'specific',
  broker: 'Monex', account: '', shares, currency: 'JPY',
  unitCost: basis, costJpy: shares * basis, referenceJpy: null, layer: 1, note: ''
});
function data(overrides = {}) {
  return { ...Data.blank(), confirmed: true,
    positions: [lot('PLTR', 1021, 12357), lot('NVDA', 25, 23000),
      lot('APP', 191, 52000), lot('SOFI', 2364, 1700), lot('RKLB', 354, 9000)],
    cash: { jpy: 1800000, usd: 0, extraJpy: 0, extraIncluded: true },
    ...overrides };
}
function market(rate = 158.54) {
  return { fx: { rate, date: '2026-11-22', at: NOW, kind: 'spot', source: 'Live-Rates' },
    quotes: Object.fromEntries(Object.entries(PRICE).map(([ticker, usd]) =>
      [ticker, { usd, at: FRIDAY }])) };
}

test('three fixed stage budgets, net tax funding, 30% PLTR hard floor, and integer shares', () => {
  for (let stage = 1; stage <= 3; stage++) {
    const out = Stage.calc(data(), market(), stage, NOW);
    assert.deepEqual(out.errors, []);
    assert.equal(out.budget, [5000000, 3000000, 2000000][stage - 1]);
    assert.ok(out.sale.shares >= 0 && Number.isSafeInteger(out.sale.shares));
    assert.ok(out.afterPltrPct >= 30 - 1e-8, String(out.afterPltrPct));
    assert.ok(out.buyTotal <= out.budget + 0.001);
    assert.ok(out.buyTotal <= out.sale.net + 0.001);
    assert.ok(out.rows.every(r => Number.isSafeInteger(r.qty) && r.qty <= r.maxQty));
    assert.ok(out.rows.every(r => r.qty * r.priceJpy <= r.gap + 0.001));
    const expectedTotal = out.total - out.sale.tax - out.sale.fee;
    assert.ok(Math.abs(out.sale.postTotal - expectedTotal) < .001);
    assert.ok(out.sale.postPltrValue >= out.sale.postTotal * .3 - .001);
  }
});

test('near-30% PLTR holdings cannot be used to overfund stage purchase', () => {
  const below = data({ positions: [lot('PLTR', 100, 1000), lot('APP', 1000, 1000)],
    cash: { jpy: 25000000, usd: 0, extraJpy: 0, extraIncluded: true } });
  const out = Stage.calc(below, market(), 1, NOW);
  assert.deepEqual(out.errors, []);
  assert.equal(out.maxShares, 0);
  assert.equal(out.sale.shares, 0);
  assert.equal(out.buyTotal, 0);
  assert.ok(out.shortage > 0);
  assert.ok(out.alerts.some(x => x.includes('30%')));
});

test('stocks and USDJPY move, so current target gaps and whole share plans change', () => {
  const first = Stage.calc(data(), market(158.54), 1, NOW);
  const pricedUp = market(165);
  pricedUp.quotes.NVDA.usd = 180;
  const second = Stage.calc(data(), pricedUp, 1, NOW);
  assert.deepEqual(first.errors, []);
  assert.deepEqual(second.errors, []);
  assert.notEqual(first.total, second.total);
  assert.notEqual(first.rows.find(x => x.ticker === 'NVDA').qty,
    second.rows.find(x => x.ticker === 'NVDA').qty);
});

test('later stage uses actual updated holdings, not stale predetermined orders', () => {
  const before = data();
  const first = Stage.calc(before, market(), 1, NOW);
  const actual = data({ positions: [...before.positions, lot('AVGO', 20, 46000),
    lot('CRDO', 15, 15000), { ...lot('NVDA', 60, 20000), id: 'buy-nvda' }],
    cash: { jpy: 0, usd: 0, extraJpy: 0, extraIncluded: true } });
  // Simulate executed PLTR sale, keeping the actual realized trade in positions.
  actual.positions[0] = { ...actual.positions[0],
    shares: actual.positions[0].shares - first.sale.shares,
    costJpy: 12357 * (actual.positions[0].shares - first.sale.shares) };
  const next = Stage.calc(actual, market(), 2, NOW);
  assert.deepEqual(next.errors, []);
  assert.equal(next.budget, 3000000);
  assert.ok(next.rows.find(x => x.ticker === 'NVDA').currentShares > 25);
  assert.ok(next.afterPltrPct >= 30 - 1e-8);
});

test('unverified FX, stale quotes, missing basis or unconfirmed holdings block proposals', () => {
  const quotes = market();
  assert.ok(Stage.calc(data({ confirmed: false }), quotes, 1, NOW).errors.length);
  assert.ok(Stage.calc(data(), { ...quotes, fx: { rate: 158.54, date: '2026-11-20' } }, 1, NOW).errors.length);
  assert.ok(Stage.calc(data(), { ...quotes, fx: { ...quotes.fx, at: NOW - 5 * 3600000 } }, 1, NOW).errors.length);
  assert.ok(Stage.calc(data(), { ...quotes, quotes: { ...quotes.quotes, NVDA: { usd: 125, at: FRIDAY - 86400000 } } }, 1, NOW).errors.length);
  const noBasis = data();
  noBasis.positions[0].costJpy = null;
  assert.ok(Stage.calc(noBasis, market(), 1, NOW).errors.length);
});

test('there are no buy orders above the three target weights', () => {
  const largePositions = data({ positions: [...data().positions, lot('CRDO', 1000), lot('AVGO', 3000)] });
  const out = Stage.calc(largePositions, market(), 1, NOW);
  assert.deepEqual(out.errors, []);
  assert.equal(out.rows.find(r => r.ticker === 'AVGO').qty, 0);
  assert.equal(out.rows.find(r => r.ticker === 'CRDO').qty, 0);
});
