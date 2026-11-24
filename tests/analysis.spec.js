'use strict';
// 個別企業分析 screen. The API is mocked with output computed from the REAL SEC
// fixture (tests/fixtures/sec/PLTR.json) by the same code the Cloud Function runs.
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

async function apiBody(ticker = 'PLTR', patch = {}) {
  const F = await import('file://' + join(__dirname, '..', 'functions/src/sec/financials.js'));
  const S = await import('file://' + join(__dirname, '..', 'functions/src/sec/scoring.js'));
  const facts = JSON.parse(readFileSync(join(__dirname, 'fixtures/sec', ticker + '.json'), 'utf8'));
  const out = F.analyzeFacts(facts);
  const quote = { price: 159.36, currency: 'USD', asOf: '2026-11-23T21:00:01.000Z', source: 'Yahoo Finance chart API（非公式）' };
  return {
    ticker, cik: '0001321655', name: facts.entityName,
    source: { provider: 'SEC EDGAR XBRL companyfacts', url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001321655.json',
      retrievedAt: '2026-11-24T01:00:00.000Z', currency: 'USD', note: 'US-GAAP（USD）提出企業のみ' },
    quote, quarters: out.quarters.slice(-16), annual: [], latest: out.latest, balance: out.balance,
    evaluation: S.evaluate(out, { ticker, price: quote.price }), definitions: out.definitions,
    status: 'verification-pending', ...patch
  };
}

async function setup(page, { token = true, api } = {}) {
  await page.clock.setFixedTime(new Date('2026-11-24T03:00:00Z'));
  if (token) await page.addInitScript(() => { window.PMCloud = { idToken: async () => 'header.payload.sig' }; });
  const calls = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/financials') {
      calls.push({ ticker: url.searchParams.get('ticker'), auth: route.request().headers().authorization });
      return api ? api(route) : route.fulfill({ status: 404, contentType: 'text/html', body: '<h1>Not Found</h1>' });
    }
    if (url.hostname === '127.0.0.1') return route.continue();
    return route.fulfill({ status: 503, json: {} });
  });
  return calls;
}

test('navigation shows 個別企業分析 and suggests tickers from targets/holdings/watchlist', async ({ page }) => {
  await setup(page);
  await page.goto('/portfolio_manager.html#analysis');
  await expect(page.locator('#analysis')).toBeVisible();
  await expect(page.locator('#overview')).toBeHidden();
  await expect(page.getByRole('link', { name: '個別企業分析' })).toHaveAttribute('aria-current', 'page');
  await page.locator('#pm-analysis-ticker').focus();
  const options = await page.locator('#pm-analysis-tickers option').evaluateAll(o => o.map(x => x.value));
  for (const t of ['NVDA', 'AVGO', 'PLTR', 'APP', 'SOFI', 'CRDO', 'RKLB', 'SPCX']) expect(options).toContain(t);
});

test('not logged in -> clear login message; no request is sent', async ({ page }) => {
  const calls = await setup(page, { token: false });
  await page.goto('/portfolio_manager.html#analysis');
  await page.locator('#pm-analysis-ticker').fill('pltr');
  await page.getByRole('button', { name: '分析する' }).click();
  await expect(page.locator('#pm-analysis-status')).toContainText('Googleログインが必要');
  expect(calls).toHaveLength(0);
});

test('API not deployed (Hosting 404 page) -> "未公開" state, not a crash', async ({ page }) => {
  await setup(page);
  await page.goto('/portfolio_manager.html#analysis');
  await page.locator('#pm-analysis-ticker').fill('NVDA');
  await page.getByRole('button', { name: '分析する' }).click();
  await expect(page.locator('#pm-analysis-status')).toContainText('まだ公開されていません');
  await expect(page.locator('#pm-analysis-result')).toBeEmpty();
});

test('403 and 503 are explained distinctly', async ({ page }) => {
  let status = 403;
  await setup(page, { api: route => route.fulfill({ status, json: { error: 'x' } }) });
  await page.goto('/portfolio_manager.html#analysis');
  await page.locator('#pm-analysis-ticker').fill('NVDA');
  await page.getByRole('button', { name: '分析する' }).click();
  await expect(page.locator('#pm-analysis-status')).toContainText('利用許可がありません');
  status = 503;
  await page.locator('#pm-analysis-ticker').fill('AVGO');
  await page.getByRole('button', { name: '分析する' }).click();
  await expect(page.locator('#pm-analysis-status')).toContainText('連絡先設定が未完了');
});

test('PLTR analysis renders sourced, escaped, verification-flagged results without touching the portfolio', async ({ page }, info) => {
  const body = await apiBody('PLTR', { name: 'Palantir <img src=x onerror="window.__xss=1">' });
  const calls = await setup(page, { api: route => route.fulfill({ status: 200, json: body }) });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/portfolio_manager.html#analysis');
  const before = await page.evaluate(() => localStorage.getItem('pm_workspace_v3'));
  await page.locator('#pm-analysis-ticker').fill('pltr');
  await page.getByRole('button', { name: '分析する' }).click();
  await expect(page.locator('#pm-analysis-verification')).toContainText('検証中の参考値');
  await expect(page.locator('#pm-analysis-summary')).toContainText('マシャ総合スコア');
  await expect(page.locator('#pm-analysis-summary')).toContainText('85 / 100');
  await expect(page.locator('#pm-analysis-quarters tbody tr')).toHaveCount(8);
  await expect(page.locator('#pm-analysis-quarters')).toContainText('2026-09-30');
  await expect(page.locator('#pm-analysis-quarters')).toContainText('95.9%');           // date-matched YoY
  await expect(page.locator('#pm-analysis-quarters')).toContainText('※算出');           // synthesised Q4 is labelled
  await expect(page.locator('#pm-analysis-source a')).toHaveAttribute('href', /^https:\/\/data\.sec\.gov\//);
  await expect(page.locator('#pm-analysis-summary')).toContainText('$159.36');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(calls[0]).toEqual({ ticker: 'PLTR', auth: 'Bearer header.payload.sig' });
  expect(await page.evaluate(() => localStorage.getItem('pm_workspace_v3'))).toBe(before);
  await page.locator('#pm-analysis-tenyear summary').click();
  await expect(page.locator('#pm-analysis-tenyear')).toContainText('標準');
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  expect(errors).toEqual([]);
  await page.screenshot({ path: `test-results/analysis-${info.project.name}.png`, fullPage: false });
});
