'use strict';

const { test, expect } = require('@playwright/test');

test('research: hash route opens migrated library and returns to company evaluation', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // No paid third-party services or real portfolio are needed for this test.
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 200, body: '', contentType: 'text/javascript' });
  });
  await page.goto('/portfolio_manager.html#research');
  await expect(page.locator('#research')).toBeVisible();
  await expect(page.locator('#rebalance')).toBeHidden();
  await expect(page.getByRole('navigation', { name: '主要機能' }).getByRole('link', { name: '投資指標ライブラリ', exact: true })).toHaveAttribute('aria-current', 'page');
  const originalWorkspace = await page.evaluate(() => localStorage.getItem('pm_workspace_v3'));
  await page.getByRole('link', { name: '投資指標ライブラリを開く' }).click();
  await expect(page).toHaveURL(/\/research\/library\.html$/);
  await expect(page.getByRole('heading', { name: '投資指標ライブラリ', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /株価インパクト ピラミッド/ })).toBeVisible();
  await page.getByRole('link', { name: /アプリに戻る/ }).first().click();
  await expect(page).toHaveURL(/\/portfolio_manager\.html#companies$/);
  await expect(page.locator('#companies')).toBeVisible();
  const afterWorkspace = await page.evaluate(() => localStorage.getItem('pm_workspace_v3'));
  expect(afterWorkspace).toBe(originalWorkspace);
  expect(errors).toEqual([]);
});

test('research: direct navigation is usable on mobile without touching existing allocation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'スマホ', 'Mobile-only');
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 200, body: '', contentType: 'text/javascript' });
  });
  await page.goto('/portfolio_manager.html#research');
  await expect(page.locator('#research')).toBeVisible();
  await page.getByRole('link', { name: '投資指標ライブラリを開く' }).click();
  await expect(page.getByRole('heading', { name: '投資指標ライブラリ', exact: true })).toBeVisible();
});

test('library: hall-of-fame scan uses the authenticated APIs sequentially (no Netlify, no third parties)', async ({ page }) => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const F = await import('file://' + join(__dirname, '..', 'functions/src/sec/financials.js'));
  const out = F.analyzeFacts(JSON.parse(readFileSync(join(__dirname, 'fixtures/sec/PLTR.json'), 'utf8')));
  await page.addInitScript(() => { window.PMCloud = { idToken: async () => 'header.payload.sig' }; });
  const seen = [];
  let inFlight = 0, maxInFlight = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      seen.push(url.pathname + url.search);
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(r => setTimeout(r, 30));
      inFlight--;
      if (url.pathname === '/api/financials') return route.fulfill({ status: 200, json: { name: 'Palantir', quarters: out.quarters } });
      return route.fulfill({ status: 200, json: { chart: { result: [{ timestamp: [1735689600, 1767225600], indicators: { quote: [{ close: [70, 160] }] } }] } } });
    }
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname.includes('netlify')) throw new Error('Netlify must not be called');
    return route.fulfill({ status: 200, body: '', contentType: 'text/css' });
  });
  await page.goto('/research/library.html');
  await page.evaluate(() => { HOF_SELECTED.clear(); HOF_SELECTED.add('PLTR'); return runHofScan(); });
  await expect(page.locator('#hofResults')).toContainText('PLTR');
  expect(seen).toEqual(['/api/financials?ticker=PLTR', '/api/market?symbol=PLTR&range=10y&interval=1mo']);
  expect(maxInFlight).toBe(1);
});
