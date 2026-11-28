'use strict';
// 市場分析: own /api/market only. The public CORS proxies were removed, so no ticker
// (index or holding) is ever sent to a third party, signed in or not.
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

test('signed in: F&G via own API (labelled unofficial), VIX no longer requested (no free source)', async ({ page }) => {
  const hits = await setup(page, { token: true, api: (route, url) => route.fulfill({ status: 200, json: url.searchParams.get('kind') === 'feargreed'
    ? { fear_and_greed: { score: 62 } } : { chart: { result: [{ meta: { regularMarketPrice: 18.4 }, indicators: { quote: [{ close: [] }] } }] } } }) });
  await page.goto('/portfolio_manager.html#market');
  await expect(page.locator('#fg-value')).toHaveText('62');
  await expect(page.locator('#fg-label')).toContainText('非公式・参考');
  await expect(page.locator('#vix-value')).toHaveText('—');
  await expect(page.locator('#vix-label')).toContainText('自動取得なし');
  await expect(page.locator('#pm-market-source')).toContainText('自前API');
  expect(hits.proxy).toEqual([]);
  expect(hits.api.some(s => /symbol=%5E(VIX|VXN)/.test(s))).toBe(false);
});

test('API failure: the value is reported as failed and no proxy is tried', async ({ page }) => {
  const hits = await setup(page, { token: true, api: route => route.fulfill({ status: 502, json: { error: 'upstream' } }) });
  await page.goto('/portfolio_manager.html#market');
  await expect(page.locator('#fg-label')).toContainText('取得失敗');
  await page.evaluate(() => fetchTechnicals('ZZTOP'));
  expect(hits.proxy).toEqual([]);
});

test('signed out: nothing is sent to third-party proxies (index or holdings)', async ({ page }) => {
  const hits = await setup(page, { token: false, api: route => route.fulfill({ status: 401, json: {} }) });
  await page.addInitScript(() => {
    localStorage.setItem('pm_workspace_v3', JSON.stringify({ version: 3, positions: [{ id: 'l1', ticker: 'ZZTOP', kind: 'stock', broker: 'X', account: '', accountType: 'specific', shares: 1, currency: 'USD', unitCost: 1, costJpy: null, referenceJpy: null, layer: 1, note: '' }],
      targets: [], cashTarget: 10, cash: { jpy: 0, usd: 0, extraJpy: 0, extraIncluded: true }, confirmed: false, tax: { rate: 20.315, offset: 'none' },
      stagedFunding: null, plans: [], trades: [], watchlist: [], company: [], preferences: {} }));
  });
  await page.goto('/portfolio_manager.html#market');
  await expect(page.locator('#fg-label')).toContainText('ログインが必要');
  const result = await page.evaluate(() => fetchTechnicals('ZZTOP'));
  expect(result).toBeNull();
  expect(hits.proxy).toEqual([]);
});
