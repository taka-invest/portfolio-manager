'use strict';

const { test, expect } = require('@playwright/test');
const url = '/portfolio_manager.html';

async function stubExternal(page) {
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 503, json: {} });
  });
}
async function noHorizontalOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth)
  );
}

test('desktop: six routes, rebalance subtabs, history, preference and in-progress fields', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'PC', 'Desktop-only sidebar layout');
  await stubExternal(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const nav = page.getByRole('navigation', { name: '主要機能' });
  await expect(page.locator('#overview')).toBeVisible();
  await expect(page.locator('#holdings')).toBeHidden();
  await expect(page.locator('#market')).toBeHidden();
  await expect(nav.getByRole('link', { name: 'ダッシュボード' })).toHaveAttribute('aria-current', 'page');

  // Unsaved form values stay in the mounted DOM when switching views.
  await page.locator('#cash-jpy').fill('12345');
  await nav.getByRole('link', { name: '保有資産' }).click();
  await expect(page).toHaveURL(/#holdings$/);
  await expect(page.locator('#holdings')).toBeVisible();
  await expect(page.locator('#overview')).toBeHidden();
  await nav.getByRole('link', { name: 'リバランス' }).click();
  await expect(page.locator('#allocation')).toBeVisible();
  await expect(page.locator('#rebalance')).toBeVisible();
  await expect(page.locator('#after')).toBeVisible();
  await expect(page.locator('#pm-rebalance-subnav')).toBeVisible();
  await page.getByRole('navigation', { name: 'リバランス内の移動' }).getByRole('link', { name: /売買後構成/ }).click();
  await expect(page).toHaveURL(/#after$/);
  await expect(nav.getByRole('link', { name: 'リバランス' })).toHaveAttribute('aria-current', 'page');

  await nav.getByRole('link', { name: '市場分析' }).click();
  await expect(page.locator('#market')).toBeVisible();
  await expect(page.locator('#rebalance')).toBeHidden();
  await nav.getByRole('link', { name: '企業評価' }).click();
  await expect(page.locator('#companies')).toBeVisible();
  await nav.getByRole('link', { name: '取引・購入計画' }).click();
  await expect(page.locator('#history')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#companies')).toBeVisible();
  await nav.getByRole('link', { name: 'ダッシュボード' }).click();
  await expect(page.locator('#cash-jpy')).toHaveValue('12345');

  await page.getByRole('button', { name: 'サイドバーを折りたたむ' }).click();
  await expect(page.locator('#pm-app-frame')).toHaveClass(/pm-nav-collapsed/);
  expect(await page.evaluate(() => localStorage.getItem('pm_sidebar_collapsed_v1'))).toBe('true');
  await page.reload();
  await expect(page.locator('#pm-app-frame')).toHaveClass(/pm-nav-collapsed/);
  await page.getByRole('button', { name: 'サイドバーを展開' }).click();
  await expect(page.locator('#pm-app-frame')).not.toHaveClass(/pm-nav-collapsed/);
  await noHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test('direct links and settings: reload and nested anchor route', async ({ page }) => {
  await stubExternal(page);
  await page.goto(url + '#rebalance');
  await expect(page.locator('#rebalance')).toBeVisible();
  await expect(page.locator('#allocation')).toBeVisible();
  await page.goto(url + '#data-settings');
  await expect(page.locator('#overview')).toBeVisible();
  await expect(page.locator('#data-settings')).toHaveJSProperty('open', true);
  await expect(page.locator('#pm-side-nav a[href="#data-settings"]')).toHaveAttribute('aria-current', 'page');
  await noHorizontalOverflow(page);
});

test('mobile: drawer, overlay, Escape and selection', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'スマホ', 'Mobile-only drawer layout');
  await stubExternal(page);
  await page.goto(url + '#holdings');
  const sidebar = page.locator('#pm-side-nav');
  const trigger = page.getByRole('button', { name: 'メニューを開く' });
  await expect(trigger).toBeVisible();
  await expect(sidebar).toHaveJSProperty('inert', true);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(sidebar).toHaveJSProperty('inert', false);
  await expect(page.locator('#pm-nav-scrim')).toBeVisible();
  await sidebar.getByRole('link', { name: 'リバランス' }).click();
  await expect(page.locator('#allocation')).toBeVisible();
  await expect(page.locator('#holdings')).toBeHidden();
  await expect(page.locator('#pm-nav-scrim')).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pm-nav-scrim')).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator('#pm-nav-scrim').click({ position: { x: 320, y: 100 } });
  await expect(page.locator('#pm-nav-scrim')).toBeHidden();
  await noHorizontalOverflow(page);
});
