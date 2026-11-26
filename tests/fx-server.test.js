'use strict';
// USD/JPY from the own API (Yahoo JPY=X via /api/market) with the provider's quote time.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/market.js');

const meta = (rate, atSec) => ({ data: { chart: { result: [{ meta: { symbol: 'JPY=X', regularMarketPrice: rate, regularMarketTime: atSec } }] } } });
const noFetch = () => { throw new Error('third-party FX must not be called'); };

test('serverFx parses the own API response into a timestamped spot quote', async () => {
  const at = Math.floor(Date.now() / 1000) - 60;
  const calls = [];
  const fx = await M.serverFx(async (path, opts) => { calls.push(path); return meta(159.05, at); });
  assert.deepEqual(calls, ['/api/market?symbol=JPY%3DX&range=1d&interval=1d']);
  assert.equal(fx.kind, 'spot');
  assert.equal(fx.rate, 159.05);
  assert.equal(fx.at, at * 1000);
  assert.match(fx.source, /自前API/);
  assert.equal(M.fxStatus(fx), 'ready');
});

test('serverFx refuses implausible data, errors and a missing caller (never invents a rate)', async () => {
  const at = Math.floor(Date.now() / 1000);
  assert.equal(await M.serverFx(async () => meta(0, at)), null);
  assert.equal(await M.serverFx(async () => meta(1590.5, at)), null);
  assert.equal(await M.serverFx(async () => meta(159, null)), null);
  assert.equal(await M.serverFx(async () => ({ error: 'login', code: 'login' })), null);
  assert.equal(await M.serverFx(async () => { throw new Error('boom'); }), null);
  assert.equal(await M.serverFx(undefined), null);
});

test('fetchFx prefers a fresh own-API quote and does not touch third-party sources', async () => {
  const fx = await M.fetchFx(noFetch, async () => meta(158.4, Math.floor(Date.now() / 1000) - 30));
  assert.equal(fx.kind, 'spot');
  assert.equal(fx.rate, 158.4);
});

test('a stale own-API quote (e.g. weekend) falls through to the other sources', async () => {
  const hosts = [];
  const fetcher = async url => {
    hosts.push(new URL(url).hostname);
    return { ok: false, status: 503, headers: { get: () => null } };
  };
  const old = Math.floor(Date.now() / 1000) - 3 * 3600;
  const fx = await M.fetchFx(fetcher, async () => meta(158.4, old));
  assert.deepEqual(hosts, ['www.live-rates.com', 'api.exchangerate.fun', 'api.frankfurter.dev']);
  assert.ok(fx.error);
});
