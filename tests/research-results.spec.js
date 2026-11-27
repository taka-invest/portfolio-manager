'use strict';
// Market view: the research card reads the owner's result (stubbed, synthetic) and
// switches horizon/currency; without a stored result or sign-in it says so.
const { test, expect } = require('@playwright/test');

const KEYS = ['S1', 'S2', 'S3', 'S4'];
const cell = (k, i, ccy) => ({
  median: (ccy === 'jpy' ? 0.1 : 0.2) - i * 0.01, positive: 1, q05: -0.1, min: -0.2, medianMae: -0.05, lagMedian: i * 5,
  ...(k === 'S1' ? {} : { diffVsS1: { median: -0.01, mean: -0.01 * i, better: 0, worse: 1,
    meanCI95: k === 'S3' ? [-0.2, -0.01] : [-0.05, 0.03], medianCI95: [-0.05, 0.03] } })
});
const horizon = () => {
  const h = { events: 1 };
  KEYS.forEach((k, i) => { h[k] = { jpy: cell(k, i, 'jpy'), usd: cell(k, i, 'usd') }; });
  return h;
};
const eventRow = () => {
  const strategies = {};
  for (const k of KEYS) strategies[k] = { firstFill: '2008-09-16', signalFired: true, 60: { jpy: -0.1, usd: -0.2 }, 120: { jpy: -0.1, usd: -0.2 }, 250: { jpy: -0.1, usd: -0.2 } };
  return { t0: '2008-09-15', vix: 31.7, strategies };
};
const result = {   // synthetic: the real results never enter this public repository
  version: 'p0b-1', dates: ['1990-01-02', '2026-11-24'], eventCount: 2, computedAt: '2026-11-27T00:00:00+00:00', assumptions: ['合成データ'],
  summary: { 60: horizon(), 120: horizon(), 250: horizon() },
  perEvent: [eventRow()]
};

async function open(page, cloud) {
  await page.addInitScript(cloud);
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.fulfill({ status: 503, json: {} }));
  await page.goto('/portfolio_manager.html#market');
}

test('shows the stored result with verdicts, and switches horizon and currency', async ({ page }) => {
  await open(page, `window.PMCloud = { idToken: async () => 'h.p.s', readResearch: async id => id === 'vix-event-study' ? { json: ${JSON.stringify(JSON.stringify(result))} } : null };`);
  const card = page.locator('#research-vix');
  await expect(card).toContainText('VIX≥30の局面 2回');
  await expect(card.locator('tr[data-strategy="S3"]')).toContainText('不利（差あり）');
  await expect(card.locator('tr[data-strategy="S2"]')).toContainText('差があるとは言えない');
  await expect(card.locator('tr[data-strategy="S1"]')).toContainText('+10.0%');               // 120日・円建て（既定）
  await card.getByRole('button', { name: 'ドル建て' }).click();
  await expect(card.locator('tr[data-strategy="S1"]')).toContainText('+20.0%');
  await card.getByRole('button', { name: '250営業日後' }).click();
  await expect(card.getByRole('button', { name: '250営業日後' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card).toContainText('売買の推奨ではない');
});

test('signed out (no reader) or no stored result: the card explains instead of showing numbers', async ({ page }) => {
  await open(page, `window.PMCloud = { idToken: async () => null };`);
  await expect(page.locator('#research-vix')).toContainText('ログイン後に表示');
  await expect(page.locator('#research-vix table')).toHaveCount(0);
});
