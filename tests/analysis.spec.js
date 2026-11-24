'use strict';
// 個別企業分析 screen. The API is mocked with output computed from the REAL SEC
// fixture (tests/fixtures/sec/PLTR.json) by the same code the Cloud Function runs.
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

async function apiBody(ticker = 'PLTR', patch = {}) {
  const F = await import('file://' + join(__dirname, '..', 'functions/src/sec/financials.js'));
  const S = await import('file://' + join(__dirname, '..', 'functions/src/sec/scoring.js'));
  const SC = await import('file://' + join(__dirname, '..', 'functions/src/sec/screen.js'));
  const facts = JSON.parse(readFileSync(join(__dirname, 'fixtures/sec', ticker + '.json'), 'utf8'));
  const out = F.analyzeFacts(facts);
  const quote = { price: 159.36, currency: 'USD', asOf: '2026-11-23T21:00:01.000Z', source: 'Yahoo Finance chart API（非公式）' };
  return {
    ticker, cik: '0001321655', name: facts.entityName,
    source: { provider: 'SEC EDGAR XBRL companyfacts', url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001321655.json',
      retrievedAt: '2026-11-24T01:00:00.000Z', currency: 'USD', note: 'US-GAAP（USD）提出企業のみ' },
    quote, quarters: out.quarters.slice(-16), annual: out.annual.slice(-6), latest: out.latest, balance: out.balance,
    signals: (() => { const tr = SC.entrySignals(out.quarters.slice(-16)); return { phase: SC.phaseOf(ticker, tr),
      byQuarter: tr.map(q => ({ end: q.end, score: q.signalScore, flags: q.signals, opMDelta: q.opMDelta, yoyAccel: q.yoyAccel })) }; })(),
    annualFlows: { buyback: out.annualFlows.buyback.slice(-6), stockIssued: out.annualFlows.stockIssued.slice(-6) },
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
  await expect(page.locator('#pm-analysis-quarters tbody tr')).toHaveCount(12);
  await expect(page.locator('#pm-analysis-quarters')).toContainText('2026-09-30');
  await expect(page.locator('#pm-analysis-quarters')).toContainText('95.9%');           // date-matched YoY
  await expect(page.locator('#pm-analysis-quarters')).toContainText('※算出');           // synthesised Q4 is labelled
  await expect(page.locator('#pm-analysis-source a')).toHaveAttribute('href', /^https:\/\/data\.sec\.gov\//);
  await expect(page.locator('#pm-analysis-summary')).toContainText('$159.36');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  expect(calls[0]).toEqual({ ticker: 'PLTR', auth: 'Bearer header.payload.sig' });
  expect(await page.evaluate(() => localStorage.getItem('pm_workspace_v3'))).toBe(before);
  await expect(page.locator('#pm-an-pane-0')).toContainText('標準価格（メイン）');
  await expect(page.locator('.pm-an-header')).toContainText('Phase3');
  await page.getByRole('tab', { name: /投資判断/ }).click();
  await expect(page.locator('#pm-an-pane-2')).toBeVisible();
  await expect(page.locator('#pm-an-pane-2')).toContainText('撤退シグナルエンジン');
  await page.getByRole('tab', { name: /財務諸表/ }).click();
  await expect(page.locator('#pm-an-pane-3')).toContainText('PL 損益計算書');
  await expect(page.locator('#pm-an-pane-3')).toContainText('$4.5B');            // FY2025 revenue 4,475.4M
  await page.getByRole('tab', { name: /チャート/ }).click();
  await expect(page.locator('#pm-analysis-quarters')).toBeVisible();
  await expect(page.locator('#pm-analysis-chart')).toContainText('まだ公開されていません'); // /api/chart not mocked here
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  expect(errors).toEqual([]);
  await page.screenshot({ path: `test-results/analysis-${info.project.name}.png`, fullPage: false });
});

test('chart tab: weekly candlesticks + volume + MA9 with SEC signal markers (lightweight-charts 4.2.0)', async ({ page }, info) => {
  const body = await apiBody('PLTR');
  const lw = readFileSync(join(__dirname, '..', 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'));
  // 5 years of synthetic weekly bars ending at the fixture's latest quarter.
  const points = [];
  let p = 20;
  for (let t = Date.parse('2021-11-29'); t <= Date.parse('2026-11-23'); t += 7 * 864e5) {
    const o = p; p = Math.max(5, p * (1 + Math.sin(t / 6e9) * 0.03 + 0.006));
    points.push({ t: new Date(t).toISOString().slice(0, 10), open: +o.toFixed(2), high: +(Math.max(o, p) * 1.02).toFixed(2), low: +(Math.min(o, p) * 0.98).toFixed(2), close: +p.toFixed(2), volume: 1e6 });
  }
  await setup(page, { api: route => route.fulfill({ status: 200, json: body }) });
  await page.route('**/api/chart**', route => route.fulfill({ status: 200, json: { ticker: 'PLTR', range: '5y', interval: '1wk', currency: 'USD', adjusted: true, points,
    source: { provider: 'Yahoo Finance chart API（非公式）', retrievedAt: '2026-11-24T01:00:00Z', note: '分割・配当調整後の終値' } } }));
  await page.route('https://unpkg.com/**', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: lw }));
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/portfolio_manager.html#analysis');
  await page.locator('#pm-analysis-ticker').fill('PLTR');
  await page.getByRole('button', { name: '分析する' }).click();
  await page.getByRole('tab', { name: /チャート/ }).click();
  await expect(page.locator('#pm-analysis-chart canvas').first()).toBeVisible();
  await expect(page.locator('#pm-analysis-chart-note')).toContainText(`週足${points.length}本`);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
  await page.screenshot({ path: `test-results/analysis-chart-${info.project.name}.png`, fullPage: false });
});
