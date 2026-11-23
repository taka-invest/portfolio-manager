'use strict';

const { test, expect } = require('@playwright/test');

test('research: hash route opens migrated library and returns to company evaluation', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // No paid third-party services or real portfolio are needed for this test.
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 200, body: '', contentType: 'text/javascript' });
  });
  await page.goto('/portfolio_manager.html#research');
  await expect(page.locator('#research')).toBeVisible();
  await expect(page.locator('#rebalance')).toBeHidden();
  await expect(page.getByRole('link', { name: '投資リサーチ' })).toHaveAttribute('aria-current', 'page');
  const originalWorkspace = await page.evaluate(() => localStorage.getItem('pm_workspace_v3'));
  await page.getByRole('link', { name: '投資指標ライブラリを開く' }).click();
  await expect(page).toHaveURL(/\/research\/library\.html$/);
  await expect(page.getByRole('heading', { name: '投資指標ライブラリ', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /株価インパクト ピラミッド/ })).toBeVisible();
  await page.getByRole('link', { name: /アプリに戻る/ }).first().click();
  await expect(page).toHaveURL(/\/portfolio_manager\.html#companies$/);
  await expect(page.locator('#companies')).toBeVisible();
  const afterWorkspace = await page.evaluate(() => localStorage.getItem('pm_workspace_v3'));
  expect(afterWorkspace).toBe(originalWorkspace);
  expect(errors).toEqual([]);
});

test('research: direct navigation is usable on mobile without touching existing allocation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'スマホ', 'Mobile-only');
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 200, body: '', contentType: 'text/javascript' });
  });
  await page.goto('/portfolio_manager.html#research');
  await expect(page.locator('#research')).toBeVisible();
  await page.getByRole('link', { name: '投資指標ライブラリを開く' }).click();
  await expect(page.getByRole('heading', { name: '投資指標ライブラリ', exact: true })).toBeVisible();
});
