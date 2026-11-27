'use strict';
// 「今日やること」 on screen: blocked → reasons with links; ③ orders in sell → buy order;
// a staged plan replaces ③; the dashboard shows the one-line summary.
const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');

const close = Date.parse('2026-11-20T21:00:00Z') / 1000;
const lot = (ticker, shares) => ({ id: ticker, ticker, shares, kind: 'stock', broker: 'マネックス証券', account: '',
  accountType: 'specific', layer: 1, currency: 'USD', unitCost: 10, costJpy: shares * 100, referenceJpy: null, note: '' });
const PRICES = { PLTR: 100, APP: 50, NVDA: 10, AVGO: 30, SOFI: 5, CRDO: 8, RKLB: 6, SPCX: 4 };

async function setUp(page, over = {}) {
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  const state = { ...D.blank(), confirmed: true, positions: [lot('PLTR', 200), lot('APP', 20)],
    targets: D.blank().targets.map(t => t.ticker === 'PLTR' ? { ...t, sellCap: null } : t),
    cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true }, ...over };
  await page.addInitScript(({ key, state }) => {
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem('pm_api_key', 'fixture-key');
  }, { key: D.KEY, state });
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    if (u.hostname === 'www.live-rates.com') return route.fulfill({ json: [{ currency: 'USD/JPY', bid: 99.995, ask: 100.005, timestamp: Date.parse('2026-11-22T12:00:00Z') }] });
    if (u.hostname === 'finnhub.io' && u.pathname.endsWith('/quote')) return route.fulfill({ json: { c: PRICES[u.searchParams.get('symbol')] ?? 0, t: close } });
    if (u.hostname === 'finnhub.io') return route.fulfill({ json: {} });
    return route.fulfill({ status: 503, json: {} });
  });
}

test('trade view opens at 今日やること with ③ orders, sells first, and the dashboard summary', async ({ page }, info) => {
  await setUp(page);
  await page.goto('/portfolio_manager.html#overview');
  await expect(page.locator('#today-mini')).toContainText('③の売買案：売 PLTR');
  await page.locator('#today-mini a').click();
  await expect(page).toHaveURL(/#today$/);
  const guide = page.locator('#today-guide');
  await expect(guide).toBeVisible();
  await expect(guide).toContainText('実保有・現金を口座と照合済み');
  await expect(guide).toContainText('USD/JPY 100.00（スポット）');
  await expect(guide.locator('.pm-today-title')).toHaveText('③の売買案');
  const sides = await guide.locator('.pm-today-orders .pm-today-side').allTextContents();
  expect(sides[0]).toBe('売却');
  expect(sides.lastIndexOf('売却')).toBeLessThan(sides.indexOf('購入'));
  // Same share count as ③'s plan.
  const pltrOrder = await page.evaluate(() => PMApp.result().rows.find(r => r.ticker === 'PLTR').order);
  await expect(guide.locator('.pm-today-orders li').first()).toContainText('PLTR ' + (-pltrOrder) + '株');
  await expect(guide).toContainText('約定した後');
  await guide.screenshot({ path: `test-results/today-guide-${info.project.name}.png` });
});

test('blocked: unconfirmed holdings are named with a link and no orders are shown', async ({ page }) => {
  await setUp(page, { confirmed: false });
  await page.goto('/portfolio_manager.html#today');
  const guide = page.locator('#today-guide');
  await expect(guide).toHaveAttribute('data-mode', 'blocked');
  await expect(guide.locator('.pm-today-check[data-ok="false"] a').first()).toHaveAttribute('href', '#overview');
  await expect(guide.locator('.pm-today-check[data-ok="false"]').first()).toContainText('実保有・現金を確認');
  await expect(guide.locator('.pm-today-orders')).toHaveCount(0);
  await expect(page.locator('#today-mini')).toHaveAttribute('data-warn', 'true');
});

test('a staged plan replaces ③ for today and says what to press after the fills', async ({ page }) => {
  await setUp(page, { positions: [lot('PLTR', 200), lot('NVDA', 5)],
    stagedFunding: { startedAt: '2026-11-21T00:00:00.000Z', baselineShares: { NVDA: 5, AVGO: 0, CRDO: 0 }, stage: 1, stageLog: [] } });
  await page.goto('/portfolio_manager.html#today');
  const guide = page.locator('#today-guide');
  await expect(guide.locator('.pm-today-title')).toHaveText('段階買付 A日（累積50%）');
  await expect(guide).toContainText('③の売買案を使いません');
  await expect(guide).toContainText('「A日の約定を登録済み → B日へ」');
  await expect(guide.locator('.pm-today-orders li').first()).toContainText('売却 PLTR');
  // Staged section uses the same stage name (no more 「第1弾」).
  await expect(page.locator('#pm-staged-funding-result')).toContainText('A日・累積到達率');
  await expect(page.locator('#pm-staged-funding-result')).not.toContainText('第1弾');
});

test('research reference appears in the guide once the research loads (orders unchanged)', async ({ page }) => {
  const regime = { version: 'p0c-1', dates: ['1990-12-28', '2026-11-24'], levels: ['trend|vol|depth', 'vol|depth', 'vol', 'all'], assumptions: [],
    params: { ma: 200, highWindow: 252, minEpisodes: 5, vixBands: [[15, '低'], [20, '通常'], [30, '高'], [null, '極端']], depthBands: [[-0.1, '浅い'], [-0.2, '調整'], [null, '弱気相場']] },
    current: { date: '2026-11-24', trend: '下落', vol: '高', depth: '調整', vix: 26.4, px: 93, ma: 100, dd: -0.16 },
    groups: { 'trend|vol|depth:下落・高・調整': { days: 288, episodes: 18, horizons: { 60: { jpy: { n: 280, episodes: 17, median: 0.026, q05: -0.363, q95: 0.2, positive: 0.6, medianCI95: [-0.077, 0.13] } } } },
      'all:全期間': { days: 9000, episodes: 1, horizons: { 60: { jpy: { n: 9000, episodes: 1, median: 0.046, q05: -0.175, q95: 0.24, positive: 0.66, medianCI95: null } } } } } };
  await page.addInitScript(json => { window.PMCloud = { idToken: async () => 'h.p.s', readResearch: async id => id === 'market-regime' ? { json } : null }; }, JSON.stringify(regime));
  await setUp(page);
  await page.goto('/portfolio_manager.html#today');
  const guide = page.locator('#today-guide');
  await expect(guide.locator('.pm-today-title')).toHaveText('③の売買案');
  const before = await guide.locator('.pm-today-orders').innerText();
  await expect(guide.locator('.pm-today-research')).toContainText('相場の参考：下落トレンド');   // live API unavailable in test -> study's last date
  await expect(guide.locator('.pm-today-research')).toContainText('普段と差があるとは言えない');
  await expect(guide.locator('.pm-today-research a[href="#market"]')).toBeVisible();
  expect(await guide.locator('.pm-today-orders').innerText()).toBe(before);                      // orders untouched
});
