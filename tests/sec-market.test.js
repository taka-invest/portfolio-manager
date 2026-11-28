'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const mod = () => import('file://' + join(__dirname, '..', 'functions/src/sec/market.js'));

test('market params: index symbols allowed, injection and unknown ranges rejected', async () => {
  const { marketParams } = await mod();
  assert.deepEqual(marketParams({ symbol: '^vix', range: '1d', interval: '1d' }), { kind: 'chart', symbol: '^VIX', interval: '1d', range: '1d' });
  assert.equal(marketParams({ kind: 'feargreed' }).kind, 'feargreed');
  assert.deepEqual(marketParams({ symbol: '^GSPC', period1: '1700000000', period2: '1795000000', interval: '1mo' }),
    { kind: 'chart', symbol: '^GSPC', interval: '1mo', period1: 1700000000, period2: 1795000000 });
  for (const bad of [{ symbol: '../x' }, { symbol: 'NVDA', range: '99y' }, { symbol: 'NVDA', interval: '1m' },
    { symbol: 'NVDA', period1: '5', period2: '1' }, { symbol: 'A?B' }, {}]) {
    assert.throws(() => marketParams(bad), /^Error: invalid/, JSON.stringify(bad));
  }
});

test('fearGreed validates score (charts now come from providers.js, see providers.test.js)', async () => {
  const { fearGreed } = await mod();
  const fg = await fearGreed(async () => ({ fear_and_greed: { score: 41.6, rating: 'fear', timestamp: 't' }, other: 1 }));
  assert.equal(fg.fear_and_greed.score, 41.6);
  await assert.rejects(fearGreed(async () => ({ fear_and_greed: { score: 0 - 1 } })), e => e.status === 404);
});
