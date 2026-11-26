'use strict';
// Display accuracy: own-API USD/JPY, no stale indicators, explicit failure states,
// honest performance card, visible notices.
const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');

const NOW = Date.parse('2026-11-23T03:00:00Z');      // Monday 12:00 JST (FX market open)
const lot = (id, ticker, shares, extra = {}) => ({ id, ticker, kind: 'stock', broker: '架空証券', account: '',
  accountType: 'specific', shares, currency: 'USD', unitCost: 10, costJpy: shares * 1500, referenceJpy: null,
  layer: 1, note: '', ...extra });

async function open(page, { saved = D.blank(), signedIn = true, storage = {}, hash = '' } = {}) {
  await page.clock.setFixedTime(new Date(NOW));
  if (signedIn) await page.addInitScript(() => { window.PMCloud = { idToken: async () => 'header.payload.sig' }; });
  await page.addInitScript(({ key, saved, storage }) => {
    localStorage.setItem(key, JSON.stringify(saved));
    for (const [k, v] of Object.entries(storage)) localStorage.setItem(k, v);
  }, { key: D.KEY, saved, storage });
  const calls = [];
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' && !u.pathname.startsWith('/api/')) return route.continue();
    calls.push(u.hostname + u.pathname + u.search);
    if (u.pathname === '/api/market' && u.searchParams.get('symbol') === 'JPY=X')
      return route.fulfill({ json: { chart: { result: [{ meta: { symbol: 'JPY=X', regularMarketPrice: 158.77, regularMarketTime: NOW / 1000 - 120 } }] } } });
    if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 502, json: { error: 'upstream' } });
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/portfolio_manager.html' + hash);
  return calls;
}

test('USD/JPY comes from the own API with provider time; no third-party FX call', async ({ page }) => {
  const calls = await open(page);
  await expect(page.locator('#summary-row')).toContainText('158.77');
  await expect(page.locator('#summary-row')).toContainText('自前API経由');
  expect(calls.some(c => c.includes('/api/market?symbol=JPY%3DX'))).toBe(true);
  expect(calls.some(c => /live-rates|exchangerate\.fun|frankfurter/.test(c))).toBe(false);
});

test('stale VIX/F&G are not used for signals; failures and a missing key are named', async ({ page }) => {
  const old = JSON.stringify({ v: 10, t: NOW - 2 * 86400000 });     // 2 days old, would mean "buy"
  await open(page, { storage: { pm_fg: old, pm_vix: JSON.stringify({ v: 45, t: NOW - 2 * 86400000 }) }, hash: '#market' });
  await expect(page.locator('#market-signal')).not.toContainText('購入シグナル');
  await expect(page.locator('#fg-label')).toContainText('取得失敗');
  await expect(page.locator('#vix-label')).toContainText('取得失敗');
  await expect(page.locator('#spy-signal')).toContainText('Finnhub APIキー未設定');
  // A trade recorded now must not carry the 2-day-old values.
  expect(await page.evaluate(() => captureMarketSnapshot())).toEqual({ vix: null, fg: null, spyDrawdown: null });
});

test('performance card names lots without cost instead of "no positions"', async ({ page }) => {
  const saved = { ...D.blank(), positions: [lot('a', 'NVDA', 2), lot('b', 'APP', 1, { costJpy: null, unitCost: null })] };
  await open(page, { saved });
  await page.evaluate(() => renderPerformance(null));
  const card = page.locator('#perf-section');
  await expect(card).not.toContainText('ポジションなし');
  await expect(card).toContainText('取得原価が未入力：APP');
  await expect(card).toContainText('参考：含み益率 − S&P500');
  await expect(card).toContainText('基準日を設定してください');
});

test('a notice raised outside the dashboard is shown where the user is', async ({ page }) => {
  await open(page, { hash: '#holdings' });
  await page.evaluate(() => PMApp.showNotice('テスト通知：保存できませんでした', true));
  await expect(page.locator('#pm-toast')).toBeVisible();
  await expect(page.locator('#pm-toast')).toContainText('保存できませんでした');
});
