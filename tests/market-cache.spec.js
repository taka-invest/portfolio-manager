'use strict';

const { test, expect } = require('@playwright/test');
const url = '/portfolio_manager.html';
const quoteTimestamp = Date.parse('2026-11-20T21:00:00Z') / 1000;

async function marketStub(page, rateLimited) {
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('pm_api_key', 'fixture-token'));
  const calls = { finnhub: 0, fx: 0 };
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'api.frankfurter.dev') {
      calls.fx++;
      return route.fulfill({ json: { base: 'USD', quote: 'JPY', date: '2026-11-20', rate: 155.5 } });
    }
    if (url.hostname === 'finnhub.io') {
      calls.finnhub++;
      if (rateLimited) return route.fulfill({ status: 429, headers: { 'Retry-After': '120' }, body: '{}' });
      if (url.pathname.endsWith('/profile2')) return route.fulfill({ json: {} });
      if (url.pathname.endsWith('/quote')) return route.fulfill({ json: { c: 100, t: quoteTimestamp } });
      if (url.pathname.endsWith('/stock/metric')) return route.fulfill({ json: { metric: { '52WeekHigh': 150 } } });
      if (url.pathname.endsWith('/calendar/earnings')) return route.fulfill({ json: { earningsCalendar: [] } });
      return route.fulfill({ status: 400, json: {} });
    }
    // External proxy calls are unrelated to Finnhub, and not part of this test.
    return route.fulfill({ status: 503, json: {} });
  });
  return calls;
}

test('cached quotes/FX prevent additional Finnhub calls on immediate reload', async ({ page }) => {
  const calls = await marketStub(page, false);
  await page.goto(url);
  await expect(page.locator('#market-status')).toContainText('利用可');
  await expect(page.locator('#target-rows')).toContainText('$100');
  await expect.poll(() => page.evaluate(() => Boolean(localStorage.getItem('pm_earnings_next_batch_v1')))).toBe(true);
  const before = { ...calls };
  expect(before.finnhub).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('#target-rows')).toContainText('$100');
  expect(calls.finnhub).toBe(before.finnhub);
  expect(calls.fx).toBe(before.fx);
});

test('429 cooldown survives browser reload, even when no quote is cached', async ({ page }) => {
  const calls = await marketStub(page, true);
  await page.goto(url);
  await expect(page.locator('#market-status')).toContainText('API制限により再試行は');
  const pause = await page.evaluate(() => Number(localStorage.getItem('pm_finnhub_cooldown_until_v1')));
  expect(pause).toBeGreaterThan(Date.parse('2026-11-22T12:00:00Z'));
  const before = calls.finnhub;
  await page.reload();
  await expect(page.locator('#market-status')).toContainText('API制限により再試行は');
  await page.locator('#price-update').click();
  expect(calls.finnhub).toBe(before);
});
