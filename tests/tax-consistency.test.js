'use strict';
// ③ and the staged PLTR plan use ONE tax rule (Rebalance.capitalGainsTax):
// gain net of the sell commission, netting per the 損益通算 setting, rounded up.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const R = require('../app/rebalance.js');
const Stage = require('../app/staged-funding.js');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const CLOSE = Date.parse('2026-11-20T21:00:00Z');
const RATE = 158.54;
const PRICES = { PLTR: 143.49, NVDA: 125.53, AVGO: 304.41, CRDO: 99.86, APP: 348.29, SOFI: 12.48, RKLB: 45.42, SPCX: 20 };
const lot = (ticker, shares, basis, id = ticker, account = '') => ({ id, ticker, kind: 'stock', accountType: 'specific', broker: 'Monex',
  account, shares, currency: 'JPY', unitCost: basis, costJpy: shares * basis, referenceJpy: null, layer: 1, note: '' });
const market = { fx: { rate: RATE, date: '2026-11-22', at: NOW, kind: 'spot' },
  quotes: Object.fromEntries(Object.entries(PRICES).map(([t, usd]) => [t, { usd, at: CLOSE }])) };
const fee = usd => Math.min(22, usd * 0.00495) * RATE;
// The rule written out by hand: one order per account, commission deducted, per-account rounding up.
const byHand = (orders, rate = 20.315) => orders.reduce((sum, [shares, basis]) => {
  const gain = shares * (PRICES.PLTR * RATE - basis) - fee(shares * PLTR_USD());
  return sum + Math.ceil(Math.max(0, gain) * rate / 100);
}, 0);
const PLTR_USD = () => PRICES.PLTR;

test('staged PLTR sale tax follows the shared rule (commission deducted, per account)', () => {
  const base = { ...D.blank(), confirmed: true, cash: { jpy: 250000, usd: 0, extraJpy: 0, extraIncluded: true },
    positions: [lot('PLTR', 1100, 12357), lot('APP', 120, 50000), lot('SOFI', 600, 1700), lot('RKLB', 100, 9000), lot('NVDA', 25, 22000)] };
  const s = { ...base, stagedFunding: Stage.snapshot(base, NOW) };
  const out = Stage.calc(s, market, undefined, NOW);
  assert.deepEqual(out.errors, []);
  assert.ok(out.sale.shares > 0);
  assert.equal(out.sale.tax, byHand([[out.sale.shares, 12357]]));
  assert.ok(Math.abs(out.sale.fee - fee(out.sale.shares * PRICES.PLTR)) < 1e-6);
});

test('③ PLTR sale tax follows the same rule, so both screens agree for the same sale', () => {
  const s = { ...D.blank(), confirmed: true, cash: { jpy: 250000, usd: 0, extraJpy: 0, extraIncluded: true },
    positions: [lot('PLTR', 1100, 12357), lot('NVDA', 25, 22000)],
    targets: D.blank().targets.map(t => t.ticker === 'PLTR' ? { ...t, sellCap: null } : t) };
  const out = R.simulate(s, market, NOW);
  assert.deepEqual(out.errors, []);
  const sold = out.sales.filter(x => x.ticker === 'PLTR').reduce((n, x) => n + x.shares, 0);
  assert.ok(sold > 0);
  assert.equal(out.tax, byHand([[sold, 12357]]));
});

test('two PLTR accounts, one at a loss: "none"/"account" tax only the gain, "eligible" nets them — in both calculations', () => {
  const positions = [lot('PLTR', 600, 5000, 'p1', 'A'), lot('PLTR', 600, 40000, 'p2', 'B'), lot('NVDA', 25, 22000)];
  const run = offset => {
    const base = { ...D.blank(), confirmed: true, cash: { jpy: 250000, usd: 0, extraJpy: 0, extraIncluded: true }, positions, tax: { rate: 20.315, offset } };
    return Stage.calc({ ...base, stagedFunding: Stage.snapshot(base, NOW) }, market, undefined, NOW).sale;
  };
  const none = run('none'), account = run('account'), eligible = run('eligible');
  assert.equal(none.tax, account.tax);
  assert.ok(eligible.tax <= none.tax);
  // The same orders through the shared function directly give the same numbers.
  for (const [mode, got] of [['none', none], ['eligible', eligible]]) {
    const q = got.shares;
    const a = Math.min(q, 600), b = q - a;
    const orders = [{ account: 'A', ticker: 'PLTR', taxable: true, gain: a * (PRICES.PLTR * RATE - 5000) - fee(a * PRICES.PLTR) },
      ...(b ? [{ account: 'B', ticker: 'PLTR', taxable: true, gain: b * (PRICES.PLTR * RATE - 40000) - fee(b * PRICES.PLTR) }] : [])];
    assert.equal(got.tax, R.capitalGainsTax(orders, 20.315, mode), mode);
  }
});
