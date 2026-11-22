'use strict';

const { test, expect } = require('@playwright/test');
const fg = require('../app/fear-greed.js');
const url = '/portfolio_manager.html#market';
const scoreDate = '2026-11-20T21:00:00Z';
const score = fg.normalize({
  fear_and_greed: { score: 22, rating: 'Extreme Fear', timestamp: scoreDate, previous_close: 30, previous_1_week: 47, previous_1_month: 60 },
  fear_and_greed_historical: { data: [
    { x: Date.parse('2026-01-05'), y: 70 }, { x: Date.parse('2026-08-30'), y: 55 },
    { x: Date.parse('2026-11-18'), y: 35 }, { x: Date.parse('2026-11-20'), y: 22 }
  ] }
}, '2026-11-20T23:23:00Z');

async function mock(page, options = {}) {
  await page.clock.setFixedTime(new Date(options.now || '2026-11-22T12:00:00Z'));
  await page.addInitScript(({ enableFear, enableVol }) => {
    if (enableFear) localStorage.setItem('pm_fg_feed_enabled_v1', 'true');
    if (enableVol) localStorage.setItem('pm_volatility_feed_url_v1', './test-data/volatility.json');
  }, { enableFear: !!options.enableFear, enableVol: !!options.enableVol });
  const state = { fgStatus: 200, fgPayload: score, volStatus: 200, calls: [] };
  await page.route('**/*', route => {
    const req = new URL(route.request().url());
    if (req.pathname.endsWith('/test-data/volatility.json')) {
      state.calls.push('volatility');
      return route.fulfill({ status: state.volStatus, json: {
        version: 1, status: 'ok', VIX: 31, VXN: 41, asOf: scoreDate, source: 'Licensed fixture' } });
    }
    if (req.hostname === 'raw.githubusercontent.com' && req.pathname.endsWith('/fear-greed.json')) {
      state.calls.push('fg');
      return route.fulfill({ status: state.fgStatus, json: state.fgPayload });
    }
    if (req.hostname === '127.0.0.1') return route.continue();
    if (req.hostname === 'api.frankfurter.dev')
      return route.fulfill({ json: { base: 'USD', quote: 'JPY', rate: 150, date: '2026-11-20' } });
    return route.fulfill({ status: 503, json: {} });
  });
  return state;
}

test('no licensed feed configured: no CNN/Yahoo proxy calls, graceful missing data', async ({ page }) => {
  const state = await mock(page);
  await page.goto(url);
  await expect(page.locator('#fg-status')).toHaveText('公開データなし');
  await expect(page.locator('#vix-value')).toHaveText('—');
  await expect(page.locator('#vxn-value')).toHaveText('—');
  await expect(page.locator('#market-signal')).toContainText('自動シグナル無効');
  expect(state.calls).toEqual([]);
  const references = await page.evaluate(() => ({ fg: localStorage.getItem('pm_fg'), vix: localStorage.getItem('pm_vix') }));
  expect(references.fg).toBeNull();
  expect(references.vix).toBeNull();
});

test('licensed F&G and VIX/VXN feed: display score, comparisons, chart and source', async ({ page }) => {
  const state = await mock(page, { enableFear: true, enableVol: true });
  await page.goto(url);
  await expect(page.locator('#fg-value')).toHaveText('22');
  await expect(page.locator('#fg-status')).toHaveText('利用可');
  await expect(page.locator('#fg-previous')).toHaveText('30（-8 pt）');
  await expect(page.locator('#fg-week')).toHaveText('47（-25 pt）');
  await expect(page.locator('#fg-month')).toHaveText('60（-38 pt）');
  await expect(page.locator('#vix-value')).toHaveText('31.0');
  await expect(page.locator('#vxn-value')).toHaveText('41.0');
  await expect(page.locator('#vix-status')).toContainText('Licensed fixture');
  await expect(page.locator('#market-signal')).toContainText('購入検討');
  await page.locator('#fg-range button[data-days="90"]').click();
  await expect(page.locator('#fg-chart-range')).toContainText('3件');
  expect(state.calls).toContain('fg');
  expect(state.calls).toContain('volatility');
  const original = state.calls.filter(x => x === 'volatility').length;
  await page.reload();
  expect(state.calls.filter(x => x === 'volatility').length).toBe(original);
});

test('manually entered values display as reference but do not trigger market signal or confidence', async ({ page }) => {
  const state = await mock(page);
  await page.goto(url);
  await page.locator('.fg-manual summary').click();
  await page.locator('#fg-manual-score').fill('0');
  await page.getByRole('button', { name: '参考値を保存' }).click();
  await page.locator('#s-vix-manual').fill('45');
  await page.locator('#s-vxn-manual').fill('55');
  await page.getByRole('button', { name: '参考値を適用' }).click();
  await expect(page.locator('#fg-value')).toHaveText('0');
  await expect(page.locator('#fg-status')).toContainText('手動入力の参考値');
  await expect(page.locator('#vix-status')).toContainText('シグナル不使用');
  await expect(page.locator('#market-signal')).toContainText('自動シグナル無効');
  await page.reload();
  await expect(page.locator('#fg-value')).toHaveText('0');
  await expect(page.locator('#vix-value')).toHaveText('45.0');
  await expect(page.locator('#market-signal')).toContainText('自動シグナル無効');
  expect(state.calls).toEqual([]);
});

test('stale automatic index remains reference-only after market opens', async ({ page }) => {
  await mock(page, { enableVol: true, now: '2026-11-23T16:00:00Z' });
  await page.goto(url);
  await expect(page.locator('#vix-value')).toHaveText('31.0');
  await expect(page.locator('#vix-status')).toContainText('シグナル不使用');
  await expect(page.locator('#market-signal')).toContainText('自動シグナル無効');
});
