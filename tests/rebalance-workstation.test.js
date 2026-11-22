'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const R = require('../app/rebalance.js');
const V = require('../app/rebalance-view.js');
const now = Date.parse('2026-11-22T12:00:00Z');
const close = Date.parse('2026-11-20T21:00:00Z');
const quote = usd => ({ usd, at: close });
const base = (fields = {}) => ({ ...D.blank(), confirmed: true, ...fields });
const tgt = (ticker, pct, props = {}) => ({
  ticker, pct, group: 'core', sellCap: null, wait: false, ...props
});
const lot = (ticker, shares, props = {}) => ({
  id: ticker, ticker, shares, kind: 'stock', broker: 'Broker', account: 'Account',
  accountType: 'specific', currency: 'USD', layer: 1, unitCost: 10,
  costJpy: 1000 * shares, referenceJpy: null, note: '', ...props
});
function run(fields, values, fx = 100) {
  return R.simulate(base(fields), {
    quotes: Object.fromEntries(Object.entries(values).map(([ticker, price]) => [ticker, quote(price)])),
    fx: { rate: fx, date: '2026-11-20' }
  }, now);
}
function almost(a, b, tolerance = 1e-5) {
  assert.ok(Math.abs(a - b) <= tolerance, a + ' vs ' + b);
}
test('ideal rows contain USD/JPY value, integer share goal and after-tax targets', () => {
  const out = run({ cash: { jpy: 300000, usd: 0, extraJpy: 0, extraIncluded: true },
    targets: [tgt('NVDA', 45), tgt('APP', 45)], cashTarget: 10 },
  { NVDA: 120, APP: 65 }, 150);
  assert.deepEqual(out.errors, []);
  assert.equal(out.total, 300000);
  const n = out.rows.find(row => row.ticker === 'NVDA');
  almost(n.target, 135000);
  almost(n.targetUsd, 900);
  almost(n.targetShares, 7.5);
  assert.equal(n.idealWholeShares, 7);
  assert.equal(n.order, 7);
  assert.equal(n.afterShares, 7);
  assert.ok(out.cashAfter >= out.reserve);
  almost(out.rows.reduce((sum, row) => sum + row.afterValue, 0) + out.cashAfter, out.postTotal);
});

test('funded sell/buy case: tax, reserve, integer lot cap, share orders and JPY/USD reconcile', () => {
  const out = run({
    positions: [lot('PLTR', 20, { costJpy: 20000 })],
    targets: [tgt('PLTR', 20, { sellCap: 4 }), tgt('APP', 70)],
    cashTarget: 10,
    cash: { jpy: 10000, usd: 100, extraJpy: 0, extraIncluded: true },
    tax: { rate: 20.315, offset: 'none' }
  }, { PLTR: 100, APP: 40 }, 150);
  assert.deepEqual(out.errors, []);
  const pltr = out.rows.find(x => x.ticker === 'PLTR');
  const app = out.rows.find(x => x.ticker === 'APP');
  assert.equal(pltr.order, -4);
  assert.equal(pltr.afterShares, 16);
  assert.ok(out.sales.every(x => Number.isInteger(x.shares)));
  assert.ok(out.tax > 0);
  assert.ok(app.order > 0);
  assert.equal(Number.isInteger(app.order), true);
  assert.ok(out.cashAfter >= out.reserve - 1e-6);
  almost(out.cashAfter, out.cashAfterJpy + out.cashAfterUsd * out.fx.rate);
  almost(out.total - out.tax, out.postTotal);
  almost(out.cash + out.saleJpy - out.tax - out.purchaseJpy, out.cashAfter);
  almost(out.rows.reduce((sum, row) => sum + row.afterPct, out.cashAfterPct), 100);
  assert.ok(out.allocationGap > 0, 'cap creates unavoidable tracking error');
});

test('no price for waiting SPCX keeps the result safe and shows unknown ideal shares', () => {
  const state = base({
    targets: [tgt('SPCX', 20, { group: 'satellite', wait: true }), tgt('NVDA', 70)],
    cashTarget: 10, cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true }
  });
  const out = R.simulate(state, {
    quotes: { SPCX: { error: 'unverified' }, NVDA: quote(50) },
    fx: { rate: 100, date: '2026-11-20' }
  }, now);
  assert.deepEqual(out.errors, []);
  const waiting = out.rows.find(x => x.ticker === 'SPCX');
  assert.equal(waiting.order, 0);
  assert.equal(waiting.idealWholeShares, null);
  assert.equal(waiting.status, 'watch');
  assert.ok(V.ideal(out).includes('価格未確認・待機'));
  assert.ok(V.trades(out).includes('株価未確認'));
});

test('the two before/after donut charts and execution panels render with the same stable colors', () => {
  const state = base({
    positions: [lot('NVDA', 10)],
    targets: [tgt('NVDA', 20), tgt('APP', 70)],
    cashTarget: 10,
    cash: { jpy: 20000, usd: 0, extraJpy: 0, extraIncluded: true }
  });
  const out = run(state, { NVDA: 100, APP: 60 });
  assert.deepEqual(out.errors, []);
  const html = V.comparison(out, state);
  assert.ok(html.includes('売買前'));
  assert.ok(html.includes('売買後'));
  assert.ok(html.includes('svg'));
  assert.ok(html.includes('目標との差'));
  assert.ok(html.includes('CASH'));
  assert.equal(V.color('NVDA'), V.color('NVDA'));
  assert.ok(V.trades(out).includes('SELL'));
  assert.ok(V.trades(out).includes('BUY'));
  assert.ok(V.trades(out).includes('USD'));
});

test('empty or stale data never produces buy/sell recommendations', () => {
  const blocked = R.simulate(base({ targets: [tgt('NVDA', 90)] }),
    { quotes: { NVDA: { usd: 50, at: 0 } }, fx: { rate: 100, date: '2026-11-20' } }, now);
  assert.ok(blocked.errors.length);
  assert.deepEqual(blocked.rows, []);
  assert.equal(V.ideal(blocked), '');
  assert.equal(V.trades(blocked), '');
  assert.equal(V.comparison(blocked, D.blank()), '');
});
