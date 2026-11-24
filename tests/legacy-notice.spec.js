'use strict';
// Phase 8: the old GitHub Pages URL shows a migration notice; the new URL does not.
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join, normalize } = require('node:path');
const root = join(__dirname, '..');

test('old GitHub Pages host shows the migration notice with the new URL; no auto-redirect', async ({ page }) => {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'taka-invest.github.io') {
      const rel = normalize(decodeURIComponent(url.pathname.replace(/^\/portfolio-manager\//, ''))).replace(/^[\/]+/, '') || 'portfolio_manager.html';
      const type = rel.endsWith('.js') || rel.endsWith('.mjs') ? 'text/javascript' : rel.endsWith('.css') ? 'text/css' : 'text/html';
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(join(root, rel)) }); }
      catch { return route.fulfill({ status: 404, body: '' }); }
    }
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('https://taka-invest.github.io/portfolio-manager/portfolio_manager.html');
  const notice = page.locator('#pm-legacy-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('このURLは旧版です');
  await expect(notice.getByRole('link')).toHaveAttribute('href', 'https://finance-base-edcc7.web.app/');
  await expect(page).toHaveURL(/taka-invest\.github\.io/);   // stays: data must be exported first
});

test('new/local host shows no migration notice', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.fulfill({ status: 503, json: {} }));
  await page.goto('/portfolio_manager.html');
  await expect(page.locator('#overview')).toBeVisible();
  await expect(page.locator('#pm-legacy-notice')).toHaveCount(0);
});
