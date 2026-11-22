'use strict';

const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');

test('dashboard displays provisional target assets and names incomplete lots without enabling trades', async ({ page }, info) => {
  test.skip(info.project.name !== 'PC', 'PC-first dashboard regression');
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  const draft = {
    ...D.blank(),
    confirmed: false,
    cash: { jpy: 671285, usd: 0, extraJpy: 0, extraIncluded: true },
    positions: [{
      id: 'lot-1', ticker: 'PLTR', kind: 'stock', broker: '',
      account: '', accountType: 'unknown', layer: 1, shares: 10,
      currency: 'USD', unitCost: 15, costJpy: 20000,
      referenceJpy: null, note: ''
    }]
  };
  await page.addInitScript(({key, state}) => {
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem('pm_api_key', 'fixture');
  }, { key: D.KEY, state: draft });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'api.frankfurter.dev') {
      return route.fulfill({ json: { base:'USD', quote:'JPY', date:'2026-11-20', rate:150 } });
    }
    if (url.hostname === 'finnhub.io') {
      if (url.pathname.endsWith('/quote'))
        return route.fulfill({ json: { c: 100, t: Date.parse('2026-11-20T21:00:00Z') / 1000 } });
      if (url.pathname.endsWith('/profile2')) return route.fulfill({ json: {} });
      if (url.pathname.endsWith('/calendar/earnings')) return route.fulfill({ json: { earningsCalendar: [] } });
    }
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/portfolio_manager.html#overview');
  await expect(page.locator('#summary-row')).toContainText('対象資産（概算）');
  await expect(page.locator('#summary-row')).toContainText('¥821,285');
  await expect(page.locator('#trust-status')).toContainText('未確認の保有ロット 1件');
  await expect(page.locator('#trust-status')).toContainText('PLTR（証券会社未設定）');
  await expect(page.locator('#confirm-holdings')).toBeDisabled();
  await expect(page.locator('#rebalance-state')).toContainText('計算保留');
  await expect(page.locator('#trade-board')).toBeEmpty();
  await expect(page.locator('#csv-export')).toBeDisabled();
});
