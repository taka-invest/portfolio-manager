'use strict';
// The legacy screener page against the single-instance backend: one batch in flight,
// a congested (429) batch is retried once, and a failed batch is counted and explained.
const { test, expect } = require('@playwright/test');

test('scan sends one batch at a time, retries 429 once and reports failed batches', async ({ page }) => {
  await page.addInitScript(() => { window.PMCloud = { idToken: async () => 'header.payload.sig' }; });
  let inFlight = 0, maxInFlight = 0, posts = 0;
  const attempts = new Map();
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/screener') {
      posts++;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const tickers = JSON.parse(route.request().postData()).tickers;
      const key = tickers[0];
      attempts.set(key, (attempts.get(key) || 0) + 1);
      await new Promise(r => setTimeout(r, 150));
      inFlight--;
      if (key === 'T10' && attempts.get(key) === 1) return route.fulfill({ status: 429, json: { error: 'busy' } });
      if (key === 'T20') return route.fulfill({ status: 502, json: { error: 'Market data unavailable' } });
      return route.fulfill({ status: 200, json: { rows: tickers.map(t => ({ ticker: t, name: t, latestQ: '2026-09-30', signalScore: 10, phase: 'phase2', signalFlags: {} })) } });
    }
    if (url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'cdn.tailwindcss.com') return route.continue().catch(() => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
    return route.fulfill({ status: 503, body: '' });
  });
  await page.goto('/research/screener.html');
  await page.evaluate(() => {
    TICKER_LISTS.nasdaq100 = Array.from({ length: 25 }, (_, i) => 'T' + i);   // batches T0.., T10.., T20..
    return startScan();
  });
  await expect(page.locator('#progressLabel')).toContainText('スキャン完了 — 25銘柄分析');
  await expect(page.locator('#progressLabel')).toContainText('取得できなかった銘柄 5件');
  await expect(page.locator('#progressLabel')).toContainText('HTTP 502');
  await expect(page.locator('#statError')).toHaveText('5');
  expect(maxInFlight).toBe(1);
  expect(attempts.get('T10')).toBe(2);               // 429 → waited and retried once → success
  expect(attempts.get('T20')).toBe(2);               // 502 → retried once → still failing → counted
  expect(posts).toBe(5);
});
