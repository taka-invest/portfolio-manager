'use strict';
// Market view: today's regime from the own API (stubbed) with the study's thresholds;
// if live data fails, the study's last FRED date is shown and labelled. Synthetic data.
const { test, expect } = require('@playwright/test');

const P = { ma: 200, highWindow: 252, minEpisodes: 5, vixBands: [[15, '低'], [20, '通常'], [30, '高'], [null, '極端']], depthBands: [[-0.10, '浅い'], [-0.20, '調整'], [null, '弱気相場']] };
const cell = (ep, med) => ({ jpy: { n: 100, episodes: ep, median: med, mean: med, q05: -0.3, q95: 0.2, positive: 0.6, medianCI95: ep > 1 ? [med - 0.05, med + 0.05] : null }, usd: { n: 100, episodes: ep, median: med + 0.01, mean: med, q05: -0.3, q95: 0.2, positive: 0.6, medianCI95: null } });
const g = (ep, med) => ({ days: ep * 10, episodes: ep, horizons: { 20: cell(ep, med / 2), 60: cell(ep, med), 250: cell(ep, med * 3) } });
const RESULT = { version: 'p0c-2', dates: ['1990-12-28', '2026-11-24'], params: P, levels: ['trend|vol|depth', 'vol|depth', 'vol', 'trend|depth', 'depth', 'all'], assumptions: ['合成データ'],
  current: { date: '2026-11-24', trend: '下落', vol: '高', depth: '調整', vix: 26.4, px: 93, ma: 100, dd: -0.16 },
  groups: { 'trend|vol|depth:下落・高・調整': g(18, 0.026), 'vol|depth:高・調整': g(39, 0.048), 'vol:高': g(60, 0.051),
    'trend|vol|depth:下落・極端・調整': g(9, 0.07), 'vol|depth:極端・調整': g(12, 0.08), 'vol:極端': g(30, 0.09),
    'trend|depth:下落・調整': g(40, 0.03), 'depth:調整': g(70, 0.04), 'all:全期間': g(1, 0.046) } };

async function open(page, { apiOk, manualVix }) {
  if (manualVix) await page.addInitScript(v => localStorage.setItem('pm_vix', JSON.stringify({ v, t: Date.now() })), manualVix);
  await page.addInitScript(json => { window.PMCloud = { idToken: async () => 'h.p.s', readResearch: async id => id === 'market-regime' ? { json } : null }; }, JSON.stringify(RESULT));
  // 300 closes: rising to 120 then falling to 100 -> below the 200-day average, ~17% off the high.
  const closes = Array.from({ length: 300 }, (_, i) => i < 260 ? 80 + i * (40 / 260) : 120 - (i - 259) * 0.5);
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/market') {
      if (!apiOk) return route.fulfill({ status: 502, json: { error: 'upstream' } });
      const sym = u.searchParams.get('symbol');
      const c = sym === '^VIX' ? [30, 32, 33.5] : closes;
      const t0 = Date.parse('2026-01-01') / 1000;
      return route.fulfill({ json: { chart: { result: [{ meta: { symbol: sym }, timestamp: c.map((_, i) => t0 + i * 86400), indicators: { quote: [{ close: c }] } }] } } });
    }
    return u.hostname === '127.0.0.1' ? route.continue() : route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/portfolio_manager.html#market');
}

test('classifies today from the own API (NASDAQ-100 only): no VIX source -> trend/drawdown comparison', async ({ page }) => {
  await open(page, { apiOk: true });
  const card = page.locator('#research-regime');
  await expect(card).toContainText('下落トレンド');
  await expect(card).toContainText('VIXの取得元がないため判定なし');
  await expect(card).toContainText('自前API（NASDAQ-100 日足）');
  await expect(card.locator('tr.pm-regime-pick')).toHaveAttribute('data-level', 'trend|depth');
  await card.getByRole('button', { name: 'ドル建て' }).click();
  await expect(card.getByRole('button', { name: 'ドル建て' })).toHaveAttribute('aria-pressed', 'true');
});

test('a VIX entered by hand within the hour is used for the volatility band', async ({ page }) => {
  await open(page, { apiOk: true, manualVix: 33.5 });
  const card = page.locator('#research-regime');
  await expect(card).toContainText('変動 極端（VIX 33.5）');
  await expect(card).toContainText('VIXは手入力の値');
  await expect(card.locator('tr.pm-regime-pick')).toHaveAttribute('data-level', 'trend|vol|depth');
});

test('live data unavailable: falls back to the study date and says so', async ({ page }) => {
  await open(page, { apiOk: false });
  const card = page.locator('#research-regime');
  await expect(card).toContainText('研究データの最終日（2026-11-24、FRED）');
  await expect(card).toContainText('下落トレンド');
});
