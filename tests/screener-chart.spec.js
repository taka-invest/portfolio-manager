'use strict';
// 銘柄スクリーナー / 株価チャート screens. API responses are computed from the real
// SEC fixtures with the same code the Cloud Functions run.
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

async function screenerBody() {
  const S = await import('file://' + join(__dirname, '..', 'functions/src/sec/screen.js'));
  const rows = ['PLTR', 'APP', 'NVDA'].map(t =>
    ({ ...S.screenFacts(t, JSON.parse(readFileSync(join(__dirname, 'fixtures/sec', t + '.json'), 'utf8'))), price: null, priceAsOf: null }));
  rows.push({ ticker: 'NOPE', error: 'SECの企業一覧に見つかりません' });
  return { rows, source: { provider: 'SEC EDGAR XBRL companyfacts', price: 'Yahoo Finance chart API（非公式）', retrievedAt: '2026-11-24T01:00:00Z' }, status: 'verification-pending' };
}
const chartBody = {
  ticker: 'NVDA', range: '5y', interval: '1wk', currency: 'USD', adjusted: true,
  points: [{ t: '2021-11-29', close: 30.1 }, { t: '2023-06-05', close: 39.8 }, { t: '2026-11-23', close: 165.05 }],
  source: { provider: 'Yahoo Finance chart API（非公式）', retrievedAt: '2026-11-24T01:00:00Z', note: '分割・配当調整後の終値' }
};

async function setup(page, apis) {
  await page.clock.setFixedTime(new Date('2026-11-24T03:00:00Z'));
  await page.addInitScript(() => { window.PMCloud = { idToken: async () => 'header.payload.sig' }; });
  const calls = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/api/market') calls.push({ path: url.pathname, search: url.search, body: route.request().postDataJSON?.() ?? null });
      const handler = apis[url.pathname] ?? (url.pathname === '/api/market' ? r => r.fulfill({ status: 503, json: {} }) : null);
      return handler ? handler(route) : route.fulfill({ status: 404, contentType: 'text/html', body: 'nf' });
    }
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 503, json: {} });
  });
  return calls;
}

test('chart: draws an accessible SVG with source and period change; range is sent', async ({ page }, info) => {
  const calls = await setup(page, { '/api/chart': route => route.fulfill({ status: 200, json: chartBody }) });
  await page.goto('/portfolio_manager.html#chart');
  await expect(page.getByRole('link', { name: '株価チャート' })).toHaveAttribute('aria-current', 'page');
  await page.locator('#pm-chart-ticker').fill('nvda');
  await page.locator('#pm-chart-range').selectOption('5y');
  await page.getByRole('button', { name: '表示' }).click();
  const svg = page.locator('#pm-chart-svg svg');
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute('role', 'img');
  await expect(svg).toHaveAttribute('aria-label', /2021-11-29から2026-11-23/);
  await expect(page.locator('#pm-chart-result')).toContainText('$165.05');
  await expect(page.locator('#pm-chart-result')).toContainText('448.3%');        // 165.05 / 30.1 − 1
  await expect(page.locator('#pm-chart-result')).toContainText('Yahoo Finance');
  expect(calls[0]).toMatchObject({ path: '/api/chart', search: '?ticker=NVDA&range=5y' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  await page.screenshot({ path: `test-results/chart-${info.project.name}.png` });
});

test('chart: not deployed and no price data are explained', async ({ page }) => {
  let mode = 'html';
  await setup(page, { '/api/chart': route => mode === 'html'
    ? route.fulfill({ status: 404, contentType: 'text/html', body: 'nf' })
    : route.fulfill({ status: 404, json: { error: 'No price data' } }) });
  await page.goto('/portfolio_manager.html#chart');
  await page.locator('#pm-chart-ticker').fill('NVDA');
  await page.getByRole('button', { name: '表示' }).click();
  await expect(page.locator('#pm-chart-status')).toContainText('チャートAPIはまだ公開されていません');
  mode = 'json';
  await page.getByRole('button', { name: '表示' }).click();
  await expect(page.locator('#pm-chart-status')).toContainText('株価データが見つかりません');
});
