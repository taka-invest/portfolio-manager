'use strict';

const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');

test('PC: section ② renders ideal target while ③ trade guidance remains locked for unverified lots', async ({ page }, info) => {
  test.skip(info.project.name !== 'PC', 'PC-first preview feature');
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  const draft = {
    ...D.blank(), confirmed: false,
    cash: { jpy: 671285, usd: 0, extraJpy: 0, extraIncluded: true },
    positions: [{
      id: 'unverified-pltr', ticker: 'PLTR', kind: 'stock', shares: 10,
      broker: '', account: '', accountType: 'unknown', layer: 1,
      currency: 'USD', unitCost: 15, costJpy: null,
      referenceJpy: null, note: ''
    }],
    targets: [
      { ticker: 'PLTR', pct: 30, group: 'core', sellCap: null, wait: false },
      { ticker: 'NVDA', pct: 60, group: 'core', sellCap: null, wait: false }
    ],
    cashTarget: 10
  };
  await page.addInitScript(({key, state}) => {
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem('pm_api_key', 'fixture-token');
  }, { key: D.KEY, state: draft });
  await page.route('**/*', route => {
    const uri = new URL(route.request().url());
    if (uri.hostname === '127.0.0.1') return route.continue();
    if (uri.hostname === 'api.frankfurter.dev')
      return route.fulfill({ json: { base: 'USD', quote: 'JPY', date: '2026-11-20', rate: 150 } });
    if (uri.hostname === 'finnhub.io') {
      if (uri.pathname.endsWith('/quote'))
        return route.fulfill({ json: {
          c: uri.searchParams.get('symbol') === 'PLTR' ? 100 : 50,
          t: Date.parse('2026-11-20T21:00:00Z') / 1000
        } });
      if (uri.pathname.endsWith('/profile2')) return route.fulfill({ json: {} });
      if (uri.pathname.endsWith('/calendar/earnings')) return route.fulfill({ json: { earningsCalendar: [] } });
    }
    return route.fulfill({ status: 503, json: {} });
  });
  const runtimeErrors = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.goto('/portfolio_manager.html#rebalance');
  await expect(page.locator('#ideal-summary')).toContainText('対象資産総額');
  await expect(page.locator('#ideal-summary')).toContainText('¥821,285');
  await expect(page.locator('#ideal-summary')).toContainText('保有確認前');
  await expect(page.locator('#ideal-table')).toContainText('理想株数（整数）');
  await expect(page.locator('#ideal-table')).toContainText('PLTR');
  await expect(page.locator('#ideal-table')).toContainText('NVDA');
  await expect(page.locator('#ideal-table')).toContainText('¥246,386');
  await expect(page.locator('#rebalance-state')).toContainText('計算保留');
  await expect(page.locator('#trade-board')).toBeEmpty();
  await expect(page.locator('#allocation-charts')).toBeEmpty();
  await expect(page.locator('#rebalance-table')).toBeEmpty();
  await expect(page.locator('#csv-export')).toBeDisabled();
  await page.goto('/portfolio_manager.html#overview');
  await expect(page.locator('#trust-status')).toContainText('未確認の保有ロット');
  await expect(page.locator('#confirm-holdings')).toBeDisabled();
  expect(runtimeErrors).toEqual([]);
});
