'use strict';
// Phase 7: new screens in dark and light themes, theme persists across reload,
// and every route survives a reload (deep link) without errors or horizontal scroll.
const { test, expect } = require('@playwright/test');

async function stub(page) {
  await page.clock.setFixedTime(new Date('2026-11-24T03:00:00Z'));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' && !url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 401, json: { error: 'Google login required' } });
    return route.fulfill({ status: 503, json: {} });
  });
}
const routes = ['overview', 'holdings', 'rebalance', 'analysis', 'companies', 'screener', 'market', 'chart', 'research', 'history', 'data-settings'];

test('every route reloads cleanly (deep link) in both themes without overflow or page errors', async ({ page }) => {
  await stub(page);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/portfolio_manager.html#overview');
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const darkBg = await bg();
  await page.locator('#theme-toggle').click();
  await expect(page.locator('body')).toHaveClass(/light/);
  await expect.poll(bg).not.toBe(darkBg);   // background has a 0.2s transition
  for (const theme of ['light', 'dark']) {
    for (const r of routes) {
      await page.goto('/portfolio_manager.html#' + r);
      await page.reload();
      expect(await page.evaluate(() => document.body.classList.contains('light'))).toBe(theme === 'light');
      const id = r === 'data-settings' ? 'overview' : r === 'rebalance' ? 'rebalance' : r;
      await expect(page.locator('#' + id)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
    }
    if (theme === 'light') await page.locator('#theme-toggle').click();
  }
  expect(errors).toEqual([]);
});

test('light theme: analysis/screener/chart text keeps readable contrast against the background', async ({ page }) => {
  await stub(page);
  await page.goto('/portfolio_manager.html#analysis');
  await page.locator('#theme-toggle').click();
  await expect(page.locator('body')).toHaveClass(/light/);
  for (const r of ['analysis', 'screener', 'chart']) {
    await page.goto('/portfolio_manager.html#' + r);
    await page.waitForTimeout(300);
    const ratio = await page.evaluate(id => {
      const lum = c => { const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const h = document.querySelector('#' + id + ' h2');
      const fg = lum(getComputedStyle(h).color), bg = lum(getComputedStyle(document.body).backgroundColor);
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    }, r);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
});
