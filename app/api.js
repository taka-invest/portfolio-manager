'use strict';
// Shared client for the authenticated finance APIs (/api/*). Adds the Firebase ID
// token, classifies failures into user-facing Japanese messages, and never throws.
((root) => {
  async function token() {
    const cloud = root.PMCloud;
    if (!cloud || typeof cloud.idToken !== 'function') return null;
    try { return await cloud.idToken(); } catch { return null; }
  }

  function explain(res, body, kind = '分析') {
    const type = res.headers?.get?.('content-type') || '';
    if (res.status === 404 && !type.includes('json')) return kind + 'APIはまだ公開されていません（Cloud Functions未デプロイ）。';
    if (res.status === 404) return (body && body.error === 'No price data')
      ? '株価データが見つかりません。' : 'SECの企業一覧にこの銘柄が見つかりません（米国上場・SEC提出企業のみ対応）。';
    if (res.status === 401) return 'Googleログインが必要です。「設定・データ管理」からログインしてください。';
    if (res.status === 403) return 'このアカウントには' + kind + 'APIの利用許可がありません。';
    if (res.status === 400) return '入力（銘柄コード・件数・期間）の形式を確認してください。';
    if (res.status === 503) return 'SECへの連絡先設定が未完了のため取得できません（運用設定）。';
    if (res.status >= 500) return 'SECまたは株価データの取得に失敗しました。時間をおいて再試行してください。';
    return (body && body.error) || 'データを取得できませんでした（HTTP ' + res.status + '）。';
  }

  /** @returns {Promise<{data?: any, error?: string}>} */
  async function call(path, { method = 'GET', body, kind } = {}, fetcher = root.fetch.bind(root)) {
    const t = await token();
    if (!t) return { error: 'Googleログインが必要です。「設定・データ管理」からログインしてください。' };
    let res;
    try {
      res = await fetcher(path, {
        method,
        headers: { Authorization: 'Bearer ' + t, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
    } catch {
      return { error: 'ネットワークに接続できません。' };
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json().catch(() => null) : null;
    if (!res.ok || !data) return { error: explain(res, data, kind) };
    return { data };
  }

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
  /** Tickers known anywhere in the app: holdings, targets, watchlist, company notes. */
  function knownTickers(state) {
    const s = state || (root.PMApp && root.PMApp.state ? root.PMApp.state() : {}) || {};
    const set = new Set();
    for (const list of [s.positions, s.targets, s.watchlist, s.company]) {
      for (const row of list || []) if (row && TICKER.test(row.ticker || '')) set.add(row.ticker);
    }
    return [...set].sort();
  }

  root.PMApi = { call, explain, esc, knownTickers, TICKER };
  if (typeof module === 'object' && module.exports) module.exports = root.PMApi;
})(globalThis);
