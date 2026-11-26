'use strict';

const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');
const url = '/portfolio_manager.html';
const legacy = {
  id: 'fixture-sample', ticker: 'PLTR', layer: 1, buyPrice: 1500, curPrice: 25000, shares: 1021, note: '旧サンプル'
};
const close = Date.parse('2026-11-20T21:00:00Z') / 1000;

async function mockMarket(page) {
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  const settings = { rate: 150, price: 100, failFx: false, failStock: false };
  const external = [];
  await page.route('**/*', async route => {
    const request = new URL(route.request().url());
    if (request.hostname === '127.0.0.1') return route.continue();
    external.push({ host: request.hostname, path: request.pathname });
    // Order-grade spot USD/JPY (③ refuses the daily ECB reference).
    if (request.hostname === 'www.live-rates.com' && !settings.failFx) {
      return route.fulfill({ json: [{ currency: 'USD/JPY', bid: settings.rate - 0.005, ask: settings.rate + 0.005, timestamp: Date.parse('2026-11-22T12:00:00Z') }] });
    }
    if (request.hostname === 'api.frankfurter.dev' && !settings.failFx) {
      return route.fulfill({ json: { base: 'USD', quote: 'JPY', date: '2026-11-20', rate: settings.rate } });
    }
    if (request.hostname === 'finnhub.io') {
      if (request.pathname.endsWith('/profile2')) return route.fulfill({ json: {} });
      if (request.pathname.endsWith('/quote') && !settings.failStock) {
        return route.fulfill({ json: { c: settings.price, t: close } });
      }
      if (request.pathname.endsWith('/earnings')) return route.fulfill({ json: { earningsCalendar: [{ date: '2027-01-25' }] } });
    }
    return route.fulfill({ status: 503, json: {} });
  });
  return { settings, external };
}

async function verifyNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth)
  );
}

async function show(page, id) {
  await page.evaluate(target => { window.location.hash = '#' + target; }, id);
  await expect(page.locator('#' + id)).toBeVisible();
}

async function addLot(page, details) {
  await page.getByRole('button', { name: '＋ ロットを登録' }).click();
  const form = page.locator('#lot-form');
  await form.locator('[name=ticker]').fill(details.ticker);
  await form.locator('[name=shares]').fill(details.shares);
  await form.locator('[name=kind]').selectOption(details.kind ?? 'stock');
  await form.locator('[name=broker]').fill('架空証券');
  // Account names are optional; US stock accounts are always 特定 in this UI.
  if ((details.kind ?? 'stock') === 'stock') {
    await expect(form.locator('[name=account]')).toHaveAttribute('type', 'hidden');
    await expect(form.locator('#lot-stock-type input')).toHaveValue('特定（固定）');
  } else {
    await form.locator('[name=accountType]').selectOption(details.type ?? 'nisa');
  }
  await form.locator('[name=currency]').selectOption('USD');
  await form.locator('[name=unitCost]').fill('10');
  await form.locator('[name=costJpy]').fill(details.cost ?? '40000');
  await form.getByRole('button', { name: 'ロットを保存' }).click();
  await expect(page.locator('#lot-dialog')).not.toBeVisible();
}

test('fresh start, market updates, verified lots, exports and responsive layout', async ({ page }, testInfo) => {
  const { settings } = await mockMarket(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  await expect(page.locator('#market-status')).toContainText('利用可');
  await expect(page.locator('#holdings-aggregate')).toContainText('未登録');
  await expect(page.locator('#rebalance-state')).toContainText('計算保留');
  await expect(page.locator('#csv-export')).toBeDisabled();
  await verifyNoOverflow(page);

  await page.locator('#data-settings summary').first().click();
  await page.locator('#s-api-key').fill('fixture-only');
  await page.getByRole('button', { name: 'Finnhubキーを保存して更新' }).click();
  await expect(page.locator('#target-rows')).toContainText('$100');
  await expect(page.locator('#target-rows')).toContainText('発行体未確認');
  await page.locator('#data-settings summary').first().click();

  await show(page, 'holdings');
  await addLot(page, { ticker: 'NVDA', shares: '5', account: '口座A' });
  await addLot(page, { ticker: 'NVDA', shares: '2', account: '口座B', type: 'nisa', cost: '30000' });
  await addLot(page, { ticker: 'FUND01', shares: '10000', account: '投信', type: 'nisa', kind: 'fund' });
  await expect(page.locator('#holdings-aggregate tbody tr')).toHaveCount(1);
  await expect(page.locator('#holdings-aggregate tbody tr td').nth(1)).toHaveText('7');
  await expect(page.locator('#holdings-lots')).toContainText('積立NISA投信');
  await show(page, 'overview');
  await page.locator('#cash-jpy').fill('250000');
  await page.locator('#cash-usd').fill('100');
  await page.locator('#cash-extra').fill('40000');
  await expect(page.locator('#confirm-holdings')).toBeDisabled();
  await page.getByRole('button', { name: '現金を保存' }).click();
  await page.locator('#confirm-holdings').click();
  await expect(page.locator('#trust-status')).toHaveText('実保有・現金確認済み');
  await expect(page.locator('#summary-row')).toContainText('¥370,000');
  await show(page, 'rebalance');
  await expect(page.locator('#rebalance-table')).toContainText('監視・価格待ち');
  await expect(page.locator('#post-table')).toContainText('現金');
  await verifyNoOverflow(page);
  await page.locator('#execution-breakdown > summary').click();
  await expect(page.locator('#rebalance-table')).toBeVisible();
  await expect(page.locator('#rebalance-table')).toHaveJSProperty('tabIndex', 0);

  const before = await page.evaluate(key => localStorage.getItem(key), D.KEY);
  settings.rate = 160;
  settings.price = 105;
  await show(page, 'overview');
  await page.locator('#price-update').click();
  await expect(page.locator('#holdings-aggregate')).toContainText('¥117,600');
  expect(await page.evaluate(key => localStorage.getItem(key), D.KEY)).toEqual(before);
  await show(page, 'rebalance');

  const fileEvent = page.waitForEvent('download');
  await page.locator('#csv-export').click();
  const download = await fileEvent;
  expect(download.suggestedFilename()).toBe('portfolio-rebalance.csv');
  const fs = require('node:fs/promises');
  expect(await fs.readFile(await download.path(), 'utf8')).toContain('売買額（ドル）');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('portfolio.png'), fullPage: true });
  settings.failFx = true;
  await show(page, 'overview');
  await page.locator('#price-update').click();
  await expect(page.locator('#rebalance-state')).toContainText('USD/JPYの有効な参考レートがありません');
  await expect(page.locator('#csv-export')).toBeDisabled();
  await expect(page.locator('#rebalance-table table')).toHaveCount(0);
  settings.failFx = false;
  settings.failStock = true;
  await page.locator('#price-update').click();
  await expect(page.locator('#rebalance-state')).toContainText('NVDAの株価を確認できません');
  expect(errors).toEqual([]);
});

