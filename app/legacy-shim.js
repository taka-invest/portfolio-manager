'use strict';
// Runs the legacy Stock Analyzer pages (research/index.html, research/screener.html)
// UNCHANGED on Firebase: their calls to /.netlify/functions/* are routed to our own
// authenticated APIs. Data behind them is the corrected SEC computation.
//   analyze         -> /api/analyze   (legacy engine fed with corrected SEC data)
//   chart           -> /api/market    (weekly 5y OHLCV, Yahoo-compatible shape)
//   screener        -> /api/screener  (corrected screener, mapped to legacy fields)
//   eps-revisions / sec-8k-guidance -> "unavailable" (Finviz scraping not deployed;
//                      the 8-K panel never loaded in the browser on Netlify either)
((root) => {
  const realFetch = root.fetch.bind(root);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  async function token() {
    if (!root.PMCloud && root.PMCloudReady) await Promise.race([root.PMCloudReady, new Promise(r => setTimeout(r, 6000))]);
    try { return root.PMCloud ? await root.PMCloud.idToken() : null; } catch { return null; }
  }

  function loginBanner() {
    if (document.getElementById('pm-legacy-login')) return;
    const bar = document.createElement('div');
    bar.id = 'pm-legacy-login';
    bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#3b2f0b;color:#fde68a;border-bottom:2px solid #f59e0b;padding:8px 16px;font:13px/1.6 sans-serif';
    bar.innerHTML = 'Googleログインが必要です。<a href="../portfolio_manager.html#data-settings" target="_top" style="color:#fff;text-decoration:underline">Portfolio Managerの「設定・データ管理」</a>でログインしてから再読み込みしてください。';
    document.body.prepend(bar);
  }

  async function api(path, init = {}) {
    const t = await token();
    if (!t) { loginBanner(); return json({ error: 'Googleログインが必要です' }, 401); }
    const headers = { ...(init.headers || {}), Authorization: 'Bearer ' + t };
    return realFetch(path, { ...init, headers });
  }

  const quarterLabel = end => {
    if (!end) return null;
    const d = new Date(end + 'T00:00:00Z'), m = d.getUTCMonth() + 1;
    return `${d.getUTCFullYear()} ${m <= 3 ? 'Q1' : m <= 6 ? 'Q2' : m <= 9 ? 'Q3' : 'Q4'}`;
  };

  /** Corrected screener row -> legacy screener row (fields read by the legacy UI). */
  function legacyRow(r) {
    if (r.error) return { ticker: r.ticker, error: r.error, signalScore: 0, phase: 'unknown' };
    // The legacy table checks `!== null` before formatting, so a missing value must be
    // null (never undefined) or one row without e.g. gross margin breaks the whole table.
    const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      ticker: r.ticker, name: r.name ?? null, latestQ: quarterLabel(r.latestQ), revM: n(r.revenueM),
      revYoY: n(r.revenueYoYPct), yoyAccel: n(r.yoyAccelPts), opMargin: n(r.operatingMarginPct),
      grossMargin: n(r.grossMarginPct), rof40: n(r.ruleOf40Legacy), signalScore: n(r.signalScore) ?? 0,
      signalQ: quarterLabel(r.signalQ), signalFlags: r.signalFlags || {}, phase: r.phase,
      isFinancial: r.phase === 'financial', gmImproveStreak: n(r.gmImproveStreak) ?? 0,
      price: n(r.price), mktcap: null, chg1d: null
    };
  }

  root.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, root.location.href);
    if (url.pathname.startsWith('/.netlify/functions/')) {
      const name = url.pathname.split('/').pop();
      const ticker = encodeURIComponent(url.searchParams.get('ticker') || '');
      if (name === 'analyze') return api('/api/analyze?ticker=' + ticker);
      if (name === 'chart') return api('/api/market?symbol=' + ticker + '&range=5y&interval=1wk');
      if (name === 'screener') {
        let body = {};
        try { body = JSON.parse(init.body || '{}'); } catch { /* ignore */ }
        const res = await api('/api/screener', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body.mode === 'getpool' ? { mode: 'getpool' } : { tickers: body.tickers }) });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) return json(data || { error: 'screener unavailable' }, res.status || 502);
        if (body.mode === 'getpool') return json(data.pool || []);
        return json((data.rows || []).map(legacyRow));
      }
      return json({ error: 'unavailable on Firebase' }, 404);
    }
    // The legacy page fetched SEC directly from the browser (blocked by CORS); answer locally.
    if (url.hostname === 'www.sec.gov') return json({ error: 'use /api' }, 404);
    return realFetch(input, init);
  };

  root.PMLegacyShim = { legacyRow, quarterLabel };
})(globalThis);
