'use strict';
// 相場の状態（P0-C）：画面の判定は研究と同じ閾値、見出しは局面数が足りる最も近い比較（合成データ）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/market-regime.js');

const PARAMS = { ma: 3, highWindow: 4, minEpisodes: 5,
  vixBands: [[15, '低'], [20, '通常'], [30, '高'], [null, '極端']], depthBands: [[-0.10, '浅い'], [-0.20, '調整'], [null, '弱気相場']] };

test('classification uses the study thresholds (same boundaries as the Python tests)', () => {
  const s = M.classify([100, 110, 120, 90], 31, PARAMS);
  assert.equal(s.trend, '下落');                       // 90 < mean(110,120,90)
  assert.ok(Math.abs(s.dd - (90 / 120 - 1)) < 1e-12);
  assert.deepEqual([s.vol, s.depth], ['極端', '弱気相場']);
  const vol = v => M.classify([100, 100, 100, 100], v, PARAMS).vol;
  assert.deepEqual([12, 15, 19.9, 20, 29.9, 30].map(vol), ['低', '通常', '通常', '高', '高', '極端']);
  const depth = last => M.classify([100, 100, 100, last], 14, PARAMS).depth;
  // Just inside each boundary (exactly -10%/-20% is decided by float rounding, identically in Python and JS).
  assert.deepEqual([100, 90.01, 89.99, 85, 79.99, 50].map(depth), ['浅い', '浅い', '調整', '調整', '弱気相場', '弱気相場']);
  assert.equal(M.classify([100, 100], 20, PARAMS), null);                 // not enough history: no guess
  // No VIX source: trend and drawdown are still classified, the volatility band stays empty (not guessed).
  const noVix = M.classify([100, 110, 120, 90], null, PARAMS);
  assert.deepEqual([noVix.trend, noVix.vol, noVix.depth, noVix.vix], ['下落', null, '弱気相場', null]);
});

test('without VIX the card uses only trend/drawdown comparisons and says why', () => {
  const r = { ...RESULT, levels: ['trend|vol|depth', 'vol|depth', 'vol', 'trend|depth', 'depth', 'all'], groups: { ...RESULT.groups,
    'trend|depth:下落・調整': { days: 900, episodes: 40, horizons: { 60: cell(40, 0.03, [-0.02, 0.08]) } } } };
  const state = { trend: '下落', vol: null, vix: null, depth: '調整', pxVsMa: -0.07, dd: -0.16 };
  const h = M.html(r, state, '自前API', '60', 'jpy');
  assert.match(h, /VIXの取得元がないため判定なし/);
  assert.doesNotMatch(h, /data-level="vol/);
  assert.doesNotMatch(h, /data-level="trend\|vol/);
  assert.match(h, /<tr data-level="trend\|depth" class="pm-regime-pick">/);
  assert.match(h, /200日線比 -7\.0%/);
});

const cell = (episodes, median, ci) => ({ jpy: { n: 100, episodes, median, mean: median, q05: -0.3, q95: 0.25, positive: 0.6, medianCI95: ci }, usd: null });
const RESULT = {
  version: 'p0c-1', dates: ['1990-12-28', '2026-11-24'], params: PARAMS, levels: ['trend|vol|depth', 'vol|depth', 'vol', 'all'], assumptions: ['合成'],
  current: { date: '2026-11-24', trend: '下落', vol: '高', depth: '調整', vix: 26.4, px: 93, ma: 100, dd: -0.16 },
  groups: {
    'trend|vol|depth:下落・高・調整': { days: 50, episodes: 3, horizons: { 60: cell(3, 0.02, [-0.1, 0.1]) } },
    'vol|depth:高・調整': { days: 400, episodes: 39, horizons: { 60: cell(39, 0.048, [-0.014, 0.12]) } },
    'vol:高': { days: 2500, episodes: 60, horizons: { 60: cell(60, 0.051, [0.007, 0.084]) } },
    'all:全期間': { days: 9000, episodes: 1, horizons: { 60: cell(1, 0.046, null) } }
  }
};

test('headline is the closest comparison with enough episodes; thin cells are marked, baseline has no interval', () => {
  const h = M.html(RESULT, RESULT.current, '研究データの最終日', '60', 'jpy');
  assert.match(h, /<strong>下落トレンド<\/strong>（200日線比 -7\.0%）/);
  assert.match(h, /<tr data-level="vol\|depth" class="pm-regime-pick">/);       // 3 episodes < 5 -> falls back one level
  assert.match(h, /data-level="trend\|vol\|depth"[\s\S]*?少数（参考外）/);
  assert.match(h, /data-level="all"[\s\S]*?\+4\.6%[\s\S]*?<td>—<\/td>/);          // baseline: no interval
  assert.match(h, /売買の推奨ではない/);
  assert.match(M.html(RESULT, RESULT.current, '', '250', 'jpy'), /過去に該当する日がありません/);
});

test('upload script maps each result type to its own document', async () => {
  const { prepare, docId } = await import('../scripts/upload-research.mjs');
  const r = { ...RESULT, computedAt: '2026-11-27T00:00:00+00:00' };
  assert.equal(docId(r), 'market-regime');
  assert.equal(prepare(r).fields.version.stringValue, 'p0c-1');
  assert.throws(() => prepare({ ...r, groups: undefined, current: undefined, version: 'p0c-1', params: {}, dates: [], computedAt: 'x' }).fields, /missing groups|missing current/);
  assert.equal(docId({ version: 'p0b-1' }), 'vix-event-study');
});