test('old browser and cloud data require explicit preview, and replacement can be restored', async ({ page }) => {
  const { external } = await mockMarket(page);
  const actual = { ...legacy, id: 'fixture-nvda', ticker: 'NVDA', shares: 4, note: '<h1>メモ</h1>' };
  await page.addInitScript(({ actual, legacy }) => {
    localStorage.setItem('pm_positions', JSON.stringify([actual, legacy]));
    localStorage.setItem('pm_jb_bin', '000000000000000000000000');
    localStorage.setItem('pm_jb_key', 'fixture-only');
  }, { actual, legacy });
  await page.goto(url);
  await page.locator('#data-settings summary').first().click();
  await page.locator('#data-local').click();
  await expect(page.locator('#data-diff')).toContainText('旧サンプル 1 件');
  await expect(page.locator('#data-diff')).toContainText('NVDA');
  await expect(page.locator('#data-diff')).not.toContainText('PLTR /');
  expect(await page.evaluate(key => localStorage.getItem(key), D.KEY)).toBeNull();
  await page.locator('#data-review').getByRole('button', { name: 'キャンセル' }).click();
  await expect(page.locator('#holdings-lots')).not.toContainText('NVDA');
  await page.locator('#data-local').click();
  await page.locator('#data-accept').click();
  await expect(page.locator('#holdings-lots')).toContainText('<h1>メモ</h1>');
  await expect(page.locator('#holdings-lots h1')).toHaveCount(0);
  await expect(page.locator('#confirm-holdings')).toBeDisabled();

  await page.locator('#data-settings details summary').click();
  await page.locator('#cloud-load').click();
  await expect(page.locator('#data-notice')).toContainText('接続を許可');
  expect(external.some(request => request.host === 'api.jsonbin.io')).toBe(false);

  await page.locator('#data-upload').setInputFiles({ name: 'valid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(D.blank())) });
  await expect(page.locator('#data-diff')).toContainText('− NVDA');
  await page.locator('#data-accept').click();
  await expect(page.locator('#holdings-lots')).not.toContainText('NVDA');
  await page.locator('#data-previous').click();
  await page.locator('#data-accept').click();
  await expect(page.locator('#holdings-lots')).toContainText('NVDA');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pm_positions')).length)).toBe(2);
});

test('valuation scenarios and typed observations persist across reload', async ({ page }) => {
  await mockMarket(page);
  await page.goto(url);
  await show(page, 'companies');
  await page.locator('#company-edit').click();
  await page.locator('#company-form [name=thesis]').fill('架空の保有仮説');
  await page.locator('#company-form [name=base]').fill('架空の標準シナリオ');
  await page.locator('#company-form').getByRole('button', { name: '保存' }).click();
  await page.locator('#company-observe').click();
  await page.locator('#observation-form [name=kind]').selectOption('personal');
  await page.locator('#observation-form [name=value]').fill('10%');
  await page.locator('#observation-form [name=period]').fill('2028年');
  await page.locator('#observation-form').getByRole('button', { name: '保存' }).click();
  await page.reload();
  await expect(page.locator('#company-table')).toContainText('独自予測');
  await expect(page.locator('#company-table')).toContainText('2028年');
  await expect(page.locator('#company-thesis')).toHaveText('架空の保有仮説');
  await verifyNoOverflow(page);
});

test('corrupted workspace can be restored without discarding its raw data', async ({ page }) => {
  await mockMarket(page);
  await page.addInitScript(({ key, backup, value }) => {
    if (!sessionStorage.seeded) {
      localStorage.setItem(key, '{invalid');
      localStorage.setItem(backup, value);
      sessionStorage.seeded = 'yes';
    }
  }, { key: D.KEY, backup: D.BACKUP, value: JSON.stringify(D.blank()) });
  await page.goto(url);
  await expect(page.locator('#trust-status')).toContainText('バックアップを復元できます');
  await page.locator('#data-settings summary').first().click();
  await page.locator('#data-previous').click();
  await expect(page.locator('#data-diff')).toContainText('差分を表示できません');
  await page.locator('#data-accept').click();
  await expect(page.locator('#trust-status')).toContainText('保有ロットと現金を入力');
  expect(await page.evaluate(key => localStorage.getItem(key + '_invalid'), D.KEY)).toBe('{invalid');
});
