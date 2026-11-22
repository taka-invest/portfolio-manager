'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const R = require('../app/rebalance.js');

const time = Date.parse('2026-11-22T12:00:00Z');
const close = Date.parse('2026-11-20T21:00:00Z');
const lot = (fields = {}) => ({
 id: 'test-stock', ticker: 'PLTR', kind: 'stock', broker: 'マネックス証券',
 account: '', accountType: 'unknown', shares: 10, currency: 'USD', unitCost: 10,
 costJpy: 15000, referenceJpy: null, layer: 1, note: '', ...fields
});
const target = (ticker, pct) => ({ ticker, pct, group: 'core', wait: false, sellCap: null });

test('US stock account name optional; unknown account type defaults to 特定 while preserving shares and cost', () => {
 const source = lot();
 const result = D.validate({ ...D.blank(), confirmed: true, positions: [source] });
 const p = result.positions[0];
 assert.equal(p.broker, 'マネックス証券');
 assert.equal(p.account, '');
 assert.equal(p.accountType, 'specific');
 assert.equal(p.shares, 10);
 assert.equal(p.costJpy, 15000);
 assert.equal(D.readyLot(p), true);
 assert.equal(source.accountType, 'unknown', 'original source must not be mutated');
});
test('clearing account name does not block taxation; stock sale produces taxable gains', () => {
 const state = D.validate({
   ...D.blank(), confirmed: true, positions: [lot()],
   targets: [target('PLTR', 0), target('NVDA', 90)],
   cashTarget: 10, cash: { jpy: 10000, usd: 0, extraJpy: 0, extraIncluded: true }
 });
 const data = {
   quotes: { PLTR: { usd: 100, at: close }, NVDA: { usd: 50, at: close } },
   fx: { rate: 150, date: '2026-11-20' }
 };
 const out = R.simulate(state, data, time);
 assert.deepEqual(out.errors, []);
 assert.ok(out.sales.length > 0);
 assert.ok(out.sales.every(x => x.accountType === 'specific' && x.taxable));
 assert.ok(out.tax > 0);
 assert.ok(out.cashAfter >= out.reserve - 1e-6);
});
test('known NISA fund and explicitly labeled tax accounts are not silently rewritten', () => {
 const fund = lot({ id: 'fund-1', kind: 'fund', ticker: 'FUND', accountType: 'nisa' });
 const existing = lot({ id: 'stock-2', accountType: 'nisa' });
 const state = D.validate({ ...D.blank(), positions: [fund, existing] });
 assert.equal(state.positions[0].accountType, 'nisa');
 assert.equal(state.positions[1].accountType, 'nisa');
});
test('stock missing broker still requires reconciliation, even without account name', () => {
 const state = D.validate({ ...D.blank(), positions: [lot({ broker: '', account: '' })] });
 assert.equal(D.readyLot(state.positions[0]), false);
 assert.throws(() => D.validate({ ...state, confirmed: true }), /保有確認/);
});
