'use strict';
// 銘柄スクリーナー: up to 10 tickers per run on corrected SEC data (POST /api/screener).
// Read-only; clicking a row opens 個別企業分析 for that ticker.
((root) => {
  const $ = id => document.getElementById(id);
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const num = (v, d = 1) => fin(v) ? v.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
  const pct = v => fin(v) ? num(v) + '%' : '—';
  const PHASE = { phase1: 'フェーズ1（赤字・先行投資）', phase2: 'フェーズ2（移行期）', phase3: 'フェーズ3（収益化）', financial: '金融' };
  const COLS = [
    ['ticker', '銘柄'], ['latestQ', '最新四半期'], ['revenueM', '売上($M)'], ['revenueYoYPct', '前年比'],
    ['revenueTtmYoYPct', 'TTM成長'], ['operatingMarginPct', '営業利益率'], ['ruleOf40', 'Rule of 40'],
    ['signalScore', '参入シグナル'], ['phase', 'フェーズ'], ['masyaScore', 'マシャ点'], ['exitLabel', '撤退'], ['price', '株価']
  ];
  let rows = [], sortKey = 'signalScore', sortDesc = true, lastSource = null;

  function status(message, warn = false) {
    const el = $('pm-screener-status');
    el.textContent = message; el.dataset.warn = String(warn); el.hidden = !message;
  }

  /** Parse "PLTR, nvda APP" -> unique uppercase list; returns {list, error}. */
  function parseTickers(text) {
    const list = [...new Set(String(text || '').toUpperCase().split(/[\s,、]+/).filter(Boolean))];
    if (!list.length) return { error: '銘柄コードを入力してください。' };
    if (list.length > 10) return { error: '1回に10銘柄までです（' + list.length + '件入力）。' };
    const bad = list.filter(t => !root.PMApi.TICKER.test(t));
    if (bad.length) return { error: '形式を確認してください：' + bad.join(', ') };
    return { list };
  }

  function cell(row, key) {
    const v = row[key];
    const esc = root.PMApi.esc;
    if (key === 'ticker') return `<button type="button" class="btn btn-ghost pm-screener-open" data-ticker="${esc(v)}">${esc(v)}</button>`;
    if (key === 'revenueM') return fin(v) ? num(v) : '—';
    if (['revenueYoYPct', 'revenueTtmYoYPct', 'operatingMarginPct'].includes(key)) return pct(v);
    if (key === 'ruleOf40') return num(v);
    if (key === 'signalScore') return fin(v) ? v + (row.signalQ ? `<small class="pm-muted">（${esc(row.signalQ)}）</small>` : '') : '—';
    if (key === 'phase') return esc(PHASE[v] || v || '—');
    if (key === 'masyaScore') return fin(v) ? v + (row.masyaComplete === false ? '※' : '') : '—';
    if (key === 'price') return fin(v) ? '$' + num(v, 2) : '—';
    return esc(v ?? '—');
  }

  function render() {
    const sorted = [...rows].sort((a, b) => {
      if (a.error || b.error) return a.error ? 1 : -1;
      const x = a[sortKey], y = b[sortKey];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
      return sortDesc ? -c : c;
    });
    const head = COLS.map(([k, label]) =>
      `<th><button type="button" class="pm-screener-sort" data-key="${k}" aria-sort="${k === sortKey ? (sortDesc ? 'descending' : 'ascending') : 'none'}">${label}${k === sortKey ? (sortDesc ? ' ▼' : ' ▲') : ''}</button></th>`).join('');
    const body = sorted.map(r => r.error
      ? `<tr><td>${root.PMApi.esc(r.ticker)}</td><td colspan="${COLS.length - 1}" class="pm-muted">${root.PMApi.esc(r.error)}</td></tr>`
      : `<tr>${COLS.map(([k]) => `<td>${cell(r, k)}</td>`).join('')}</tr>`).join('');
    $('pm-screener-result').innerHTML = `
      <p class="pm-callout" data-warn="true">検証中の参考値です。売買判断の正式な根拠には使わないでください。シグナル・フェーズの規則は旧スクリーナーと同じで、入力データを修正版に置き換えています。</p>
      <div class="pm-wrap" tabindex="0" aria-label="スクリーニング結果"><table class="pos-table" id="pm-screener-table">
        <thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
      <p class="pm-muted pm-small">銘柄をクリックすると個別企業分析を開きます。※＝データ不足の項目あり。出典：${root.PMApi.esc(lastSource?.provider)}／株価：${root.PMApi.esc(lastSource?.price)}／取得 ${lastSource?.retrievedAt ? new Date(lastSource.retrievedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST' : '—'}</p>
      <button type="button" class="btn btn-ghost" id="pm-screener-csv">CSVを書き出す</button>`;
  }

  function csv() {
    const header = COLS.map(c => c[1]).join(',');
    const lines = rows.filter(r => !r.error).map(r => COLS.map(([k]) => {
      const v = k === 'phase' ? (PHASE[r[k]] || r[k]) : r[k];
      return v == null ? '' : '"' + String(v).replace(/"/g, '""') + '"';
    }).join(','));
    const blob = new Blob(['﻿' + [header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'screener_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function run(event) {
    event?.preventDefault();
    const parsed = parseTickers($('pm-screener-tickers').value);
    if (parsed.error) { status(parsed.error, true); return; }
    $('pm-screener-tickers').value = parsed.list.join(', ');
    const button = $('pm-screener-run');
    button.disabled = true;
    status(parsed.list.length + '銘柄のSECデータを順番に取得しています（SECのアクセス制限に合わせて数秒〜数十秒かかります）…');
    try {
      const out = await root.PMApi.call('/api/screener', { method: 'POST', body: { tickers: parsed.list }, kind: 'スクリーナー' });
      if (out.error) { status(out.error, true); $('pm-screener-result').innerHTML = ''; return; }
      rows = out.data.rows || []; lastSource = out.data.source || null;
      render();
      status('');
    } finally { button.disabled = false; }
  }

  function init() {
    const form = $('pm-screener-form');
    if (!form) return;
    form.addEventListener('submit', run);
    $('pm-screener-fill').addEventListener('click', () => {
      $('pm-screener-tickers').value = root.PMApi.knownTickers().slice(0, 10).join(', ');
    });
    $('pm-screener-result').addEventListener('click', e => {
      const sort = e.target.closest('.pm-screener-sort');
      if (sort) { const k = sort.dataset.key; sortDesc = k === sortKey ? !sortDesc : true; sortKey = k; render(); return; }
      const open = e.target.closest('.pm-screener-open');
      if (open && root.PMAnalysis) { root.PMAnalysis.analyzeTicker(open.dataset.ticker); return; }
      if (e.target.id === 'pm-screener-csv') csv();
    });
  }

  root.PMScreener = { init, parseTickers };
  if (typeof module === 'object' && module.exports) module.exports = root.PMScreener;
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(globalThis);
