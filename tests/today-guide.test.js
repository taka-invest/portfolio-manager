'use strict';
// 「今日やること」: chooses which calculation to follow, keeps the same numbers as
// ③ / the staged plan, orders sells before buys, and blocks on missing preconditions.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const R = require('../app/rebalance.js');
const Stage = require('../app/staged-funding.js');
const G = require('../app/today-guide.js');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const CLOSE = Date.parse('2026-11-20T21:00:00Z');
const PRICES = { PLTR: 143.49, NVDA: 125.53, AVGO: 304.41, CRDO: 99.86, APP: 348.29, SOFI: 12.48, RKLB: 45.42, SPCX: 20 };
const lot = (ticker, shares, basis = 12000, id = ticker) => ({ id, ticker, kind: 'stock', accountType: 'specific', broker: 'Monex',
  account: '', shares, currency: 'JPY', unitCost: basis, costJpy: shares * basis, referenceJpy: null, layer: 1, note: '' });
const market = (kind = 'spot') => ({ fx: kind === 'reference' ? { rate: 158.54, date: '2026-11-20', kind } : { rate: 158.54, date: '2026-11-22', at: NOW, kind },
  quotes: Object.fromEntries(Object.entries(PRICES).map(([t, usd]) => [t, { usd, at: CLOSE }])) });
const base = (over = {}) => ({ ...D.blank(), confirmed: true,
  positions: [lot('PLTR', 1100, 12357), lot('APP', 120, 50000), lot('SOFI', 600, 1700), lot('RKLB', 100, 9000), lot('NVDA', 25, 22000)],
  cash: { jpy: 250000, usd: 0, extraJpy: 0, extraIncluded: true },
  // PLTR may be sold (no sale cap) so ③ has both sells and buys.
  targets: D.blank().targets.map(t => t.ticker === 'PLTR' ? { ...t, sellCap: null } : t), ...over });
const guide = (state, m = market(), extra = {}) => G.plan({ state, market: m, now: NOW,
  result: R.simulate(state, m, NOW), staged: state.stagedFunding ? Stage.calc(state, m, undefined, NOW) : null, ...extra });

test('without a staged plan: ③ orders, sells before buys, same share counts as ③', () => {
  const s = base();
  const g = guide(s);
  assert.equal(g.mode, 'rebalance');
  assert.ok(g.checks.every(c => c.ok));
  const sim = R.simulate(s, market(), NOW);
  const expected = sim.rows.filter(r => r.order).map(r => [r.ticker, Math.abs(r.order), r.order < 0 ? 'sell' : 'buy']);
  assert.deepEqual(g.orders.map(o => [o.ticker, o.shares, o.side]).sort(), expected.sort());
  const firstBuy = g.orders.findIndex(o => o.side === 'buy');
  assert.ok(g.orders.slice(firstBuy).every(o => o.side === 'buy'), 'all sells come first');
  assert.ok(g.notes.some(n => n.includes('買付計画を開始')));
  assert.equal(g.total.tax, sim.tax);
});

test('with a staged plan: follow the staged stage, not ③, with the staged numbers', () => {
  const s0 = base();
  const s = { ...s0, stagedFunding: Stage.snapshot(s0, NOW) };
  const g = guide(s);
  const st = Stage.calc(s, market(), undefined, NOW);
  assert.equal(g.mode, 'staged');
  assert.match(g.title, /A日（累積50%）/);
  assert.deepEqual(g.orders[0], { side: 'sell', ticker: 'PLTR', shares: st.sale.shares, jpy: st.sale.gross, note: g.orders[0].note });
  assert.deepEqual(g.orders.slice(1).map(o => [o.ticker, o.shares]), st.rows.filter(r => r.qty > 0).map(r => [r.ticker, r.qty]));
  assert.ok(g.notes.some(n => n.includes('③の売買案を使いません')));
  assert.ok(g.after.some(a => a.includes('A日の約定を登録済み → B日へ')));
  // At C the last step is ending the plan.
  const atC = { ...s, stagedFunding: { ...s.stagedFunding, stage: 3, stageLog: [
    { stage: 1, at: s.stagedFunding.startedAt, shares: s.stagedFunding.baselineShares, skipped: true },
    { stage: 2, at: s.stagedFunding.startedAt, shares: s.stagedFunding.baselineShares, skipped: true }] } };
  const c = guide(atC);
  assert.match(c.title, /C日（累積100%）/);
  assert.ok(c.after.some(a => a.includes('初期保有の記録をリセット')));
});

test('blocks with the reason when a precondition is missing (no orders shown)', () => {
  const unconfirmed = guide(base({ confirmed: false }));
  assert.equal(unconfirmed.mode, 'blocked');
  assert.deepEqual(unconfirmed.orders, []);
  assert.equal(unconfirmed.checks.find(c => c.key === 'holdings').ok, false);

  const ecb = guide(base(), market('reference'));
  assert.equal(ecb.mode, 'blocked');
  assert.equal(ecb.checks.find(c => c.key === 'fx').ok, false);

  const edited = guide(base({ cashTarget: 12 }));
  assert.equal(edited.mode, 'blocked');
  assert.equal(edited.checks.find(c => c.key === 'spec').ok, false);

  const unsaved = guide(base(), market(), { blockers: ['現金残高の変更を保存してください。'] });
  assert.equal(unsaved.mode, 'blocked');
  assert.deepEqual(unsaved.problems, ['現金残高の変更を保存してください。']);
});

test('summary line for the dashboard', () => {
  const g = guide(base());
  const s = G.summary(g);
  assert.equal(s.warn, false);
  assert.match(s.text, /^③の売買案：/);
  assert.match(s.text, /売 PLTR \d+株/);
  assert.equal(G.summary(guide(base({ confirmed: false }))).warn, true);
});
