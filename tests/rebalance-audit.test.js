'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const R = require('../app/rebalance.js');
const A = require('../app/rebalance-audit.js');
const V = require('../app/rebalance-view.js');

const now = Date.parse('2026-11-22T12:00:00Z');
const quotedAt = Date.parse('2026-11-20T21:00:00Z');
const tgt = (ticker, pct, props = {}) => ({ ticker, pct, group: 'core',
  sellCap: null, wait: false, ...props });
const lot = (ticker, shares, props = {}) => ({ id: ticker, ticker, shares,
  kind: 'stock', broker: 'マネックス証券', account: '', accountType: 'specific',
  layer: 1, currency: 'USD', unitCost: 10, costJpy: shares * 500,
  referenceJpy: null, note: '', ...props });
function calc(options, prices, rate = 100) {
  const state = D.validate({ ...D.blank(), confirmed: true,
    cash: { jpy: 0, usd: 0, extraJpy: 0, extraIncluded: true },
    ...options });
  const market = { quotes: Object.fromEntries(Object.entries(prices).map(
    ([ticker, usd]) => [ticker, { usd, at: quotedAt }])),
    fx: { rate, date: '2026-11-20', kind: 'hourly', at: now } };
  return { state, out: R.simulate(state, market, now) };
}
const audit = ({state, out}) => A.assess(out, state);
const issue = (report, code, ticker) => report.issues.find(
  i => i.code === code && i.ticker === ticker);

test('commissions are reserved: cash that only covers 90 shares before fees buys 89 and stays above 10%', () => {
  const result = calc({
    targets: [tgt('NVDA', 90)], cashTarget: 10,
    cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true }
  }, { NVDA: 10 });
  assert.equal(result.out.rows[0].order, 89);
  assert.ok(result.out.fees > 0);
  assert.ok(result.out.cashAfter >= result.out.reserve);
});

test('attained allocation: integer shares, cash >= minimum, no out-of-target positions', () => {
  const result = calc({
    // ¥500 above ¥100,000 covers the ¥445.50 commission on 90 shares.
    targets: [tgt('NVDA', 90)], cashTarget: 10,
    cash: { jpy: 100500, usd: 0, extraJpy: 0, extraIncluded: true }
  }, { NVDA: 10 });
  assert.deepEqual(result.out.errors, []);
  assert.equal(result.out.rows[0].order, 90);
  const report = audit(result);
  assert.equal(report.status, 'achieved');
  assert.equal(report.issues.length, 0);
  assert.ok(report.maxGapPct < 0.1);
  assert.ok(V.audit(report).includes('達成可能（試算）'));
});

test('unregistered holdings make allocation impossible, even if other targets are valid', () => {
  const result = calc({
    positions: [lot('GOOGL', 10)],
    targets: [tgt('NVDA', 90)], cashTarget: 10
  }, { GOOGL: 100, NVDA: 10 });
  assert.deepEqual(result.out.errors, []);
  assert.equal(result.out.rows.find(x => x.ticker === 'GOOGL').order, 0);
  const report = audit(result);
  assert.equal(report.status, 'blocked');
  assert.ok(issue(report, 'unregistered', 'GOOGL'));
  assert.ok(V.audit(report).includes('目標0%で銘柄を追加'));
});

test('PLTR zero sale cap is hard blocker for 30% target', () => {
  const result = calc({
    positions: [lot('PLTR', 20)],
    targets: [tgt('PLTR', 30, { sellCap: 0 }), tgt('NVDA', 60)],
    cashTarget: 10, cash: { jpy: 20000, usd: 0, extraJpy: 0, extraIncluded: true }
  }, { PLTR: 100, NVDA: 10 });
  assert.deepEqual(result.out.errors, []);
  assert.equal(result.out.rows.find(x => x.ticker === 'PLTR').order, 0);
  const report = audit(result);
  assert.equal(report.status, 'blocked');
  assert.ok(issue(report, 'sale-zero', 'PLTR'));
  assert.ok(report.maxGapPct > 0.5);
  assert.equal(V.audit(report).includes('売却上限0株'), true);
});

