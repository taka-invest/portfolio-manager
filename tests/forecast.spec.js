'use strict';
// Analysis screen: consensus row + own-assumption row above the actual quarters,
// visually separate, with the next report shown and the own assumption saved per ticker.
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const fx = f => readFileSync(join(__dirname, 'fixtures', f), 'utf8');
const lw = () => readFileSync(join(__dirname, '..', 'research/vendor/lightweight-charts-4.2.0.standalone.production.js'));

async function open(page, outlook) {
  await page.addInitScript(() => { window.PMCloud = { idToken: async () => 'header.payload.sig' }; });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/analyze') {
      const body = JSON.parse(fx('legacy-analyze-PLTR.json'));
      return route.fulfill({ status: 200, json: { ...body, outlook } });
    }
    if (url.pathname === '/api/market') return route.fulfill({ status: 200, contentType: 'application/json', body: fx('chart-PLTR-5y-1wk.json') });
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'cdn.tailwindcss.com') return route.continue().catch(() => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    return route.fulfill({ status: 503, body: '' });
  });
  await page.goto('/research/index.html');
  const input = page.locator('input[type=text]').first();
  await input.fill('PLTR');
  await input.press('Enter');
  await page.locator('#tab-chart').click({ timeout: 15000 });          // the trend table is on the チャート tab
  await expect(page.locator('#pm-forecast-panel')).toBeVisible();
}

// Tests run without the Tailwind CDN (unstyled layout); on the phone profile the unstyled
// page keeps shifting while charts size, so buttons are activated directly. The real
// styled phone layout is checked on the preview channel.
const press = locator => locator.evaluate(el => el.click());
const OUTLOOK = { next: { date: '2027-02-02', hour: 'amc', fiscalYear: 2026, fiscalQuarter: 4, epsEstimate: 0.25, revenueEstimateM: 2450 },
  epsHistory: [{ period: '2026-09-30', epsActual: 0.21, epsEstimate: 0.17, surprisePct: 23.5 }],
  source: { provider: 'Finnhub（アナリスト予想の平均）', retrievedAt: '2026-11-26T00:00:00Z' } };

test('consensus row sits above the actuals, separate from them, and the next report is shown', async ({ page }, info) => {
  await open(page, OUTLOOK);
  const rows = page.locator('#pm-trend-wrap tbody tr');
  await expect(rows.first()).toHaveAttribute('data-kind', 'consensus');
  await expect(rows.first()).toContainText('2026 Q4（予）');
  await expect(rows.first()).toContainText('$2.45B');
  await expect(rows.nth(1)).toContainText('2026 Q3');               // first actual stays as it was
  await expect(rows.nth(1)).not.toHaveClass(/pm-forecast-row/);
  const panel = page.locator('#pm-forecast-panel');
  await expect(panel).toContainText('次回決算 2027-02-02（引け後）');
  await expect(panel).toContainText('EPSサプライズ');
  await expect(panel).toContainText('+23.5%');
  await page.locator('#pm-trend-wrap').screenshot({ path: `test-results/forecast-${info.project.name}.png` });
});

test('own assumption adds a scored row, survives a re-render and can be cleared', async ({ page }) => {
  await open(page, OUTLOOK);
  await page.locator('#pm-own-rev').fill('2600');
  await page.locator('#pm-own-opm').fill('48');
  await press(page.getByRole('button', { name: '自分の想定を反映' }));
  const own = page.locator('#pm-trend-wrap tr[data-kind="own"]');
  await expect(own).toContainText('自分の想定');
  await expect(own).toContainText('$2.60B');
  await expect(page.locator('#pm-own-result')).toContainText('RoF40');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pm_forecast_PLTR')).revM)).toBe(2600);
  await press(page.getByRole('button', { name: '消去' }));
  await expect(own).toHaveCount(0);
});

test('without a server key: no consensus row, the reason is shown, own assumption still works', async ({ page }) => {
  await open(page, { unavailable: 'サーバーにFinnhubキーが未設定です' });
  await expect(page.locator('#pm-trend-wrap tr.pm-forecast-row')).toHaveCount(0);
  await expect(page.locator('#pm-forecast-panel')).toContainText('Finnhubキーが未設定');
  await page.locator('#pm-own-yoy').fill('60');
  await press(page.getByRole('button', { name: '自分の想定を反映' }));
  await expect(page.locator('#pm-trend-wrap tr[data-kind="own"]')).toHaveCount(1);
});
