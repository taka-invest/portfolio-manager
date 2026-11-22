'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const M = require('../app/market.js');
const R = require('../app/rebalance.js');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const CLOSE = Date.parse('2026-11-20T21:00:00Z');
const lot = (ticker, id = ticker, fields = {}) => ({
  ticker, id, kind: 'stock', accountType: 'specific', broker: 'Broker', account: 'Account',
  shares: 10, currency: 'USD', unitCost: 10, costJpy: 10000, referenceJpy: null, layer: 1, note: '', ...fields
});
const target = (ticker, pct, fields = {}) => ({ ticker, pct, group: 'core', wait: false, sellCap: null, ...fields });
const quote = (usd, at = CLOSE) => ({ usd, at });
const fx = (rate = 100, date = '2026-11-20') => ({ rate, date });
const cash = (jpy = 0, usd = 0, extraJpy = 0, extraIncluded = true) => ({ jpy, usd, extraJpy, extraIncluded });
const build = (fields = {}) => ({ ...D.blank(), confirmed: true, ...fields });
const old = (ticker, shares, buyPrice) => ({ id: ticker, ticker, layer: 1, shares, buyPrice, curPrice: 11111, note: 'legacy' });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('empty startup and legacy samples never authorize trades', () => {
  const start = D.blank();
  assert.equal(start.positions.length, 0);
  assert.equal(start.targets.reduce((s, t) => s + t.pct, start.cashTarget), 100);
  assert.equal(start.targets.find(t => t.ticker === 'PLTR').sellCap, 0);
  assert.equal(start.targets.filter(t => t.group === 'satellite' && t.wait).length, 3);
  const { next, samples } = D.prepare([old('PLTR', 1021, 1500), old('APP', 15, 6000), old('CRWV', 50, 6000)]);
  assert.equal(samples, 3);
  assert.deepEqual(next.positions, []);
  assert.equal(next.confirmed, false);
  assert.deepEqual(R.simulate(start, { quotes: {}, fx: fx() }, NOW).rows, []);
});

test('legacy migration keeps old data, purchase plan and trade history; import requires reconfirmation', () => {
  const original = old('NVDA', 4.5, 123.4);
  const trades = [{ id: 'trade1', ticker: 'NVDA', action: 'buy', shares: 1, priceJpy: 200, totalJpy: 200,
    note: '<取引メモ>', date: '2026-11-20T15:00:00Z', market: { fg: 30 } }];
  const plans = [{ id: 'plan1', ticker: 'NVDA', layer: 1, targetPct: 10, note: '計画', completed: false,
    createdAt: '2026-11-20T15:00:00Z',
    tranches: [{ stage: 1, allocPct: 100, trigger: '', executed: false, executedAt: null, executedShares: null, executedPriceJpy: null }] }];
  const payload = { positions: [original], plans, trades, preferences: { theme: 'light' } };
  const before = JSON.stringify(payload);
  const { next } = D.prepare(payload);
  assert.equal(JSON.stringify(payload), before);
  assert.equal(next.positions[0].kind, 'review');
  near(next.positions[0].costJpy, 555.3);
  assert.equal(next.positions[0].referenceJpy, 11111);
  assert.deepEqual(next.plans, plans);
  assert.deepEqual(next.trades, trades);
  assert.equal(next.preferences.theme, 'light');
  assert.equal(D.prepare(build()).next.confirmed, false);
  assert.throws(() => D.prepare({ positions: [{ ...original, shares: 'invalid' }] }));
  assert.throws(() => D.prepare({ positions: [original, original] }));
  assert.throws(() => D.prepare({ version: 999, positions: [] }));
  assert.deepEqual(D.prepare({ plans }, build({ positions: [lot('NVDA')] })).next.positions, [lot('NVDA')]);
});

test('backups validate child records and only store supported fields', () => {
  const clean = D.validate({ ...D.blank(), credentials: { test: true }, preferences: { customKey: 'test' }, positions: [lot('NVDA')] });
  assert.equal(clean.credentials, undefined);
  assert.equal(clean.preferences.customKey, undefined);
  assert.throws(() => D.validate(build({ confirmed: false, targets: [target('NVDA', 50), target('NVDA', 50)] })));
  assert.throws(() => D.validate(build({ positions: [lot('NVDA', 'demo', { kind: 'review' })] })));
});

test('multiple brokerage lots aggregate; tsumitate funds and other assets are excluded and NISA stock remains', () => {
  const positions = [lot('NVDA'), lot('NVDA', 'broker2', { shares: 3, broker: 'Broker 2', accountType: 'nisa', costJpy: 3000 }),
    lot('NVDA', 'fund', { kind: 'fund', accountType: 'nisa', shares: 10000 }),
    lot('OTHER', 'other', { kind: 'excluded', shares: 20000 })];
  const out = R.simulate(build({ positions, targets: [target('NVDA', 80)], cashTarget: 20,
    cash: cash(6000, 12, 4000) }), { quotes: { NVDA: quote(20) }, fx: fx() }, NOW);
  assert.equal(out.errors.length, 0);
  assert.equal(out.assets.length, 1);
  assert.equal(out.assets[0].shares, 13);
  assert.equal(out.assets[0].lots.length, 2);
  assert.equal(out.assets[0].costJpy, 13000);
  assert.equal(out.equity, 26000);
  assert.equal(out.cash, 7200);
  assert.equal(out.total, 33200);
});

