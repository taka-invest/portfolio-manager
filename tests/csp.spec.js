'use strict';
// Serve the pages with the production Content-Security-Policy from firebase.json
// (the local test server sends no headers) and fail on any CSP violation.
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const D = require('../app/data.js');

const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'firebase.json'), 'utf8'));
const cspFor = path => {
  const rule = cfg.hosting.headers.find(r => r.regex ? new RegExp(r.regex).test(path) && r.headers.some(h => h.key === 'Content-Security-Policy')
    : r.source === '/research/*.html' && path.startsWith('/research/'));
  return rule.headers.find(h => h.key === 'Content-Security-Policy').value;
};
const close = Date.parse('2026-11-20T21:00:00Z') / 1000;

async function serveWithCsp(page) {
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));
    window.PMCloud = { idToken: async () => 'header.payload.sig' };
  });
  await page.addInitScript(({ key, state }) => {
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem('pm_api_key', 'fixture-key');
  }, { key: D.KEY, state: { ...D.blank(), confirmed: true, positions: [{ id: 'p', ticker: 'PLTR', kind: 'stock', broker: 'X', account: '',
    accountType: 'specific', shares: 10, currency: 'USD', unitCost: 10, costJpy: 1000, referenceJpy: null, layer: 1, note: '' }],
    cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true } } });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') {
      if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 200, json: { chart: { result: [{ meta: { regularMarketPrice: 20, regularMarketTime: close } }] }, fear_and_greed: { score: 50 }, rows: [], pool: [] } });
      if (!/\.html$|\/$/.test(u.pathname)) return route.continue();
      const res = await route.fetch();
      return route.fulfill({ response: res, headers: { ...res.headers(), 'content-security-policy': cspFor(u.pathname) } });
    }
    if (u.hostname === 'www.live-rates.com') return route.fulfill({ json: [{ currency: 'USD/JPY', bid: 150, ask: 150, timestamp: Date.parse('2026-11-22T12:00:00Z') }] });
    if (u.hostname === 'finnhub.io') return route.fulfill({ json: u.pathname.endsWith('/quote') ? { c: 100, t: close } : {} });
    if (u.hostname === 'cdn.tailwindcss.com') return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    return route.fulfill({ status: 503, body: '' });
  });
}
const violations = page => page.evaluate(() => window.__csp);

test('main app under the production CSP: no violations on the main views', async ({ page }) => {
  await serveWithCsp(page);
  await page.goto('/portfolio_manager.html#overview');
  await expect(page.locator('#summary-row')).toContainText('USD/JPY');
  for (const hash of ['#today', '#holdings', '#market', '#history', '#companies', '#data-settings'])
    await page.evaluate(h => { location.hash = h; }, hash);
  await page.waitForTimeout(300);
  expect(await violations(page)).toEqual([]);
});

test('research pages under their CSP: self-hosted chart library loads, no violations', async ({ page }) => {
  await serveWithCsp(page);
  for (const p of ['/research/index.html', '/research/screener.html', '/research/library.html']) {
    await page.goto(p);
    await page.waitForLoadState('load');
    if (p.endsWith('index.html')) expect(await page.evaluate(() => typeof LightweightCharts)).toBe('object');
    expect(await violations(page), p).toEqual([]);
  }
});

test('the CSP really blocks an unlisted destination (the check is live)', async ({ page }) => {
  await serveWithCsp(page);
  await page.goto('/portfolio_manager.html#overview');
  await page.evaluate(() => fetch('https://example.invalid/x').catch(() => {}));
  await expect.poll(() => violations(page)).toContainEqual(expect.stringContaining('connect-src'));
});
