'use strict';
// "マシャ式" scoring on corrected data: legacy weights/thresholds preserved, but
// missing inputs are never treated as 0 and loss-makers get no invented margin.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const mod = p => import('file://' + join(__dirname, '..', 'functions/src/sec', p));
const fixture = t => JSON.parse(readFileSync(join(__dirname, 'fixtures/sec', t + '.json'), 'utf8'));

test('cost grade boundaries and sector inference match the legacy engine', async () => {
  const S = await mod('scoring.js');
  assert.deepEqual([0.149, 0.15, 0.199, 0.2, 0.299, 0.3, 0.499, 0.5, 0.699, 0.7].map(x => S.masyaCostGrade(x).level),
    [5, 4, 4, 3, 3, 2, 2, 1, 1, 0]);
  assert.equal(S.masyaCostGrade(null).level, null);
  assert.equal(S.inferSector('NVDA', 0.9), 'semiconductor');
  assert.equal(S.inferSector('PLTR', null), 'software');
  assert.equal(S.inferSector('ZZZZ', 0.4), 'internet');
});

test('missing revenue growth earns nothing (legacy added +5 as "普通成長") and is reported', async () => {
  const S = await mod('scoring.js');
  const core = { revGrowth: null, costGrade: S.masyaCostGrade(0.1), isCashRich: true, bsOk: true, opMarginTtm: 30, missing: ['TTM売上成長率'] };
  const ms = S.masyaScore(core);
  assert.equal(ms.score, 50 + 15 + 5 + 5);
  assert.equal(ms.complete, false);
  const j = S.investmentJudgment(core, { reason: '株価未取得' });
  assert.equal(j.bullScore, 20 + 10);
  assert.ok(j.signals.some(s => s.type === 'missing' && s.text.includes('売上成長率')));
  assert.equal(j.complete, false);
});

test('judgment thresholds are unchanged', async () => {
  const S = await mod('scoring.js');
  const base = { costGrade: S.masyaCostGrade(0.1), isCashRich: true, bsOk: true, opMarginTtm: 40, missing: [] };
  const strong = S.investmentJudgment({ ...base, revGrowth: 60 }, { returnMultiple: 6 });
  assert.equal(strong.bullScore, 25 + 20 + 10 + 20);
  assert.equal(strong.judgment, '強い買い');
  const weak = S.investmentJudgment({ ...base, revGrowth: -5, costGrade: S.masyaCostGrade(0.6), isCashRich: false }, { returnMultiple: 0.5 });
  assert.equal(weak.bearScore, 15 + 10 + 5 + 15);
  assert.equal(weak.judgment, '売り');
});

test('10-year model refuses to assume a target margin for loss-making companies', async () => {
  const S = await mod('scoring.js');
  const fin = { annual: [{ end: '2023-12-31', revenue: 100, accn: 'a' }, { end: '2024-12-31', revenue: 150, accn: 'b' }],
    latest: { operatingMarginTtmPct: -12 }, restatedRevenueEnds: [] };
  const m = S.tenYearModel(fin, { sector: 'software', price: 10, shares: { val: 1e8, basis: 'test' } });
  assert.equal(m.prices, null);
  assert.match(m.reason, /赤字/);
});

test('real data: PLTR / APP / NVDA evaluations are complete, sourced and flag their assumptions', async () => {
  const F = await mod('financials.js'), S = await mod('scoring.js');
  const ev = t => S.evaluate(F.analyzeFacts(fixture(t)), { ticker: t, price: null });
  const pltr = ev('PLTR');
  assert.equal(pltr.masyaScore.complete, true);
  assert.equal(pltr.masyaScore.score, 85);
  assert.match(pltr.tenYear.assumptions.cagrBasis, /^直近3年/);
  assert.equal(pltr.exit.exitLabel, '継続保有');

  const app = ev('APP');
  assert.match(app.tenYear.assumptions.cagrBasis, /修正再表示あり/); // 2022 is on the pre-divestiture basis
  assert.equal(app.tenYear.assumptions.historicalCagrPct, 72.5);    // 5480.7 / 1841.8 over 2 years

  const nvda = ev('NVDA');
  assert.ok(nvda.tenYear.warnings.some(w => w.includes('兆ドル')));
  assert.equal(nvda.tenYear.returnMultiple, null);                   // no price supplied -> no return claim
  assert.ok(nvda.judgment.signals.some(s => s.type === 'missing' && s.text.includes('期待リターン')));
});

test('exit signals use date-matched YoY and count consecutive deceleration', async () => {
  const S = await mod('scoring.js');
  const q = (yoy, m = 30) => ({ revenueYoYPct: yoy, operatingMarginPct: m, operatingLeverageQ: 1.2, costRatioPct: 20, ruleOf40Legacy: yoy + m });
  const decel = S.exitSignals([q(80), q(70), q(60), q(50), q(40)]); // oldest -> newest
  assert.equal(decel.decelCount, 4);
  assert.ok(decel.exitScore >= 30);
  const accel = S.exitSignals([q(10), q(20), q(30), q(40)]);
  assert.equal(accel.decelCount, 0);
  assert.equal(accel.exitLabel, '継続保有');
});

test('PER / PSR: standard definitions on real data; never from missing or negative EPS', async () => {
  const F = await mod('financials.js'), S = await mod('scoring.js');
  const fin = F.analyzeFacts(fixture('NVDA'));
  const m = S.valuationMultiples(fin, 165.05);
  assert.equal(fin.latest.epsDilutedTtm > 0, true);
  assert.equal(m.perTtm, Math.round(165.05 / fin.latest.epsDilutedTtm * 10) / 10);
  assert.ok(m.psrTtm > 0);
  assert.match(m.definitions.per, /TTM希薄化後EPS/);
  assert.equal(S.valuationMultiples(fin, null).perTtm, null);
  assert.equal(S.valuationMultiples(fin, null).perNote, '株価未取得');
  const loss = { latest: { epsDilutedTtm: -0.5, revenueTtm: 1e9 }, shares: { val: 1e8 } };
  const lm = S.valuationMultiples(loss, 10);
  assert.equal(lm.perTtm, null);
  assert.equal(lm.perNote, '赤字のため算出不可');
  assert.equal(lm.psrTtm, 1);  // 10 × 1e8 / 1e9
});