test('prices and FX revalue assets without changing stored basis or shares', () => {
  const state = build({ positions: [lot('NVDA')], targets: [target('NVDA', 90)], cash: cash(0, 5, 500, false) });
  const snapshot = JSON.stringify(state);
  const first = R.simulate(state, { quotes: { NVDA: quote(10) }, fx: fx(100) }, NOW);
  const next = R.simulate(state, { quotes: { NVDA: quote(15) }, fx: fx(150) }, NOW);
  assert.equal(first.equity, 10000);
  assert.equal(next.equity, 22500);
  assert.equal(next.cash, 1250);
  assert.equal(next.assets[0].costJpy, 10000);
  assert.equal(next.assets[0].shares, 10);
  assert.equal(JSON.stringify(state), snapshot);
});

test('missing, stale and failed quote or FX conditions withhold all orders and CSV', () => {
  const state = build({ positions: [lot('NVDA')], targets: [target('NVDA', 50), target('APP', 40)], cash: cash(6000) });
  const valid = { NVDA: quote(20), APP: quote(30) };
  for (const market of [
    { quotes: {}, fx: fx() }, { quotes: { NVDA: quote(20) }, fx: fx() },
    { quotes: { ...valid, NVDA: { ...valid.NVDA, error: 'failed' } }, fx: fx() },
    { quotes: { ...valid, NVDA: quote(20, CLOSE - 86400000) }, fx: fx() },
    { quotes: valid, fx: { ...fx(), error: 'failed' } }, { quotes: valid, fx: fx(100, '2026-11-19') },
    { quotes: valid, fx: null }
  ]) {
    const out = R.simulate(state, market, NOW);
    assert.ok(out.errors.length);
    assert.deepEqual(out.rows, []);
    assert.throws(() => R.csv(out));
  }
});

test('last regular close survives weekend and holiday, but open-market and stale closes are checked', () => {
  assert.equal(M.quoteStatus(quote(20), NOW), 'ready');
  assert.equal(M.fxStatus(fx(), NOW), 'ready');
  const holiday = Date.parse('2026-11-26T16:00:00Z');
  const wednesdayClose = Date.parse('2026-11-25T21:00:00Z');
  const fridayEarly = Date.parse('2026-11-27T18:00:00Z');
  assert.equal(M.usClosed('2026-11-26'), true);
  assert.equal(M.quoteStatus(quote(20, wednesdayClose), holiday), 'ready');
  assert.equal(M.quoteStatus(quote(20, wednesdayClose), fridayEarly), 'stale');
  assert.equal(M.quoteStatus(quote(20, fridayEarly), Date.parse('2026-11-28T18:00:00Z')), 'ready');
  assert.equal(M.quoteStatus(quote(20, CLOSE - 4 * 60 * 60000), NOW), 'stale');
  assert.equal(M.quoteStatus(quote(20, Date.parse('2026-11-23T14:34:00Z')), Date.parse('2026-11-23T14:35:00Z')), 'ready');
  assert.equal(M.ecbClosed('2026-04-06'), true);
});

test('PLTR cap is honored and satellite can explicitly wait, including unverified SPCX', () => {
  const state = build({
    positions: [lot('PLTR', 'pltr', { shares: 100 })], cash: cash(100000), cashTarget: 10,
    targets: [target('PLTR', 30, { sellCap: 2 }), target('APP', 45), target('CRDO', 10, { group: 'satellite', wait: true }),
      target('SPCX', 5, { group: 'satellite', wait: false })]
  });
  const out = R.simulate(state, { quotes: { PLTR: quote(20), APP: quote(10), CRDO: quote(5), SPCX: { error: 'unverified' } }, fx: fx() }, NOW);
  assert.equal(out.errors.length, 0);
  assert.equal(out.rows.find(r => r.ticker === 'PLTR').order, -2);
  assert.equal(out.rows.find(r => r.ticker === 'CRDO').status, 'wait');
  assert.equal(out.rows.find(r => r.ticker === 'CRDO').order, 0);
  assert.equal(out.rows.find(r => r.ticker === 'SPCX').status, 'watch');
  assert.equal(out.rows.find(r => r.ticker === 'SPCX').targetShares, null);
});

test('a held SPCX without verified price blocks total valuation and orders', () => {
  const out = R.simulate(build({ positions: [lot('SPCX')], targets: [target('SPCX', 90)] }),
    { quotes: { SPCX: { error: 'unverified' } }, fx: fx() }, NOW);
  assert.equal(out.total, null);
  assert.match(out.errors.join(' '), /SPCX/);
});

