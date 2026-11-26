'use strict';
// 市場分析 data access. Prefers the authenticated /api/market (server-side fetch, so
// holdings tickers are not sent to third parties). Until Cloud Functions are deployed
// the legacy public CORS proxies remain as a fallback — but never for sensitive
// (holdings-related) requests when the user is not signed in.
((root) => {
  const PROXIES = [
    url => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    url => 'https://corsproxy.io/?' + encodeURIComponent(url),
    url => 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url)
  ];
  const sources = new Set();

  function note(kind) {
    sources.add(kind);
    const el = document.getElementById('pm-market-source');
    if (!el) return;
    el.textContent = sources.has('proxy')
      ? '取得元：一部を第三者の中継サービス経由で取得しています（分析APIが未公開のため。公開後は自前APIのみになります）。'
      : '取得元：自前API（Firebase Cloud Functions）経由。銘柄情報は第三者に送られません。';
    el.dataset.warn = String(sources.has('proxy'));
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

  async function viaProxies(url) {
    let last;
    for (const make of PROXIES) {
      try {
        const res = await fetch(make(url), { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        note('proxy');
        return json;
      } catch (e) { last = e; }
    }
    throw last || new Error('proxy failed');
  }

  async function get(apiPath, upstreamUrl, sensitive) {
    const out = await root.PMApi.call(apiPath, { kind: '市場データ' });
    if (out.data) { note('api'); return out.data; }
    const fallback = out.code === 'not-deployed' || (out.code === 'login' && !sensitive);
    if (fallback) return viaProxies(upstreamUrl);
    root.PMMarketData.lastError = out.code === 'login' ? 'ログインが必要' : out.code === 'network' ? '通信エラー' : '取得元エラー';
    throw new Error(out.error || 'market data unavailable');
  }

  /** Yahoo-chart-compatible JSON for a Yahoo chart URL. */
  function chart(yahooUrl, { sensitive = false } = {}) {
    return get('/api/market?' + toQuery(yahooUrl), yahooUrl, sensitive);
  }
  function fearGreed() {
    return get('/api/market?kind=feargreed', 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata/', false);
  }

  root.PMMarketData = { chart, fearGreed, toQuery };
  if (typeof module === 'object' && module.exports) module.exports = root.PMMarketData;
})(globalThis);
