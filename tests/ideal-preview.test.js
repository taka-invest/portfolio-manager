'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const R = require('../app/rebalance.js');
const V = require('../app/rebalance-view.js');

const now = Date.parse('2026-11-22T12:00:00Z');
const close = Date.parse('2026-11-20T21:00:00Z');
const quote = usd => ({ usd, at: close });
const target = (ticker, pct, options = {}) => ({
  ticker, pct, group: 'core', sellCap: null, wait: false, ...options
});
const cash = { jpy: 671285, usd: 0, extraJpy: 0, extraIncluded: true };
const unconfirmed = {
  ...D.blank(), confirmed: false, cash,
  positions: [{
    id: 'pltr-1', ticker: 'PLTR', kind: 'stock', shares: 10,
    broker: '', account: '', accountType: 'unknown', layer: 1,
    currency: 'USD', unitCost: 15, costJpy: null, note: ''
  }],
  targets: [target('PLTR', 30), target('NVDA', 60)],
  cashTarget: 10
};
const market = { quotes: { PLTR: quote(100), NVDA: quote(50) },
  fx: { rate: 150, date: '2026-11-20', kind: 'hourly', at: now } };

test('unconfirmed stock and cash create ideal USD/JPY targets and share counts, not trades', () => {
  const ideal = R.ideal(unconfirmed, market, now);
  assert.deepEqual(ideal.errors, []);
  assert.equal(ideal.provisional, true);
  assert.equal(ideal.total, 821285);
  const pltr = ideal.rows.find(r => r.ticker === 'PLTR');
  assert.equal(pltr.target, 821285 * .3);
  assert.equal(pltr.targetUsd, 821285 * .3 / 150);
  assert.equal(pltr.idealWholeShares, Math.floor((821285 * .3) / 15000));
  assert.equal(pltr.shares, 10);
  assert.equal(Object.hasOwn(pltr, 'order'), false);
  assert.match(V.ideal(ideal), /理想株数（整数）/);

  const trades = R.simulate(unconfirmed, market, now);
  assert.match(trades.errors.join(' '), /保有ロットと現金残高の確認/);
  assert.deepEqual(trades.rows, []);
  assert.equal(V.trades(trades), '');
  assert.equal(V.comparison(trades, unconfirmed), '');
});

test('missing nonheld satellite quote only disables its ideal share count', () => {
  const state = {
    ...unconfirmed, targets: [target('PLTR', 30),
      target('NVDA', 60), target('SPCX', 0, { group: 'satellite', wait: true })]
  };
  const preview = R.ideal(state, market, now);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.rows.find(r => r.ticker === 'SPCX').idealWholeShares, null);

  const state2 = { ...state, targets: [
    target('PLTR', 30), target('NVDA', 50), target('SPCX', 10, { group: 'satellite', wait: true })
  ] };
  const preview2 = R.ideal(state2, market, now);
  assert.deepEqual(preview2.errors, []);
  assert.match(preview2.warnings.join(' '), /SPCX/);
  assert.equal(preview2.rows.find(r => r.ticker === 'SPCX').status, 'watch');
  assert.match(V.ideal(preview2), /価格未確認・待機/);
  assert.ok(preview2.rows.find(r => r.ticker === 'SPCX').target > 0);
});

test('stale held quote, invalid FX, and invalid target sum cannot create a misleading ideal result', () => {
  const stale = R.ideal(unconfirmed, { ...market, quotes: {
    ...market.quotes, PLTR: { usd: 100, at: 0 }
  } }, now);
  assert.match(stale.errors.join(' '), /PLTR/);
  assert.equal(V.ideal(stale), '');

  const badFx = R.ideal(unconfirmed, { ...market, fx: null }, now);
  assert.match(badFx.errors.join(' '), /USD\/JPY/);

  const badPct = R.ideal({ ...unconfirmed, cashTarget: 20 }, market, now);
  assert.match(badPct.errors.join(' '), /100%/);
});

test('confirmed trade calculations remain unchanged when preview is generated', () => {
  const state = {
    ...unconfirmed, confirmed: true,
    positions: [{ ...unconfirmed.positions[0],
      broker: 'Broker', account: 'Taxable', accountType: 'specific', costJpy: 100000 }]
  };
  const before = R.simulate(state, market, now);
  const preview = R.ideal(state, market, now);
  const after = R.simulate(state, market, now);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.provisional, false);
  assert.deepEqual(after, before);
  assert.equal(after.errors.length, 0);
});
