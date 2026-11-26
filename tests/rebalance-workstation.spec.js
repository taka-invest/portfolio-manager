'use strict';

const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');
const url = '/portfolio_manager.html#rebalance';
const close = Date.parse('2026-11-20T21:00:00Z') / 1000;
const row = (ticker, pct, extra = {}) =>
  ({ ticker, pct, group: 'core', sellCap: null, wait: false, ...extra });

test('PC: ideal portfolio, trade tickets and before/after donuts are linked', async ({ page }, info) => {
  test.skip(info.project.name !== 'PC', 'PC-only workstation');
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  const draft = {
    ...D.blank(),
    confirmed: true,
    positions: [{
      id: 'lot-pltr', ticker: 'PLTR', kind: 'stock', broker: 'Fixture Broker',
      account: 'Main', accountType: 'specific', layer: 1,
      shares: 10, currency: 'USD', unitCost: 10, costJpy: 20000,
      referenceJpy: null, note: ''
    }],
    // Fixed specification; PLTR may be sold (cap 6) but never below 30%.
    targets: D.fixedTargets(D.blank().targets.map(t => t.ticker === 'PLTR' ? { ...t, sellCap: 6 } : t)),
    cashTarget: 10,
    cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true }
  };
  await page.addInitScript(({ key, draft }) => {
    localStorage.setItem(key, JSON.stringify(draft));
    localStorage.setItem('pm_api_key', 'fixture-only');
  }, { key: D.KEY, draft });
  await page.route('**/*', route => {
    const req = new URL(route.request().url());
    if (req.hostname === '127.0.0.1') return route.continue();
    // Order-grade spot USD/JPY (③ refuses the daily ECB reference).
    if (req.hostname === 'www.live-rates.com') {
      return route.fulfill({ json: [{ currency: 'USD/JPY', bid: 100 - 0.005, ask: 100 + 0.005, timestamp: Date.parse('2026-11-22T12:00:00Z') }] });
    }
    if (req.hostname === 'api.frankfurter.dev') {
      return route.fulfill({ json: { base: 'USD', quote: 'JPY', date: '2026-11-20', rate: 100 } });
    }
    if (req.hostname === 'finnhub.io') {
      if (req.pathname.endsWith('/quote'))
        return route.fulfill({ json: { c: req.searchParams.get('symbol') === 'PLTR' ? 100 : 50, t: close } });
      if (req.pathname.endsWith('/profile2')) return route.fulfill({ json: {} });
      if (req.pathname.endsWith('/calendar/earnings')) return route.fulfill({ json: { earningsCalendar: [] } });
      return route.fulfill({ status: 503, json: {} });
    }
    return route.fulfill({ status: 503, json: {} });
  });
  const failures = [];
  page.on('pageerror', e => failures.push(e.message));
  await page.goto(url);
  await expect(page.locator('#rebalance-state')).toContainText('保有と価格を確認済み');
  await expect(page.locator('#ideal-summary')).toContainText('対象資産総額');
  await expect(page.locator('#ideal-table')).toContainText('理想株数');
  await expect(page.locator('#ideal-table')).toContainText('NVDA');
  await expect(page.locator('#ideal-table')).toContainText('PLTR');
  await expect(page.locator('#rebalance-table')).toContainText('NVDA');
  await page.goto('/portfolio_manager.html#after');
  await expect(page.locator('#trade-board')).toContainText('SELL');
  await expect(page.locator('#trade-board')).toContainText('BUY');
  await expect(page.locator('#trade-board')).toContainText('PLTR');
  await expect(page.locator('#trade-board')).toContainText('NVDA');
  await expect(page.locator('#allocation-charts svg')).toHaveCount(2);
  await expect(page.locator('#allocation-charts')).toContainText('売買前');
  await expect(page.locator('#allocation-charts')).toContainText('売買後');
  await expect(page.locator('#allocation-charts')).toContainText('目標との差');

  await page.goto('/portfolio_manager.html#allocation');
  await expect(page.locator('#target-preview')).toContainText('合計100%');
  await expect(page.locator('#cash-target')).toHaveAttribute('readonly', '');
  await expect(page.locator('#target-rows [data-field="pct"]').first()).toHaveAttribute('readonly', '');
  await page.locator('#target-rows [data-field="group"]').first().selectOption('satellite');
  await expect(page.locator('#rebalance-state')).toContainText('変更を保存');
  await expect(page.locator('#csv-export')).toBeDisabled();
  expect(failures).toEqual([]);
});
