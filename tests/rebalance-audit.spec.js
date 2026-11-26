'use strict';
const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');

const now = '2026-11-22T12:00:00Z';
function state(confirmed) {
  return { ...D.blank(), confirmed,
    positions: [{
      id: 'pltr-main', ticker: 'PLTR', kind: 'stock',
      broker: 'マネックス証券', account: '', accountType: 'specific',
      shares: 20, currency: 'USD', unitCost: 10, costJpy: 20000,
      referenceJpy: null, layer: 1, note: ''
    }],
    // Fixed specification (PLTR sell cap 0 by default).
    targets: D.blank().targets,
    cashTarget: 10,
    cash: { jpy: 10000, usd: 0, extraJpy: 0, extraIncluded: true } };
}
async function prepare(page, saved) {
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(({ key, saved }) => {
    localStorage.setItem(key, JSON.stringify(saved));
    localStorage.setItem('pm_api_key', 'fixture-key');
  }, { key: D.KEY, saved });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    // Order-grade spot USD/JPY (③ refuses the daily ECB reference).
    if (url.hostname === 'www.live-rates.com') {
      return route.fulfill({ json: [{ currency: 'USD/JPY', bid: 100 - 0.005, ask: 100 + 0.005, timestamp: Date.parse('2026-11-22T12:00:00Z') }] });
    }
    if (url.hostname === 'api.frankfurter.dev') {
      return route.fulfill({ json: { base: 'USD', quote: 'JPY', date: '2026-11-20', rate: 100 } });
    }
    if (url.hostname === 'finnhub.io') {
      if (url.pathname.endsWith('/quote'))
        return route.fulfill({ json: {
          c: url.searchParams.get('symbol') === 'PLTR' ? 100 : 10,
          t: Date.parse('2026-11-20T21:00:00Z') / 1000 } });
      if (url.pathname.endsWith('/profile2')) return route.fulfill({ json: {} });
      if (url.pathname.endsWith('/calendar/earnings')) return route.fulfill({ json: { earningsCalendar: [] } });
    }
    return route.fulfill({ status: 503, json: {} });
  });
}

test('PC: PLTR sell cap=0 is shown as impossible with a shortcut to allocation settings', async ({page}, info) => {
  test.skip(info.project.name !== 'PC', 'PC-only audit');
  await prepare(page, state(true));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/portfolio_manager.html#after');
  const report = page.locator('#rebalance-audit');
  await expect(report.locator('[data-audit-status]')).toHaveAttribute('data-audit-status', 'blocked');
  await expect(report).toContainText('現設定では達成不可');
  await expect(report).toContainText('PLTR');
  await expect(report).toContainText('売却上限0株');
  await expect(report).toContainText('最大乖離');
  await expect(page.locator('#rebalance-audit-details')).not.toHaveAttribute('open', '');
  await page.locator('#rebalance-audit-details > summary').click();
  await expect(report.locator('a[href="#allocation"]')).toBeVisible();
  await expect(page.locator('#trade-board')).toContainText('SELL');
  await expect(page.locator('#allocation-charts svg')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('PC: unconfirmed holdings show pending without trading ticket generation', async ({page}, info) => {
  test.skip(info.project.name !== 'PC', 'PC-only audit');
  await prepare(page, state(false));
  await page.goto('/portfolio_manager.html#after');
  await expect(page.locator('#rebalance-audit [data-audit-status]')).toHaveAttribute('data-audit-status','pending');
  await expect(page.locator('#rebalance-audit')).toContainText('計算保留');
  await expect(page.locator('#trade-board')).toBeEmpty();
  await expect(page.locator('#csv-export')).toBeDisabled();
});

test('PC: changing allocation without saving pauses stale result until saved', async ({page}, info) => {
  test.skip(info.project.name !== 'PC', 'PC-only audit');
  await prepare(page, state(true));
  await page.goto('/portfolio_manager.html#allocation');
  await expect(page.locator('#rebalance-audit [data-audit-status]')).toHaveAttribute('data-audit-status', 'blocked');
  // Weights are fixed; any unsaved allocation change (here: the group) still pauses ③.
  await page.locator('#target-rows [data-field="group"]').first().selectOption('satellite');
  await expect(page.locator('#rebalance-audit [data-audit-status]')).toHaveAttribute('data-audit-status', 'pending');
  await expect(page.locator('#trade-board')).toBeEmpty();
  await expect(page.locator('#csv-export')).toBeDisabled();
});
