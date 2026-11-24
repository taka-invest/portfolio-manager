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

test('yahooChart returns a trimmed Yahoo-compatible shape with source; fearGreed validates score', async () => {
  const { yahooChart, fearGreed } = await mod();
  let url;
  const out = await yahooChart({ symbol: '^VIX', range: '1d', interval: '1d' }, async u => { url = u; return {
    chart: { result: [{ meta: { symbol: '^VIX', currency: 'USD', regularMarketPrice: 17.2, regularMarketTime: 1795000000, secret: 'x' },
      timestamp: [1], indicators: { quote: [{ close: [17.2], volume: [5] }] } }] } }; });
  assert.equal(url, 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1d&interval=1d');
  assert.equal(out.chart.result[0].meta.regularMarketPrice, 17.2);
  assert.equal(out.chart.result[0].meta.secret, undefined);
  assert.deepEqual(out.chart.result[0].indicators.quote[0], { close: [17.2] });
  assert.match(out.source.provider, /Yahoo/);
  const fg = await fearGreed(async () => ({ fear_and_greed: { score: 41.6, rating: 'fear', timestamp: 't' }, other: 1 }));
  assert.equal(fg.fear_and_greed.score, 41.6);
  await assert.rejects(fearGreed(async () => ({ fear_and_greed: { score: 0 - 1 } })), e => e.status === 404);
});
