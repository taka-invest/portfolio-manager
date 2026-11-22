'use strict';

const { test, expect } = require('@playwright/test');
const model = require('../app/fear-greed.js');

const url = '/portfolio_manager.html';
const asOf = '2026-11-20T21:00:00Z';
const timestamp = Date.parse;
const published = model.normalize({
  fear_and_greed: { score: 22, rating: 'extreme fear', timestamp: asOf, previous_close: 30, previous_1_week: 47, previous_1_month: 60 },
  fear_and_greed_historical: { data: [
    { x: timestamp('2026-01-05'), y: 70 }, { x: timestamp('2026-08-30'), y: 55 },
    { x: timestamp('2026-11-18'), y: 35 }, { x: timestamp('2026-11-20'), y: 22 }
  ] }
}, '2026-11-20T23:23:00Z');

async function mock(page) {
  const upstream = { status: 200, payload: published };
  await page.route('**/*', async route => {
    const r = new URL(route.request().url());
    if (r.hostname === '127.0.0.1') return route.continue();
    if (r.hostname === 'raw.githubusercontent.com' && r.pathname.endsWith('/fear-greed.json')) {
      return route.fulfill({ status: upstream.status, json: upstream.payload });
    }
    if (r.hostname === 'api.frankfurter.dev') {
      return route.fulfill({ json: { base: 'USD', quote: 'JPY', date: '2026-11-20', rate: 150 } });
    }
    if (decodeURIComponent(r.href).includes('query1.finance.yahoo.com')) {
      return route.fulfill({ json: { chart: { result: [{ meta: { regularMarketPrice: 31 } }] } } });
    }
    return route.fulfill({ status: 503 });
  });
  return upstream;
}

test('renders the three comparisons, history controls and independent VIX and VXN on desktop and mobile', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  await mock(page);
  await page.goto(url);
  await expect(page.locator('#fg-status')).toHaveText('利用可');
  await expect(page.locator('#fg-value')).toHaveText('22');
  await expect(page.locator('#fg-label')).toHaveText('Extreme Fear');
  await expect(page.locator('#fg-previous')).toHaveText('30（-8 pt）');
  await expect(page.locator('#fg-week')).toHaveText('47（-25 pt）');
  await expect(page.locator('#fg-month')).toHaveText('60（-38 pt）');
  await expect(page.locator('#fg-asof')).toContainText('JST');
  await expect(page.locator('#fg-attempt')).toContainText('JST');
  await expect(page.locator('#fg-chart-range')).toContainText('2件');
  await page.getByRole('button', { name: '3か月', exact: true }).click();
  await expect(page.locator('#fg-chart-range')).toContainText('3件');
  await page.getByRole('button', { name: '1年', exact: true }).click();
  await expect(page.locator('#fg-chart-range')).toContainText('4件');
  await expect(page.locator('#vix-value')).toHaveText('31.0');
  await expect(page.locator('#vxn-value')).toHaveText('31.0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth)
  );
});

test('retains old data as reference, updates on refresh and handles format changes or absent publication', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-23T23:35:00Z'));
  const upstream = await mock(page);
  upstream.status = 404;
  await page.goto(url);
  await expect(page.locator('#fg-status')).toHaveText('公開データなし');
  await expect(page.locator('#fg-value')).toHaveText('—');
  await expect(page.locator('#market-signal')).toContainText('VIX高（F&G利用不可）');
  upstream.status = 200;
  upstream.payload = { ...published, attemptedAt: '2026-11-23T23:23:00Z', status: 'error', error: 'access-denied' };
  await page.locator('.sentiment-panel').getByRole('button', { name: '🔄 更新' }).click();
  await expect(page.locator('#fg-status')).toContainText('アクセス拒否');
  await expect(page.locator('#fg-status')).toContainText('古いデータ');
  await expect(page.locator('#fg-value')).toHaveText('22');
  await expect(page.locator('#market-signal')).toContainText('VIX高（F&G利用不可）');
  upstream.payload = { version: 2 };
  await page.reload();
  await expect(page.locator('#fg-status')).toContainText('公開データの形式エラー');
  await expect(page.locator('#fg-status')).toContainText('古いデータ');
  await expect(page.locator('#fg-value')).toHaveText('22');
});
