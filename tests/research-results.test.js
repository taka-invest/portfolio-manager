'use strict';
// 研究結果の表示と保存スクリプト（合成データ。実際の結果は公開リポジトリに入れない）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../app/research-results.js');

const cell = (median, extra = {}) => ({ median, mean: median, positive: 3, q05: -0.3, min: -0.4, medianMae: -0.07, lagMedian: 1, ...extra });
const diff = (mean, lo, hi, better) => ({ median: mean, mean, better, worse: 5 - better, meanCI95: [lo, hi], medianCI95: [lo, hi] });
const strat = (h) => ({ S1: { firstFill: '2001-01-02', signalFired: true, [h]: { usd: 0.1, jpy: 0.08, mae: -0.05, lag: 1, invested: 1 } },
  S2: { firstFill: '2001-01-02', signalFired: true, [h]: { usd: 0.09, jpy: 0.07 } },
  S3: { firstFill: '2001-05-01', signalFired: false, [h]: { usd: 0, jpy: 0 } },
  S4: { firstFill: '2001-01-20', signalFired: true, [h]: { usd: 0.05, jpy: 0.04 } } });
const FIXTURE = {
  version: 'p0b-1', dates: ['1990-01-02', '2026-11-24'], eventCount: 6, computedAt: '2026-11-27T00:00:00+00:00',
  assumptions: ['約定はシグナル翌営業日の終値（FREDは終値のみ）'],
  summary: { 120: { events: 5,
    S1: { jpy: cell(0.108), usd: cell(0.11) },
    S2: { jpy: cell(0.121, { diffVsS1: diff(-0.007, -0.022, 0.008, 2) }), usd: cell(0.123, { diffVsS1: diff(-0.008, -0.022, 0.007, 2) }) },
    S3: { jpy: cell(0, { diffVsS1: diff(-0.079, -0.135, -0.012, 1) }), usd: cell(0, { diffVsS1: diff(-0.089, -0.152, -0.015, 0) }) },
    S4: { jpy: cell(0.116, { diffVsS1: diff(0.02, 0.005, 0.04, 4) }), usd: cell(0.078, { diffVsS1: diff(-0.02, -0.046, 0.008, 1) }) } } },
  perEvent: [{ t0: '2001-01-01', vix: 31.2, strategies: strat('120') }, { t0: '2026-11-20', vix: 30.4, strategies: { S1: {}, S2: {}, S3: {}, S4: {} } }]
};

test('verdict follows the 95% interval of the difference, never the point estimate', () => {
  assert.equal(R.verdict([-0.135, -0.012]).text, '不利（差あり）');
  assert.equal(R.verdict([0.005, 0.04]).text, '有利（差あり）');
  assert.equal(R.verdict([-0.022, 0.008]).text, '差があるとは言えない');
  assert.equal(R.verdict(null).text, '—');
});

test('table shows counts, intervals, the in-progress episode and the limits', () => {
  const h = R.html(FIXTURE, '120', 'jpy');
  assert.match(h, /局面 6回（この期間を評価できたのは5回）/);
  assert.match(h, /data-strategy="S3"[\s\S]*?-7\.9%[\s\S]*?95%区間 -13\.5%〜-1\.2%[\s\S]*?不利（差あり）/);
  assert.match(h, /data-strategy="S2"[\s\S]*?差があるとは言えない/);
  assert.match(h, /data-strategy="S1"[\s\S]*?基準/);
  assert.match(h, /進行中の局面：2026-11-20（VIX 30\.4）/);
  assert.match(h, /S3の購入日[\s\S]*2001-05-01（期限）/);
  assert.match(h, /多重比較の補正はしていない/);
  assert.match(h, /売買の推奨ではない/);
  assert.match(R.html(FIXTURE, '120', 'usd'), /data-strategy="S4"[\s\S]*?差があるとは言えない/);   // currency switch
  assert.match(R.html(FIXTURE, '60', 'jpy'), /結果がありません/);
});

test('upload script accepts only research results and stores the JSON as one field', async () => {
  const { prepare } = await import('../scripts/upload-research.mjs');
  const body = prepare(FIXTURE.perEvent ? { ...FIXTURE, params: {} } : FIXTURE);
  assert.equal(body.fields.version.stringValue, 'p0b-1');
  assert.equal(body.fields.dataThrough.stringValue, '2026-11-24');
  assert.deepEqual(JSON.parse(body.fields.json.stringValue).summary, JSON.parse(JSON.stringify(FIXTURE.summary)));
  assert.throws(() => prepare({ version: 'p0b-1' }), /missing/);
  assert.throws(() => prepare({ ...FIXTURE, params: {}, version: 'x' }), /unexpected version/);
});
