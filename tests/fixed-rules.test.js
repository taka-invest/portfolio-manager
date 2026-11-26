'use strict';
// The owner's fixed rules: target weights, cash 10%, PLTR >= 30% after any sale,
// order-grade FX for share counts, and the staged (A/B/C) purchase guard.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const R = require('../app/rebalance.js');
const Stage = require('../app/staged-funding.js');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const CLOSE = Date.parse('2026-11-20T21:00:00Z');
const PRICES = { PLTR: 143.49, NVDA: 125.53, AVGO: 304.41, CRDO: 99.86, APP: 348.29, SOFI: 12.48, RKLB: 45.42 };
const lot = (ticker, shares, basis = 12000, id = ticker) => ({
  id, ticker, kind: 'stock', accountType: 'specific', broker: 'Monex', account: '', shares,
  currency: 'JPY', unitCost: basis, costJpy: shares * basis, referenceJpy: null, layer: 1, note: ''
});
const fx = (kind = 'spot', rate = 158.54) => kind === 'reference'
  ? { rate, date: '2026-11-20', kind } : { rate, date: '2026-11-22', at: NOW, kind };
const market = (kind = 'spot') => ({ fx: fx(kind),
  quotes: Object.fromEntries(Object.entries(PRICES).map(([t, usd]) => [t, { usd, at: CLOSE }])) });
const base = (over = {}) => ({ ...D.blank(), confirmed: true,
  positions: [lot('PLTR', 1100, 12357), lot('APP', 120, 50000), lot('SOFI', 600, 1700), lot('RKLB', 100, 9000), lot('NVDA', 25, 22000)],
  cash: { jpy: 250000, usd: 0, extraJpy: 0, extraIncluded: true }, ...over });

test('fixed specification is pinned: 15/10/30/20/5/3/4/3 and cash 10%', () => {
  assert.deepEqual(D.FIXED_WEIGHTS, { NVDA: 15, AVGO: 10, PLTR: 30, APP: 20, SOFI: 5, CRDO: 3, RKLB: 4, SPCX: 3 });
  assert.equal(D.FIXED_CASH, 10);
  assert.equal(D.PLTR_FLOOR, 30);
  const b = D.blank();
  assert.deepEqual(Object.fromEntries(b.targets.map(t => [t.ticker, t.pct])), D.FIXED_WEIGHTS);
  assert.equal(b.cashTarget, 10);
  assert.deepEqual(D.specIssues(b), []);
});

test('edited weights are reported and "restore" keeps per-ticker operating settings', () => {
  const b = D.blank();
  const edited = { ...b, cashTarget: 12,
    targets: [...b.targets.filter(t => t.ticker !== 'CRDO').map(t => t.ticker === 'PLTR' ? { ...t, pct: 20, sellCap: 50 } : t),
      { ticker: 'GOOGL', pct: 5, group: 'satellite', wait: true, sellCap: null }] };
  const issues = D.specIssues(edited);
  assert.ok(issues.some(i => i.startsWith('PLTR')));
  assert.ok(issues.some(i => i.startsWith('CRDO')));
  assert.ok(issues.some(i => i.startsWith('GOOGL')));
  assert.ok(issues.some(i => i.startsWith('現金目標')));
  const fixed = D.fixedTargets(edited.targets);
  assert.deepEqual(D.specIssues({ ...edited, targets: fixed, cashTarget: D.FIXED_CASH }), []);
  assert.equal(fixed.find(t => t.ticker === 'PLTR').sellCap, 50);          // kept
  assert.equal(fixed.find(t => t.ticker === 'GOOGL').pct, 0);              // extra row kept at 0% (for selling)
  assert.ok(fixed.find(t => t.ticker === 'CRDO'));                          // restored
});

test('③ never sells PLTR below 30%, even with an edited weight and no sale cap', () => {
  const s = base({ targets: D.blank().targets.map(t => t.ticker === 'PLTR' ? { ...t, pct: 20, sellCap: null }
    : t.ticker === 'NVDA' ? { ...t, pct: 25 } : t) });
  const out = R.simulate(s, market(), NOW);
  assert.deepEqual(out.errors, []);
  const pltr = out.rows.find(r => r.ticker === 'PLTR');
  assert.ok(pltr.order < 0, 'PLTR is overweight and is sold');
  assert.ok(pltr.afterPct >= 30 - 1e-9, 'PLTR after sale ' + pltr.afterPct);
});

