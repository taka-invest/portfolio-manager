'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../app/volatility.js');

const sample = { version: 1, status: 'ok', VIX: 35.89, VXN: 44.2,
  asOf: '2026-11-20T21:00:00Z', source: 'Licensed provider' };

test('valid VIX/VXN snapshot and plausible bounds', () => {
  assert.equal(V.validate(sample).VIX, 35.89);
  assert.throws(() => V.validate({ ...sample, VIX: -1 }));
  assert.throws(() => V.validate({ ...sample, asOf: 'invalid' }));
  assert.throws(() => V.validate({ ...sample, source: '' }));
});
test('market-session freshness excludes stale VIX after Monday open', () => {
  const saved = V.validate(sample);
  assert.equal(V.isFresh(saved, Date.parse('2026-11-22T12:00:00Z')), true);
  assert.equal(V.isFresh(saved, Date.parse('2026-11-23T16:00:00Z')), false);
});
test('only same-origin feed URLs accepted', () => {
  assert.equal(V.localFeedUrl('./market-data/volatility.json', 'https://example.com/portfolio_manager.html'),
    'https://example.com/market-data/volatility.json');
  assert.throws(() => V.localFeedUrl('https://corsproxy.io/?url=x', 'https://example.com/portfolio_manager.html'));
  assert.equal(V.localFeedUrl('', 'https://example.com/portfolio_manager.html'), null);
});