test('finite sell cap that binds leaves blocked target allocation', () => {
  const result = calc({
    positions: [lot('PLTR', 20)],
    targets: [tgt('PLTR', 30, { sellCap: 3 }), tgt('NVDA', 60)],
    cashTarget: 10, cash: { jpy: 10000, usd: 0, extraJpy: 0, extraIncluded: true }
  }, { PLTR: 100, NVDA: 10 });
  const pltr = result.out.rows.find(x => x.ticker === 'PLTR');
  assert.equal(pltr.order, -3);
  const report = audit(result);
  assert.equal(report.status, 'blocked');
  assert.ok(issue(report, 'sale-cap', 'PLTR'));
});

test('satellite pending yields partial, not a false success', () => {
  const result = calc({
    targets: [tgt('NVDA', 45), tgt('CRDO', 45, { group: 'satellite', wait: true })],
    cashTarget: 10,
    cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true }
  }, { NVDA: 10, CRDO: 5 });
  assert.deepEqual(result.out.errors, []);
  const report = audit(result);
  assert.equal(report.status, 'partial');
  assert.ok(issue(report, 'satellite-wait', 'CRDO'));
  assert.ok(issue(report, 'cash-excess', 'CASH'));
});

test('unaffordable whole-share purchase gives partial and explains integer restriction', () => {
  const result = calc({
    targets: [tgt('NVDA', 90)], cashTarget: 10,
    cash: { jpy: 10000, usd: 0, extraJpy: 0, extraIncluded: true }
  }, { NVDA: 100 });
  const report = audit(result);
  assert.equal(report.status, 'partial');
  assert.ok(issue(report, 'whole-shares', 'NVDA'));
  assert.equal(result.out.rows.find(x => x.ticker === 'NVDA').order, 0);
});

test('positive 0% target that retains shares is blocked and instructs unlocking sale', () => {
  const result = calc({
    positions: [lot('GRRR', 1)],
    targets: [tgt('GRRR', 0, { sellCap: 0 }), tgt('NVDA', 90)],
    cashTarget: 10
  }, { GRRR: 100, NVDA: 10 });
  const report = audit(result);
  assert.equal(report.status, 'blocked');
  assert.ok(issue(report, 'zero-target', 'GRRR'));
});

test('cash target shortfall is never passed even with stock weights approximately aligned', () => {
  const state = D.blank();
  const out = { errors: [], rows: [{ ticker: 'NVDA', t: tgt('NVDA', 90), afterPct: 90,
    afterValue: 90000, afterShares: 9, jpy: 10000, shares: 9, order: 0 }],
    postTotal: 100000, cashAfter: 9000, cashAfterPct: 9 };
  const report = A.assess(out, { ...state, cashTarget: 10 });
  assert.equal(report.status, 'blocked');
  assert.ok(issue(report, 'cash-short', 'CASH'));
});

test('asset reconciliation failure blocks trade plans', () => {
  const state = D.blank();
  const out = { errors: [], rows: [{ ticker: 'NVDA', t: tgt('NVDA', 90), afterPct: 90,
    afterValue: 90000, afterShares: 9, jpy: 10000 }],
    postTotal: 100000, cashAfter: 20000, cashAfterPct: 10 };
  const report = A.assess(out, { ...state, cashTarget: 10 });
  assert.equal(report.status, 'blocked');
  assert.ok(issue(report, 'reconciliation', 'TOTAL'));
});

test('missing lot confirmation or invalid quotes leave an explicit pending verdict', () => {
  const state = D.blank();
  const blocked = R.simulate(state, { quotes: {}, fx: null }, now);
  const report = A.assess(blocked, state);
  assert.equal(report.status, 'pending');
  assert.ok(V.audit(report).includes('計算保留'));
  assert.equal(report.issues.length, 0);
});
