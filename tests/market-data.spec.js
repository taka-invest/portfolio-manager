'use strict';
// 市場分析: own /api/market is preferred; third-party proxies are used only while the
// API is not deployed, and never for holdings tickers when signed out.
const { test, expect } = require('@playwright/test');

async function setup(page, { token, api }) {
  await page.clock.setFixedTime(new Date('2026-11-24T03:00:00Z'));
  if (token) await page.addInitScript(() => { window.PMCloud = { idToken: async () => 'header.payload.sig' }; });
  const hits = { api: [], proxy: [] };
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/market') { hits.api.push(url.search); return api(route, url); }
    if (/allorigins|corsproxy|codetabs/.test(url.hostname)) {
      hits.proxy.push(decodeURIComponent(url.href));
      return route.fulfill({ status: 200, json: { chart: { result: [{ meta: { regularMarketPrice: 22.5 } }] }, fear_and_greed: { score: 40 } } });
    }
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 503, json: {} });
  });
  return hits;
}

test('signed in + API deployed: VIX/F&G via own API only, no proxy traffic', async ({ page }) => {
  const hits = await setup(page, { token: true, api: (route, url) => route.fulfill({ status: 200, json: url.searchParams.get('kind') === 'feargreed'
    ? { fear_and_greed: { score: 62 } } : { chart: { result: [{ meta: { regularMarketPrice: 18.4 }, indicators: { quote: [{ close: [] }] } }] } } }) });
  await page.goto('/portfolio_manager.html#market');
  await expect(page.locator('#vix-value')).toHaveText('18.4');
  await expect(page.locator('#fg-value')).toHaveText('62');
  await expect(page.locator('#pm-market-source')).toContainText('自前API');
  expect(hits.proxy).toEqual([]);
  expect(hits.api.some(s => s.includes('symbol=%5EVIX'))).toBe(true);
});

test('API not deployed: legacy proxies are used and the screen says so', async ({ page }) => {
  const hits = await setup(page, { token: true, api: route => route.fulfill({ status: 404, contentType: 'text/html', body: 'nf' }) });
  await page.goto('/portfolio_manager.html#market');
  await expect(page.locator('#vix-value')).toHaveText('22.5');
  await expect(page.locator('#pm-market-source')).toContainText('第三者の中継サービス');
  expect(hits.proxy.length).toBeGreaterThan(0);
  // Signed in but API not deployed: the legacy path still works for technicals too.
  await page.evaluate(() => fetchTechnicals('ZZTOP'));
  expect(hits.proxy.some(u => u.includes('ZZTOP'))).toBe(true);
});

test('signed out: index data may use proxies, but holdings technicals are never sent to them', async ({ page }) => {
  const hits = await setup(page, { token: false, api: route => route.fulfill({ status: 401, json: {} }) });
  await page.addInitScript(() => {
    localStorage.setItem('pm_workspace_v3', JSON.stringify({ version: 3, positions: [{ id: 'l1', ticker: 'ZZTOP', kind: 'stock', broker: 'X', account: '', accountType: 'specific', shares: 1, currency: 'USD', unitCost: 1, costJpy: null, referenceJpy: null, layer: 1, note: '' }],
      targets: [], cashTarget: 10, cash: { jpy: 0, usd: 0, extraJpy: 0, extraIncluded: true }, confirmed: false, tax: { rate: 20.315, offset: 'none' },
      stagedFunding: null, plans: [], trades: [], watchlist: [], company: [], preferences: {} }));
  });
  await page.goto('/portfolio_manager.html#market');
  await expect(page.locator('#vix-value')).toHaveText('22.5');
  const result = await page.evaluate(() => fetchTechnicals('ZZTOP'));
  expect(result).toBeNull();
  expect(hits.proxy.some(u => u.includes('ZZTOP'))).toBe(false);
});
