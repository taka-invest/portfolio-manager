'use strict';
// Removed with the old sites (2026-11-26) and must not come back: the old-URL notice,
// same-origin legacy readers, JSONBin, the unused FMP key and third-party CORS proxies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const read = p => readFileSync(join(root, p), 'utf8');
const files = dir => readdirSync(join(root, dir), { withFileTypes: true }).filter(e => e.isFile()).map(e => dir + '/' + e.name);
const appFiles = ['portfolio_manager.html', ...files('app'), ...files('research')];

test('no third-party CORS proxy, JSONBin or FMP code is shipped', () => {
  for (const f of appFiles) {
    const src = read(f);
    assert.doesNotMatch(src, /allorigins|corsproxy\.io|codetabs/, f);
    assert.doesNotMatch(src, /api\.jsonbin\.io|s-jb-key|cloud-consent/, f);
    assert.doesNotMatch(src, /pm_fmp_key|s-fmp-key/, f);
  }
  assert.equal(existsSync(join(root, 'app/legacy-notice.js')), false);
});

test('old-format JSON files still import (only the old-origin readers were removed)', () => {
  const D = require('../app/data.js');
  const old = [{ id: 'a1', ticker: 'NVDA', layer: 1, buyPrice: 1000, curPrice: 1200, shares: 2, note: '' }];
  const { next } = D.prepare(old, D.blank());
  assert.equal(next.positions.length, 1);
  assert.equal(next.positions[0].kind, 'review');
  assert.equal(next.confirmed, false);
});

test('links inside the embedded research pages open the app route, not a page inside the frame', () => {
  for (const f of ['research/index.html', 'research/screener.html', 'research/library.html']) {
    const links = read(f).match(/<a [^>]*href="(?:\/#|\.\.\/portfolio_manager\.html#|screener\.html|library\.html|index\.html)[^>]*>/g) || [];
    assert.ok(links.length > 0, f);
    for (const a of links) assert.match(a, /target="_top"/, f + ': ' + a);
  }
});
