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

for (const file of ['firebase.json', 'firebase.emulator.json']) {
  const cfg = JSON.parse(readFileSync(join(__dirname, '..', file), 'utf8'));
  const directives = csp => Object.fromEntries(csp.split(';').map(s => s.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  test(`${file}: Content-Security-Policy restricts where scripts load and data can go`, () => {
    for (const p of ['/', '/portfolio_manager.html', '/research/index.html', '/research/screener.html', '/research/library.html']) {
      const h = headersFor(cfg, p);
      const d = directives(h['content-security-policy']);
      assert.deepEqual(d['default-src'], ["'self'"], p);
      assert.deepEqual(d['object-src'], ["'none'"], p);
      assert.deepEqual(d['base-uri'], ["'self'"], p);
      assert.ok(!d['script-src'].includes("'unsafe-eval'"), p);
      assert.ok(!d['script-src'].some(s => s === '*' || s === 'https:'), p + ': no wildcard script source');
      assert.ok(!d['connect-src'].some(s => s === '*' || s === 'https:'), p + ': no wildcard connect source');
      assert.ok(!d['script-src'].includes('https://unpkg.com'), p + ': chart library is self-hosted');
      assert.match(h['permissions-policy'], /camera=\(\)/, p);
    }
    const main = directives(headersFor(cfg, '/')['content-security-policy']);
    assert.deepEqual(main['frame-ancestors'], ["'none'"]);
    for (const host of ['https://finnhub.io', 'https://www.live-rates.com', 'https://firestore.googleapis.com', 'https://securetoken.googleapis.com'])
      assert.ok(main['connect-src'].includes(host), host);
    const research = directives(headersFor(cfg, '/research/index.html')['content-security-policy']);
    assert.deepEqual(research['frame-ancestors'], ["'self'"]);
    assert.ok(!research['connect-src'].includes('https://finnhub.io'), 'research pages only talk to the own API');
  });
}
