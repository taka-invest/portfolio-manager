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

test('research reference line: regime vs baseline, VIX study only in an event or with a staged plan', () => {
  const regime = { state: { trend: '下落', vol: '高', depth: '調整', vix: 26.8, dd: -0.166 }, horizon: '60', pickName: 'トレンド・変動・下落幅がすべて同じ',
    pick: { c: { median: 0.026, medianCI95: [-0.077, 0.13], episodes: 17, q05: -0.363 } }, base: { median: 0.046, q05: -0.175 } };
  const study = { params: { threshold: 30 }, summary: { 120: { events: 30,
    S2: { jpy: { diffVsS1: { mean: -0.007, meanCI95: [-0.022, 0.008] } } }, S3: { jpy: { diffVsS1: { mean: -0.079, meanCI95: [-0.135, -0.012] } } } } } };
  const [line] = G.researchNote(regime, study);
  assert.match(line, /下落トレンド・変動 高（VIX 26\.8）・調整（52週高値から -16\.6%）/);
  assert.match(line, /中央値 \+2\.6%（95%区間 -7\.7%〜\+13\.0%、局面17回）／全期間 \+4\.6% → 普段と差があるとは言えない/);
  assert.match(line, /下位5%は -36\.3%（全期間 -17\.5%）/);
  assert.equal(G.researchNote(regime, study).length, 1);                              // VIX 26.8 < 30, no staged plan
  const staged = G.researchNote(regime, study, { staged: true });
  assert.match(staged[1], /分割と翌日一括の差は平均 -0\.7%（差があるとは言えない）.*VIX<20まで待つのは平均 -7\.9%（不利（差あり））/);
  const inEvent = G.researchNote({ ...regime, state: { ...regime.state, vix: 33.5, vol: '極端' } }, study);
  assert.equal(inEvent.length, 2);
  assert.deepEqual(G.researchNote(null, null), []);                                    // nothing loaded: no line
  const higher = G.researchNote({ ...regime, pick: { c: { ...regime.pick.c, medianCI95: [0.06, 0.2] } } }, null)[0];
  assert.match(higher, /普段より高め/);
});
