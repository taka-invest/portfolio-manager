'use strict';
// The Portfolio Manager embeds research/*.html in iframes, so those pages must allow
// same-origin framing while the main app stays non-embeddable (production regression:
// "Refused to display ... X-Frame-Options 'deny'").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const toRe = glob => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\//g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '(?:.*/)?') + '$');

function headersFor(cfg, path) {
  const out = {};
  for (const rule of cfg.hosting.headers) {
    const re = rule.regex ? new RegExp(rule.regex) : toRe(rule.source);
    if (!re.test(path)) continue;
    for (const h of rule.headers) {
      const k = h.key.toLowerCase();
      assert.ok(!(k in out), `${path}: ${h.key} set by more than one rule`);
      out[k] = h.value;
    }
  }
  return out;
}

for (const file of ['firebase.json', 'firebase.emulator.json']) {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', file), 'utf8'));
  test(`${file}: research pages embeddable same-origin only`, () => {
    for (const p of ['/research/index.html', '/research/screener.html', '/research/library.html']) {
      const h = headersFor(cfg, p);
      assert.equal(h['x-frame-options'], 'SAMEORIGIN', p);
      assert.match(h['content-security-policy'], /frame-ancestors 'self'/, p);
      assert.match(h['cache-control'], /no-store/, p);
    }
  });
  test(`${file}: main app stays non-embeddable`, () => {
    for (const p of ['/', '/portfolio_manager.html']) {
      const h = headersFor(cfg, p);
      assert.equal(h['x-frame-options'], 'DENY', p);
      assert.match(h['cache-control'], /no-store/, p);   // "/" was cached for an hour
      assert.equal(h['x-content-type-options'], 'nosniff', p);
    }
  });
}
