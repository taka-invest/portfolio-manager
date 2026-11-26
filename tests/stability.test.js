'use strict';
// Stability and cost guards for the single-instance Functions backend.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const base = join(__dirname, '..');
const importSource = path => import('file://' + join(base, path));

test('gateway cache is capped by response size, not only by entry count', async () => {
  const g = await importSource('functions/src/sec-gateway.js');
  g.clearForTest();
  const MB = 1024 * 1024;
  const big = n => async () => ({ ok: true, text: async () => JSON.stringify({ pad: 'x'.repeat(n) }) });
  try {
    for (let i = 0; i < 12; i++) {
      const v = await g.getJson('https://query1.finance.yahoo.com/v8/finance/chart/BIG' + i, {}, big(6 * MB), async () => {});
      assert.equal(v.pad.length, 6 * MB, 'value is returned parsed');
    }
    assert.ok(g.cacheBytesForTest() <= g.CACHE_LIMITS.MAX_CACHE_BYTES, 'bytes ' + g.cacheBytesForTest());
    assert.ok(g.cacheSizeForTest() < 12, 'older large entries were evicted');
    // The most recent entry is still served from cache.
    let called = 0;
    await g.getJson('https://query1.finance.yahoo.com/v8/finance/chart/BIG11', {}, async () => { called++; return { ok: true, text: async () => '{}' }; }, async () => {});
    assert.equal(called, 0);
    // A single response larger than the cap is still usable (kept alone, evicted next).
    await g.getJson('https://query1.finance.yahoo.com/v8/finance/chart/HUGE', {}, big(45 * MB), async () => {});
    assert.equal(g.cacheSizeForTest(), 1);
  } finally { g.clearForTest(); }
});

test('screener stops starting tickers at its time budget and returns retry rows instead of a 5xx', async () => {
  const S = await importSource('functions/src/sec/screen.js');
  let clock = 0;
  const now = () => clock;
  const fetchJson = async url => {
    clock += 40_000;                          // every upstream call is very slow
    if (url.includes('company_tickers')) return { 0: { ticker: 'AAA', cik_str: 1 }, 1: { ticker: 'BBB', cik_str: 2 }, 2: { ticker: 'CCC', cik_str: 3 } };
    return { entityName: 'x', facts: {} };
  };
  const out = await S.screenTickers(['AAA', 'BBB', 'CCC'], { fetchJson, withPrice: false, now, budgetMs: S.SCREEN_BUDGET_MS });
  assert.equal(out.rows.length, 3);
  assert.equal(out.rows[2].error, S.TIMEOUT_ERROR);
  assert.ok(out.rows.every(r => r.ticker && (r.error || r.signalScore != null)));
  assert.ok(S.SCREEN_BUDGET_MS <= 90_000, 'budget leaves room before the 180s function timeout');
});

test('legacy analyze no longer calls the Yahoo endpoints that need a crumb', () => {
  const src = readFileSync(join(base, 'functions/src/legacy/analyze.js'), 'utf8');
  assert.match(src, /const YAHOO_CRUMB_APIS = false;/);
  assert.match(src, /if \(!YAHOO_CRUMB_APIS\) throw/);
  assert.match(src, /if \(!marketCap && YAHOO_CRUMB_APIS\)/);
});

test('screener page sends one batch at a time to the single-instance backend', () => {
  const html = readFileSync(join(base, 'research/screener.html'), 'utf8');
  assert.match(html, /const MAX_CONCURRENT = 1;/);
  const idx = readFileSync(join(base, 'functions/src/index.js'), 'utf8');
  assert.match(idx, /maxInstances: 1, concurrency: 1/);
});
