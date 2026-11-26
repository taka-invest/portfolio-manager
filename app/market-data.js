'use strict';
// 市場分析 data access through the authenticated /api/market only (server-side fetch,
// so tickers are never sent to third parties). The public CORS proxies used before
// Cloud Functions existed were removed (2026-11-26): signed out means "ログインが必要".
((root) => {

  function note() {
    const el = document.getElementById('pm-market-source');
    if (!el) return;
    el.textContent = '取得元：自前API（Firebase Cloud Functions）経由。銘柄情報は第三者に送られません。';
    el.dataset.warn = 'false';
    el.hidden = false;
  }

  /** Translate a Yahoo chart URL into /api/market query parameters. */
  function toQuery(yahooUrl) {
    const u = new URL(yahooUrl);
    const symbol = decodeURIComponent(u.pathname.split('/').pop());
    const q = new URLSearchParams({ symbol });
    for (const k of ['range', 'interval', 'period1', 'period2']) if (u.searchParams.has(k)) q.set(k, u.searchParams.get(k));
    return q.toString();
  }

  async function get(apiPath) {
    const out = await root.PMApi.call(apiPath, { kind: '市場データ' });
    if (out.data) { note(); return out.data; }
    root.PMMarketData.lastError = out.code === 'login' ? 'ログインが必要' : out.code === 'network' ? '通信エラー' : '取得元エラー';
    throw new Error(out.error || 'market data unavailable');
  }

  /** Yahoo-chart-compatible JSON for a Yahoo chart URL. */
  function chart(yahooUrl) {
    return get('/api/market?' + toQuery(yahooUrl));
  }
  function fearGreed() {
    return get('/api/market?kind=feargreed');
  }

  root.PMMarketData = { chart, fearGreed, toQuery };
  if (typeof module === 'object' && module.exports) module.exports = root.PMMarketData;
})(globalThis);
