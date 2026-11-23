'use strict';

/* Import the legacy "masyaWatchlist" localStorage JSON from a different
 * origin, after explicit review. Never reads/writes the Netlify origin.
 * Never alters holdings, portfolio targets, transactions, or tax settings.
 */
((root) => {
  const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,19}$/;
  const MAX_INPUT_LENGTH = 20000;
  const MAX_TICKERS = 500;
  function parse(raw) {
    if (typeof raw !== 'string' || raw.length > MAX_INPUT_LENGTH)
      throw new Error('旧ウォッチリストのJSONを貼り付けてください（最大20KB）。');
    let value;
    try { value = JSON.parse(raw); }
    catch { throw new Error('JSONとして読み込めません。旧アプリのmasyaWatchlistを確認してください。'); }
    if (!Array.isArray(value) || value.length > MAX_TICKERS)
      throw new Error('旧ウォッチリストは500銘柄以下の文字列配列である必要があります。');
    const tickers = [];
    const seen = new Set();
    for (const item of value) {
      if (typeof item !== 'string' || !SYMBOL.test(item.trim().toUpperCase()))
        throw new Error('銘柄名の形式が正しくありません。文字列ティッカー配列を使用してください。');
      const ticker = item.trim().toUpperCase();
      if (!seen.has(ticker)) { seen.add(ticker); tickers.push(ticker); }
    }
    return tickers;
  }
  function preview(text, state) {
    const tickers = parse(text);
    const existing = new Set(state.watchlist.map(w => w.ticker));
    const add = tickers.filter(t => !existing.has(t));
    return { parsed: tickers.length, newTickers: add,
      skipped: tickers.length - add.length };
  }
  function apply(state, report, idProvider, when) {
    const added = report.newTickers.map(ticker => ({
      id: idProvider(),
      ticker, layer: 2, targetPriceJpy: null, curPriceJpy: null,
      condition: '', note: 'Stock Analyzerからインポート',
      addedAt: when
    }));
    return { ...state, watchlist: [...state.watchlist, ...added] };
  }
  function init() {
    if (typeof document === 'undefined') return;
    const area = document.getElementById('pm-research-legacy-json');
    const button = document.getElementById('pm-research-preview');
    const accept = document.getElementById('pm-research-accept');
    const status = document.getElementById('pm-research-import-status');
    const result = document.getElementById('pm-research-import-summary');
    if (!area || !button || !accept || !status || !result) return;
    let pending = null;
    function clear() {
      pending = null;
      accept.disabled = true;
      status.textContent = '読み込み内容は保存前に差分を表示します。';
      result.textContent = '';
    }
    area.addEventListener('input', clear);
    button.addEventListener('click', () => {
      try {
        const state = root.PMApp.state();
        const report = preview(area.value, state);
        pending = { source: area.value, state, report };
        result.textContent = report.newTickers.length
          ? '新規追加: ' + report.newTickers.join('、')
          : '追加対象の銘柄はありません。';
        status.textContent = '読み込み ' + report.parsed + '銘柄／既存と重複 ' +
          report.skipped + '銘柄／追加 ' + report.newTickers.length +
          '銘柄。保有資産や目標配分は変更しません。';
        accept.disabled = !report.newTickers.length;
      } catch (e) {
        clear();
        status.textContent = '読み込みエラー: ' + e.message;
      }
    });
    accept.addEventListener('click', () => {
      if (!pending || area.value !== pending.source ||
          root.PMApp.state() !== pending.state) {
        clear();
        status.textContent = 'データが変更されました。差分を再確認してください。';
        return;
      }
      const { report, state } = pending;
      // Review is deliberately separate from mutation; save a backup first.
      const next = apply(state, report, () => root.PMApp.id(), new Date().toISOString());
      if (!root.PMApp.commit(next, true)) return;
      clear();
      status.textContent = '新規ウォッチリスト ' + report.newTickers.length +
        '銘柄を追加しました。既存データの上書きは行っていません。';
      area.value = '';
    });
    clear();
  }
  const api = { parse, preview, apply, init };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMResearchImport = api;
})(globalThis);
