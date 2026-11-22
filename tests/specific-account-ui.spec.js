'use strict';
const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');

test('PC: existing stock account is 特定 without entering an account name', async ({ page }, info) => {
  test.skip(info.project.name !== 'PC', 'PC desktop app');
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  const state = { ...D.blank(), confirmed: false,
    positions: [{
      id: 'sample-pltr', ticker: 'PLTR', kind: 'stock', broker: 'マネックス証券',
      account: '', accountType: 'unknown', shares: 10, currency: 'USD',
      unitCost: 10, costJpy: 15000, referenceJpy: null, layer: 1, note: 'test'
    }],
    cash: { jpy: 10000, usd: 0, extraJpy: 0, extraIncluded: true } };
  await page.addInitScript(({key, value}) => {
    localStorage.setItem(key, JSON.stringify(value));
    localStorage.setItem('pm_api_key', 'fixture');
  }, { key: D.KEY, value: state });
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (u.hostname === 'api.frankfurter.dev')
      return route.fulfill({ json: { base: 'USD', quote: 'JPY', date: '2026-11-20', rate: 150 } });
    if (u.hostname === 'finnhub.io') {
      if (u.pathname.endsWith('/quote')) return route.fulfill({ json: {
        c: 100, t: Date.parse('2026-11-20T21:00:00Z') / 1000 } });
      if (u.pathname.endsWith('/profile2')) return route.fulfill({ json: {} });
      if (u.pathname.endsWith('/calendar/earnings')) return route.fulfill({ json: { earningsCalendar: [] } });
    }
    return route.fulfill({ status: 503, json: {} });
  });
  const browserErrors = [];
  page.on('pageerror', e => browserErrors.push(e.message));
  await page.goto('/portfolio_manager.html#overview');
  await expect(page.locator('#trust-status')).not.toContainText('口座名');
  await expect(page.locator('#trust-status')).not.toContainText('未確認の保有ロット');
  await expect(page.locator('#confirm-holdings')).toBeEnabled();
  await page.goto('/portfolio_manager.html#holdings');
  const row = page.locator('#holdings-lots tr').filter({hasText:'PLTR'}).last();
  await expect(row).toContainText('特定');
  await row.getByRole('button', {name:'編集'}).click();
  const modal = page.locator('#lot-dialog');
  await expect(modal).toBeVisible();
  await expect(modal.locator('input[name="account"]')).toHaveAttribute('type', 'hidden');
  await expect(modal.locator('#lot-stock-type input')).toHaveValue('特定（固定）');
  await expect(modal.locator('#lot-other-type')).toBeHidden();
  await modal.getByRole('button', {name:'ロットを保存'}).click();
  await expect(modal).not.toBeVisible();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), D.KEY);
  expect(saved.positions[0].account).toBe('');
  expect(saved.positions[0].accountType).toBe('specific');
  expect(saved.positions[0].costJpy).toBe(15000);
  expect(browserErrors).toEqual([]);
});