test('③ share counts need order-grade USD/JPY: daily ECB reference is refused, spot/manual accepted', () => {
  const s = base();
  const ref = R.simulate(s, market('reference'), NOW);
  assert.ok(ref.errors.some(e => e.includes('日次ECB参考値では計算しません')));
  assert.deepEqual(ref.rows, []);
  assert.deepEqual(R.simulate(s, market('spot'), NOW).errors, []);
  const manual = { ...market('spot'), fx: { rate: 158.5, at: NOW - 60000, kind: 'manual' } };
  assert.deepEqual(R.simulate(s, manual, NOW).errors, []);
  // ② stays available as a reference with the daily rate.
  assert.deepEqual(R.ideal(s, market('reference'), NOW).errors, []);
});

test('staged plan: the stage is part of the synced plan and validated', () => {
  const s = base();
  const plan = Stage.snapshot(s, NOW);
  assert.equal(plan.stage, 1);
  assert.deepEqual(plan.stageLog, []);
  const stored = D.validate({ ...s, stagedFunding: plan }).stagedFunding;
  assert.deepEqual(stored, plan);
  // A V2.6 plan without a stage starts at A.
  assert.equal(D.validate({ ...s, stagedFunding: { startedAt: plan.startedAt, baselineShares: plan.baselineShares } }).stagedFunding.stage, 1);
  assert.throws(() => D.validate({ ...s, stagedFunding: { ...plan, stage: 4 } }));
  assert.throws(() => D.validate({ ...s, stagedFunding: { ...plan, stage: 1, stageLog: [{ stage: 1, at: plan.startedAt, shares: plan.baselineShares, skipped: false }] } }));
  // calc uses the plan's stage when none is passed.
  const atB = { ...s, stagedFunding: { ...plan, stage: 2, stageLog: [{ stage: 1, at: plan.startedAt, shares: plan.baselineShares, skipped: true }] } };
  assert.equal(Stage.calc(atB, market(), undefined, NOW).stage, 2);
});

test('staged plan refuses edited weights instead of falling back silently', () => {
  const s = base();
  const edited = { ...s, targets: s.targets.filter(t => t.ticker !== 'CRDO'), stagedFunding: Stage.snapshot(s, NOW) };
  const out = Stage.calc(edited, market(), 1, NOW);
  assert.ok(out.errors.some(e => e.startsWith('CRDO')));
  assert.equal(out.rows, undefined);
});

test('advancing without registered fills needs an explicit "not bought"; registered fills advance normally', () => {
  const s = base();
  const started = { ...s, stagedFunding: Stage.snapshot(s, NOW) };
  assert.ok(Stage.advance({ ...started, confirmed: false }, NOW).error);
  const same = Stage.advance(started, NOW);
  assert.equal(same.unchanged, true);
  assert.equal(same.stagedFunding.stage, 2);
  assert.equal(same.stagedFunding.stageLog[0].skipped, true);

  const a = Stage.calc(started, market(), undefined, NOW);
  assert.deepEqual(a.errors, []);
  const bought = { ...started, positions: [...started.positions,
    ...a.rows.filter(r => r.qty > 0).map(r => lot(r.ticker, r.qty, 20000, 'a-' + r.ticker))] };
  const moved = Stage.advance(bought, NOW);
  assert.equal(moved.unchanged, false);
  assert.equal(moved.stagedFunding.stageLog[0].skipped, false);
  assert.ok(D.validate({ ...bought, stagedFunding: moved.stagedFunding }));
  const last = Stage.advance({ ...bought, stagedFunding: { ...moved.stagedFunding, stage: 3,
    stageLog: [...moved.stagedFunding.stageLog, { ...moved.stagedFunding.stageLog[0], stage: 2 }] } }, NOW);
  assert.ok(last.error, 'C is the last stage');
});

test('registered A fills + B never exceed the full target (no double purchase)', () => {
  const s = base();
  const started = { ...s, stagedFunding: Stage.snapshot(s, NOW) };
  const a = Stage.calc(started, market(), undefined, NOW);
  const bought = { ...started, positions: [...started.positions,
    ...a.rows.filter(r => r.qty > 0).map(r => lot(r.ticker, r.qty, 20000, 'a-' + r.ticker))] };
  const atB = { ...bought, stagedFunding: Stage.advance(bought, NOW).stagedFunding };
  const b = Stage.calc(atB, market(), undefined, NOW);
  assert.deepEqual(b.errors, []);
  const full = Stage.calc({ ...started, stagedFunding: { ...started.stagedFunding, stage: 3 } }, market(), undefined, NOW);
  for (const t of Stage.TICKERS) {
    const qa = a.rows.find(r => r.ticker === t).qty, qb = b.rows.find(r => r.ticker === t).qty;
    const qFull = full.rows.find(r => r.ticker === t).maxQty;
    assert.ok(qa + qb <= qFull + 1, `${t}: A ${qa} + B ${qb} <= full ${qFull}`);
  }
});
