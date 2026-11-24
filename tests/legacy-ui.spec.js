'use strict';
// The unmodified legacy Stock Analyzer pages run on Firebase through app/legacy-shim.js.
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const fx = f => readFileSync(join(__dirname, 'fixtures', f), 'utf8');
const lw = () => readFileSync(join(__dirname, '..', 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'));

async function setup(page, { token = true } = {}) {
  if (token) await page.addInitScript(() => { window.PMCloud = { idToken: async () => 'header.payload.sig' }; });
  const calls = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      calls.push({ path: url.pathname + url.search, auth: route.request().headers().authorization });
      if (url.pathname === '/api/analyze') return route.fulfill({ status: 200, contentType: 'application/json', body: fx('legacy-analyze-PLTR.json') });
      if (url.pathname === '/api/market') return route.fulfill({ status: 200, contentType: 'application/json', body: fx('chart-PLTR-5y-1wk.json') });
      if (url.pathname === '/api/screener') return route.fulfill({ status: 200, json: { rows: [
        { ticker: 'PLTR', name: 'Palantir', latestQ: '2026-09-30', revenueM: 2313.4, revenueYoYPct: 95.9, yoyAccelPts: 3.1, operatingMarginPct: 46.9,
          grossMarginPct: 82.2, ruleOf40Legacy: 142.8, signalScore: 53, signalQ: '2026-03-31', signalFlags: {}, phase: 'phase3', gmImproveStreak: 1, price: 159.36 },
        { ticker: 'NOPE', error: 'SECの企業一覧に見つかりません' }], source: {}, status: 'verification-pending' } });
      return route.fulfill({ status: 404, json: {} });
    }
    if (url.hostname === 'unpkg.com') return route.fulfill({ status: 200, contentType: 'text/javascript', body: lw() });
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname.includes('netlify')) throw new Error('Netlify must not be called');
    if (url.hostname === 'cdn.tailwindcss.com') return route.continue().catch(() => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    return route.fulfill({ status: 503, body: '' });
  });
  return calls;
}

test('legacy analyzer (unmodified UI) loads PLTR via /api/analyze with the corrected numbers', async ({ page }, info) => {
  const calls = await setup(page);
  await page.goto('/research/index.html');
  const input = page.locator('input[type=text]').first();
  await input.fill('PLTR');
  await input.press('Enter');
  await expect(page.locator('body')).toContainText('Palantir', { timeout: 15000 });
  expect(calls.some(c => c.path === '/api/analyze?ticker=PLTR' && c.auth === 'Bearer header.payload.sig')).toBe(true);
  await expect(page.locator('body')).toContainText('四半期トレンド分析');
  await expect(page.locator('body')).toContainText('2026 Q3');
  await expect(page.locator('body')).toContainText('95.9%');           // corrected YoY (Netlify showed 130.5%)
  await page.screenshot({ path: `test-results/legacy-analyzer-${info.project.name}.png`, fullPage: false });
});

test('legacy screener (unmodified UI) gets corrected rows mapped to legacy fields', async ({ page }) => {
  const calls = await setup(page);
  await page.goto('/research/screener.html');
  const shim = await page.evaluate(() => PMLegacyShim.legacyRow({ ticker: 'X', latestQ: '2026-09-30', ruleOf40Legacy: 50, operatingMarginPct: 10, phase: 'financial' }));
  expect(shim).toMatchObject({ ticker: 'X', latestQ: '2026 Q3', rof40: 50, opMargin: 10, isFinancial: true });
  const r = await page.evaluate(async () => (await fetch('/.netlify/functions/screener', { method: 'POST', body: JSON.stringify({ tickers: ['PLTR', 'NOPE'] }) })).json());
  expect(r[0]).toMatchObject({ ticker: 'PLTR', rof40: 142.8, revYoY: 95.9, signalScore: 53, phase: 'phase3', latestQ: '2026 Q3' });
  expect(r[1].error).toContain('見つかりません');
  expect(calls.some(c => c.path === '/api/screener')).toBe(true);
});

test('not signed in: legacy page shows a login banner and sends no API request', async ({ page }) => {
  await page.addInitScript(() => { window.PMCloudReady = Promise.resolve(null); });
  const calls = await setup(page, { token: false });
  await page.goto('/research/index.html');
  const status = await page.evaluate(async () => (await fetch('/.netlify/functions/analyze?ticker=PLTR')).status);
  expect(status).toBe(401);
  await expect(page.locator('#pm-legacy-login')).toContainText('Googleログインが必要です');
  expect(calls).toHaveLength(0);
});

test('Portfolio Manager embeds the legacy pages on their routes (lazy iframe)', async ({ page }) => {
  await setup(page);
  await page.goto('/portfolio_manager.html#analysis');
  await expect(page.locator('#analysis iframe.pm-legacy-frame')).toHaveAttribute('src', 'research/index.html');
  expect(await page.locator('#screener iframe.pm-legacy-frame').getAttribute('src')).toBeNull();
  await page.evaluate(() => { location.hash = '#screener'; });   // works on PC and mobile (drawer closed)
  await expect(page.locator('#screener iframe.pm-legacy-frame')).toHaveAttribute('src', 'research/screener.html');
});