test('estimated taxes, eligible offsets, currency balances and post-trade positions reconcile', () => {
  const positions = [
    lot('GAIN', 'g1', { shares: 5, costJpy: 1000 }),
    lot('GAIN', 'g2', { shares: 5, costJpy: 3000 }),
    lot('LOSS', 'l1', { account: 'Other', costJpy: 14000 }),
    lot('NISA', 'n1', { accountType: 'nisa', costJpy: 100000 })
  ];
  const fields = { positions, targets: [target('GAIN', 0), target('LOSS', 0), target('NISA', 0), target('BUY', 80)],
    cashTarget: 20, cash: cash(500, 500) };
  const market = { quotes: { GAIN: quote(20), LOSS: quote(10), NISA: quote(5), BUY: quote(11) }, fx: fx() };
  const run = offset => R.simulate(build({ ...fields, tax: { rate: 20, offset } }), market, NOW);
  const out = run('eligible');
  assert.equal(out.errors.length, 0);
  assert.equal(out.tax, 2400);
  assert.equal(out.withoutOffset, 3200);
  assert.equal(run('none').tax, 3200);
  assert.equal(run('account').tax, 3200);
  assert.equal(out.sales.filter(s => s.ticker === 'GAIN').length, 2);
  assert.equal(out.sales.find(s => s.ticker === 'NISA').tax, 0);
  near(out.rows.reduce((s, r) => s + r.afterValue, out.cashAfter), out.postTotal);
  near(out.rows.reduce((s, r) => s + r.afterPct, out.cashAfterPct), 100);
  near(out.cashAfterJpy + out.cashAfterUsd * out.fx.rate, out.cashAfter);
  near(out.cash + out.sales.reduce((s, sale) => s + sale.jpy, 0) - out.tax -
    out.rows.filter(r => r.order > 0).reduce((s, row) => s + row.tradeJpy, 0), out.cashAfter);
  assert.ok(out.cashAfter >= out.reserve);
});

test('buys fit unreserved cash and do not implicitly sell unknown lots', () => {
  const state = build({ positions: [lot('LEFT', 's', { shares: 100, costJpy: null })],
    targets: [target('BUY', 90), target('LEFT', 0)], cashTarget: 10, cash: cash(5000) });
  const out = R.simulate(state, { quotes: { LEFT: quote(10), BUY: quote(11) }, fx: fx() }, NOW);
  assert.equal(out.rows.find(r => r.ticker === 'BUY').order, 0);
  assert.equal(out.rows.find(r => r.ticker === 'LEFT').order, 0);
  assert.equal(out.cashAfter, 5000);
  const bad = R.simulate({ ...state, cashTarget: 12 }, { quotes: { LEFT: quote(10), BUY: quote(11) }, fx: fx() }, NOW);
  assert.match(bad.errors[0], /100%/);
  const cashOnly = R.simulate(build({ targets: [target('NVDA', 50), target('APP', 40)], cash: cash(10000, 0, 5000) }),
    { quotes: { NVDA: quote(30), APP: quote(25) }, fx: fx() }, NOW);
  assert.ok(cashOnly.cashAfter >= cashOnly.reserve);
});

test('CSV contains both currencies, shares, tax, allocation and FX date', () => {
  const out = R.simulate(build({ targets: [target('NVDA', 90)], cash: cash(10000) }),
    { quotes: { NVDA: quote(10) }, fx: fx() }, NOW);
  const csv = R.csv(out);
  for (const value of ['NVDA', '現在株数', '目標株数', '売買株数', '売買額（円）', '売買額（ドル）',
    '概算税', '売買後比率', '税引き後', '2026-11-20']) assert.ok(csv.includes(value), value);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  assert.equal(csv.split('\r\n').length, 3);
});

test('Finnhub checks issuer identity, does not request an unverified symbol and stops on API rate-limit', async () => {
  const calls = [];
  const fake = async (value, options) => {
    const url = new URL(value);
    calls.push([url.pathname, url.searchParams.get('symbol')]);
    assert.equal(options.referrerPolicy, 'no-referrer');
    if (url.pathname.endsWith('profile2')) return { ok: true, json: async () => ({ ticker: 'SPCX', name: 'Unrelated ETF' }) };
    return { ok: false, status: 429, headers: { get: () => '120' } };
  };
  const out = await M.fetchQuotes(['SPCX', 'APP', 'NVDA'], 'fixture', fake);
  assert.equal(out.quotes.SPCX.error, 'unverified');
  assert.equal(out.quotes.APP.error, 'limited');
  assert.equal(out.quotes.NVDA.error, 'limited');
  assert.equal(out.retryMs, 120000);
  assert.deepEqual(calls, [['/api/v1/stock/profile2', 'SPCX'], ['/api/v1/quote', 'APP']]);
  const issuer = await M.fetchQuotes(['SPCX'], 'fixture', async url => ({
    ok: true, json: async () => url.includes('profile2')
      ? { ticker: 'SPCX', name: 'Space Exploration Technologies Corp.', currency: 'USD', exchange: 'NASDAQ' }
      : { c: 10, t: CLOSE / 1000 }
  }));
  assert.equal(issuer.spaceX, true);
  assert.equal(issuer.quotes.SPCX.usd, 10);
});
