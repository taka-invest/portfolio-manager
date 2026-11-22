'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/market.js');

test('Finnhub 429 persists Retry-After and blocks immediate retries across callers', async () => {
  const original = globalThis.localStorage;
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
  try {
    let requests = 0;
    const limitedResponse = async () => {
      requests++;
      return { ok: false, status: 429, headers: { get: key => key === 'Retry-After' ? '120' : null } };
    };
    await assert.rejects(M.finnhub('quote', { symbol: 'NVDA' }, 'fixture', limitedResponse), { status: 429 });
    const pause = M.cooldownUntil();
    assert.ok(pause > Date.now() + 119000);
    await assert.rejects(M.finnhub('stock/metric', { symbol: 'SPY' }, 'fixture', limitedResponse), { status: 429 });
    assert.equal(requests, 1, 'global cooldown must prevent the second request');
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});
