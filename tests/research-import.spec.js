'use strict';
const { test, expect } = require('@playwright/test');

test('legacy watchlist: preview, dedupe, explicit confirmation, persistence, no portfolio edits', async ({ page }) => {
  await page.route('**/*', route =>
    new URL(route.request().url()).hostname === '127.0.0.1'
      ? route.continue() : route.fulfill({ status: 503, json: {} }));
  await page.goto('/portfolio_manager.html#research');
  const before = await page.evaluate(() => {
    const s = PMApp.state();
    return { positions: JSON.stringify(s.positions), targets: JSON.stringify(s.targets),
      cash: JSON.stringify(s.cash), stagedFunding: JSON.stringify(s.stagedFunding) };
  });
  const area = page.locator('#pm-research-legacy-json');
  const accept = page.locator('#pm-research-accept');
  await expect(accept).toBeDisabled();
  await area.fill('["pltr","NVDA","PLTR","AVGO"]');
  await page.getByRole('button', { name: '差分を確認' }).click();
  await expect(page.locator('#pm-research-import-status')).toContainText('追加 3銘柄');
  await expect(accept).toBeEnabled();
  await area.fill('["XSS<script>"]');
  await expect(accept).toBeDisabled();
  await page.getByRole('button', { name: '差分を確認' }).click();
  await expect(page.locator('#pm-research-import-status')).toContainText('読み込みエラー');

  await area.fill('["PLTR","NVDA","PLTR","AVGO"]');
  await page.getByRole('button', { name: '差分を確認' }).click();
  await accept.click();
  await expect(page.locator('#pm-research-import-status')).toContainText('3銘柄を追加');
  await expect(accept).toBeDisabled();
  let snapshot=await page.evaluate(() => {
    const s=PMApp.state();
    return { tickers:s.watchlist.map(w=>w.ticker),positions:JSON.stringify(s.positions),
      targets:JSON.stringify(s.targets),cash:JSON.stringify(s.cash),
      stagedFunding:JSON.stringify(s.stagedFunding) };
  });
  expect(snapshot.tickers).toEqual(['PLTR','NVDA','AVGO']);
  for(const key of Object.keys(before)) expect(snapshot[key]).toEqual(before[key]);
  await page.reload();
  await expect(page.locator('#research')).toBeVisible();
  expect(await page.evaluate(() => PMApp.state().watchlist.map(w => w.ticker)))
    .toEqual(['PLTR','NVDA','AVGO']);
  await area.fill('["PLTR","NVDA"]');
  await page.getByRole('button', { name: '差分を確認' }).click();
  await expect(accept).toBeDisabled();
  await expect(page.locator('#pm-research-import-status')).toContainText('追加 0銘柄');
});
