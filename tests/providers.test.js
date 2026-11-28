'use strict';
// Plan B data providers (docs/research/DATA_SOURCE_MIGRATION.md): Finnhub quotes, Massive daily bars,
// proxies and "no free source" are explicit, shortened history is flagged, keys never leak.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const P = () => import('../functions/src/sec/providers.js');

const DAY = 86400000;
const NOW = Date.parse('2026-11-27T00:00:00Z');
const bars = (n, start = NOW - n * DAY) => ({ status: 'DELAYED', results: Array.from({ length: n }, (_, i) =>
  ({ t: start + i * DAY, o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i, v: 1000 })) });

test('VIX / VXN / USD-JPY have no free source: a distinct 404, nothing fetched', async () => {
  const { providerChart } = await P();
  let called = 0;
  for (const symbol of ['^VIX', '^VXN', 'JPY=X']) {
    await assert.rejects(providerChart({ symbol, range: '1d', interval: '1d' }, { fetchJson: async () => { called++; }, key: 'k' }),
      e => e.status === 404 && e.code === 'no-source');
  }
  assert.equal(called, 0);
});

test('latest price comes from Finnhub /quote; S&P 500 is the SPY proxy and says so', async () => {
  const { providerChart } = await P();
  const urls = [];
  const out = await providerChart({ symbol: '^GSPC', range: '1d', interval: '1d' }, {
    fetchJson: async u => { urls.push(u); return { c: 650.99, t: 1795813200, pc: 633.93 }; }, key: 'SECRET' });
  assert.match(urls[0], /^https:\/\/finnhub\.io\/api\/v1\/quote\?symbol=SPY&token=/);
  const m = out.chart.result[0].meta;
  assert.equal(m.regularMarketPrice, 650.99);
  assert.equal(m.proxyFor, 'SPY');
  assert.match(m.source, /Finnhub/);
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
});

test('daily bars from Massive; NDX maps to I:NDX; a request beyond 2 years is clamped AND flagged', async () => {
  const { providerChart } = await P();
  const urls = [];
  const fetchJson = async u => { urls.push(u); return bars(500); };
  const out = await providerChart({ symbol: '^NDX', range: '2y', interval: '1d' }, { fetchJson, key: 'SECRET', now: NOW });
  assert.match(urls[0], /^https:\/\/api\.massive\.com\/v2\/aggs\/ticker\/I%3ANDX\/range\/1\/day\/2024-11-27\/2026-11-27\?adjusted=true/);
  assert.equal(out.chart.result[0].indicators.quote[0].close.length, 500);
  assert.equal(out.chart.result[0].meta.truncated, false);
  const long = await providerChart({ symbol: 'NVDA', range: '10y', interval: '1mo' }, { fetchJson, key: 'k', now: NOW });
  assert.match(urls[1], /\/NVDA\/range\/1\/day\/2024-11-27\//);                  // never asks for more than 2 years
  const meta = long.chart.result[0].meta;
  assert.equal(meta.truncated, true);
  assert.equal(meta.historyFrom, '2024-11-27');
  assert.ok(long.chart.result[0].timestamp.length <= 26, 'aggregated to months');
  assert.doesNotMatch(JSON.stringify(long), /SECRET|apiKey/);
});

test('weekly aggregation keeps first open, max high, min low, last close, summed volume', async () => {
  const { aggregate } = await P();
  const mon = Date.parse('2026-11-16T05:00:00Z');
  const week = [0, 1, 2, 3, 4].map(i => ({ t: mon + i * DAY, o: 10 + i, h: 20 + i, l: 5 - i, c: 11 + i, v: 100 }));
  const next = { t: mon + 7 * DAY, o: 50, h: 51, l: 49, c: 50.5, v: 1 };
  const out = aggregate([...week, next], '1wk');
  assert.equal(out.length, 2);
  assert.deepEqual({ o: out[0].o, h: out[0].h, l: out[0].l, c: out[0].c, v: out[0].v }, { o: 10, h: 24, l: 1, c: 15, v: 500 });
});

test('without keys nothing is fetched and the screens get "no source"', async () => {
  const { finnhubQuote, massiveDaily } = await P();
  await assert.rejects(finnhubQuote('NVDA', { key: '' }), e => e.code === 'no-source');
  await assert.rejects(massiveDaily('NVDA', { key: '' }), e => e.code === 'no-source');
});

test('no live server code calls Yahoo any more', () => {
  const dir = join(__dirname, '..', 'functions/src');
  const live = ['index.js', 'sec-gateway.js', ...readdirSync(join(dir, 'sec')).map(f => 'sec/' + f)];
  for (const f of live) {
    const src = readFileSync(join(dir, f), 'utf8');
    if (f === 'sec-gateway.js') continue;                 // keeps a host pattern for the UA rule only
    assert.doesNotMatch(src, /query[12]\.finance\.yahoo\.com/, f);
  }
  const analyze = readFileSync(join(dir, 'legacy/analyze.js'), 'utf8');
  assert.doesNotMatch(analyze.slice(analyze.indexOf('async function getMarketData')), /query[12]\.finance\.yahoo\.com\/v8/);
});
