'use strict';
// Screen-level guards for the owner's fixed rules (see tests/fixed-rules.test.js for the math).
const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');

const lot = (id, ticker, shares, extra = {}) => ({ id, ticker, kind: 'stock', broker: '架空証券', account: '',
  accountType: 'specific', shares, currency: 'USD', unitCost: 10, costJpy: shares * 1500, referenceJpy: null,
  layer: 1, note: '', ...extra });

async function open(page, saved, hash, extraStorage = {}) {
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  await page.addInitScript(({ key, saved, extraStorage }) => {
    if (sessionStorage.getItem('seeded')) return;          // seed once; keep app writes across reloads
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(key, JSON.stringify(saved));
    for (const [k, v] of Object.entries(extraStorage)) localStorage.setItem(k, v);
  }, { key: D.KEY, saved, extraStorage });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.fulfill({ status: 503, json: {} }));
  page.on('dialog', d => d.accept());
  await page.goto('/portfolio_manager.html' + hash);
}
const stored = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), D.KEY);

test('edited weights are flagged and "固定仕様に戻す" restores them; weights are read-only', async ({ page }) => {
  const b = D.blank();
  await open(page, { ...b, cashTarget: 12, targets: b.targets.map(t => t.ticker === 'PLTR' ? { ...t, pct: 18 } : t) }, '#allocation');
  await expect(page.locator('#target-spec')).toBeVisible();
  await expect(page.locator('#target-spec-text')).toContainText('PLTRの目標比率は30%');
  await expect(page.locator('#target-rows [data-field="pct"]').first()).toHaveAttribute('readonly', '');
  await page.locator('#target-spec-fix').click();
  await expect(page.locator('#target-spec')).toBeHidden();
  const s = await stored(page);
  expect(s.targets.find(t => t.ticker === 'PLTR').pct).toBe(30);
  expect(s.cashTarget).toBe(10);
});

test('staged stage lives in the synced plan; advancing without fills is recorded as "not bought"', async ({ page }) => {
  const b = D.blank();
  const saved = { ...b, confirmed: true, positions: [lot('p', 'PLTR', 100), lot('n', 'NVDA', 5)],
    cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true },
    stagedFunding: { startedAt: '2026-11-21T00:00:00.000Z', baselineShares: { NVDA: 5, AVGO: 0, CRDO: 0 }, stage: 1, stageLog: [] } };
  await open(page, saved, '#rebalance', { 'pm-staged-funding-stage': '3' });
  await expect(page.locator('#pm-staged-funding-stage')).toHaveText('A日：累積50%');   // old per-browser "C" is not used
  expect(await page.evaluate(() => localStorage.getItem('pm-staged-funding-stage'))).toBeNull();
  await page.locator('#pm-staged-advance').click();
  await expect(page.locator('#pm-staged-funding-stage')).toHaveText('B日：累積80%');
  const plan = (await stored(page)).stagedFunding;
  expect(plan.stage).toBe(2);
  expect(plan.stageLog[0]).toMatchObject({ stage: 1, skipped: true, shares: { NVDA: 5, AVGO: 0, CRDO: 0 } });
  await page.reload();
  await expect(page.locator('#pm-staged-funding-stage')).toHaveText('B日：累積80%');
});

test('editing a NISA-tagged stock lot keeps its account type', async ({ page }) => {
  const b = D.blank();
  await open(page, { ...b, positions: [lot('nisa-lot', 'NVDA', 3, { accountType: 'nisa' })] }, '#holdings');
  await page.locator('[data-lot="nisa-lot"]').click();
  await expect(page.locator('#lot-stock-type input')).toHaveValue('NISA（登録済み・保持）');
  await page.locator('#lot-form [name=note]').fill('メモだけ変更');
  await page.locator('#lot-form').getByRole('button', { name: 'ロットを保存' }).click();
  await expect(page.locator('#lot-dialog')).not.toBeVisible();
  const p = (await stored(page)).positions[0];
  expect(p.accountType).toBe('nisa');
  expect(p.note).toBe('メモだけ変更');
});
