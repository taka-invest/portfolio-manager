'use strict';
// 個別企業分析 (Stock Analyzer integration). Read-only: never changes holdings,
// cash, plans or trades. Data comes from the authenticated /api/financials
// endpoint (Firebase Cloud Functions). Every value is shown with its source;
// missing values are shown as "—" / データ不足, never as 0.
((root) => {
  const API = '/api/financials';
  const CACHE_MS = 10 * 60_000;
  const cache = new Map(); // ticker -> { at, data }
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const num = (v, d = 1) => fin(v) ? v.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
  const musd = v => fin(v) ? '$' + num(v / 1e6, 1) + 'M' : '—';
  const pct = v => fin(v) ? num(v, 1) + '%' : '—';
  const when = iso => iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST' : '—';
  const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;

  /** Tickers known anywhere in the app: holdings, targets, watchlist, company notes. */
  function knownTickers(state) {
    const s = state || {};
    const set = new Set();
    for (const list of [s.positions, s.targets, s.watchlist, s.company]) {
      for (const row of list || []) if (row && TICKER.test(row.ticker || '')) set.add(row.ticker);
    }
    return [...set].sort();
  }

  function status(message, kind = 'info') {
    const el = $('pm-analysis-status');
    el.textContent = message;
    el.dataset.warn = String(kind !== 'info');
    el.hidden = !message;
  }

  async function token() {
    const cloud = root.PMCloud;
    if (!cloud || typeof cloud.idToken !== 'function') return null;
    try { return await cloud.idToken(); } catch { return null; }
  }

  /** Classify an API response into a user-facing state. Exported for tests. */
  function explain(res, body) {
    const type = res.headers?.get?.('content-type') || '';
    if (res.status === 404 && !type.includes('json')) return '分析APIはまだ公開されていません（Cloud Functions未デプロイ）。';
    if (res.status === 404) return 'SECの企業一覧にこの銘柄が見つかりません（米国上場・SEC提出企業のみ対応）。';
    if (res.status === 401) return 'Googleログインが必要です。「設定・データ管理」からログインしてください。';
    if (res.status === 403) return 'このアカウントには分析APIの利用許可がありません。';
    if (res.status === 400) return '銘柄コードの形式を確認してください。';
    if (res.status === 503) return 'SECへの連絡先設定が未完了のため取得できません（運用設定）。';
    if (res.status >= 500) return 'SECまたは株価データの取得に失敗しました。時間をおいて再試行してください。';
    return (body && body.error) || '分析データを取得できませんでした（HTTP ' + res.status + '）。';
  }

  async function load(ticker, fetcher = root.fetch.bind(root)) {
    const hit = cache.get(ticker);
    if (hit && Date.now() - hit.at < CACHE_MS) return { data: hit.data, cached: true };
    const t = await token();
    if (!t) return { error: 'Googleログインが必要です。「設定・データ管理」からログインしてください。' };
    let res;
    try {
      res = await fetcher(API + '?ticker=' + encodeURIComponent(ticker), { headers: { Authorization: 'Bearer ' + t } });
    } catch {
      return { error: 'ネットワークに接続できません。' };
    }
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json().catch(() => null) : null;
    if (!res.ok || !body) return { error: explain(res, body) };
    cache.set(ticker, { at: Date.now(), data: body });
    return { data: body, cached: false };
  }

  const ASSUMPTION_LABELS = {
    cagrBasis: '売上成長率の根拠', historicalCagrPct: '実績CAGR（%）', projectedCagrPct: '10年間の想定成長率（%）',
    cagrRule: '成長率の圧縮ルール', operatingMarginNowPct: '現在のTTM営業利益率（%）', sectorTargetPct: '業種の目標営業利益率（%）',
    operatingMargin10yPct: '10年後の想定営業利益率（%）', marginRule: '利益率のルール', taxFactor: '税・少数株主の調整係数',
    revenue10yUsd: '10年後の想定売上（USD）', sharesBasis: '株数の基準', shares: '株数',
    annualShareGrowthPct: '直近1年の株数増加率（%）', dilutionRule: '希薄化の扱い', discounting: '割引'
  };
  const assumptionValue = (k, v) => k === 'revenue10yUsd' ? musd(v) : k === 'shares' && fin(v) ? num(v / 1e6, 0) + '百万株' : esc(v);

  const cell = (label, value, note = '') =>
    `<div><small>${esc(label)}</small><strong>${value}</strong>${note ? `<small>${esc(note)}</small>` : ''}</div>`;

  function render(d) {
    const l = d.latest || {};
    const ev = d.evaluation || {};
    const score = ev.masyaScore || {};
    const j = ev.judgment || {};
    const exit = ev.exit || {};
    const ten = ev.tenYear || {};
    const quote = d.quote;
    const missing = (score.missing || []).concat((j.signals || []).filter(s => s.type === 'missing').map(s => s.text));
    const prices = ten.prices && (ten.prices.withDilution || ten.prices.constantShares);
    const rows = (d.quarters || []).slice(-8).reverse().map(q => `<tr>
      <td>${esc(q.end)}${q.revenueDerived ? ' <span class="pm-muted" title="通期−9か月累計で算出">※算出</span>' : ''}</td>
      <td>${musd(q.revenue)}</td><td>${pct(q.revenueYoYPct)}</td><td>${pct(q.operatingMarginPct)}</td>
      <td>${pct(q.costRatioPct)}</td><td>${musd(q.fcf)}</td><td>${fin(q.epsDiluted) ? '$' + num(q.epsDiluted, 2) + (q.epsDilutedDerived ? '※' : '') : '—'}</td>
      <td>${num(q.ruleOf40, 1)}</td><td>${num(q.ruleOf40Legacy, 1)}</td></tr>`).join('');
    $('pm-analysis-result').innerHTML = `
      <p class="pm-callout" data-warn="true" id="pm-analysis-verification">
        <strong>検証中の参考値です。</strong>売買判断の正式な根拠には使わないでください（status: ${esc(d.status)}）。
        保有株数・現金・リバランス計算には一切反映されません。
      </p>
      <h3>${esc(d.name)}（${esc(d.ticker)}）</h3>
      <div class="pm-stage-grid" id="pm-analysis-summary">
        ${cell('マシャ総合スコア', fin(score.score) ? score.score + ' / 100' : '—', score.complete ? '' : 'データ不足あり')}
        ${cell('投資判断（参考）', esc(j.judgment || '—'), j.note || '')}
        ${cell('撤退シグナル', esc(exit.exitLabel || '—'), fin(exit.exitScore) ? 'スコア ' + exit.exitScore : '')}
        ${cell('TTM売上成長率', pct(l.revenueTtmYoYPct), '直近四半期 前年比 ' + pct(l.revenueYoYPct))}
        ${cell('TTM営業利益率', pct(l.operatingMarginTtmPct), 'TTM原価率 ' + pct(l.costRatioTtmPct))}
        ${cell('Rule of 40', num(l.ruleOf40, 1), '旧定義 ' + num(l.ruleOf40Legacy, 1))}
        ${cell('TTM FCF', musd(l.fcfTtm), 'FCFマージン ' + pct(l.fcfMarginTtmPct))}
        ${cell('希薄化後EPS（TTM）', fin(l.epsDilutedTtm) ? '$' + num(l.epsDilutedTtm, 2) : '—', '')}
        ${cell('株価', quote ? '$' + num(quote.price, 2) : '—', quote ? when(quote.asOf) : '株価未取得')}
      </div>
      ${missing.length ? `<p class="pm-callout" data-warn="true">データ不足（判定に加点・減点していない項目）：${missing.map(esc).join('／')}</p>` : ''}
      <div class="pm-wrap" tabindex="0" aria-label="四半期推移">
        <table class="pos-table" id="pm-analysis-quarters"><thead><tr><th>期末</th><th>売上</th><th>前年比</th><th>営業利益率</th>
          <th>原価率</th><th>FCF</th><th>希薄化後EPS</th><th>Rule of 40</th><th>旧定義</th></tr></thead><tbody>${rows}</tbody></table>
      </div>
      <details class="pm-card" id="pm-analysis-tenyear"><summary>10年後株価モデル（前提つき）</summary>
        ${prices ? `<div class="pm-stage-grid">
          ${cell('弱気', '$' + num(prices.bear, 2))}${cell('標準', '$' + num(prices.standard, 2))}${cell('強気（奥義）', '$' + num(prices.bull, 2))}
        </div>
        <p class="pm-small">期待リターン：${fin(ten.returnMultiple) ? ten.returnMultiple + '倍（年率' + num(ten.impliedAnnualReturnPct, 1) + '%）' : '株価未取得のため算出しない'}（希薄化版・標準価格基準、割引なし）</p>`
          : `<p class="pm-callout" data-warn="true">算出しない：${esc(ten.reason || '前提データ不足')}</p>`}
        ${(ten.warnings || []).map(w => `<p class="pm-callout" data-warn="true">⚠ ${esc(w)}</p>`).join('')}
        <ul class="pm-small">${Object.entries(ten.assumptions || {}).filter(([, v]) => typeof v !== 'object')
          .map(([k, v]) => `<li>${esc(ASSUMPTION_LABELS[k] || k)}：${assumptionValue(k, v)}</li>`).join('')}
          ${ten.assumptions && ten.assumptions.per ? `<li>PER（弱気／標準）：${esc(ten.assumptions.per.bear)}倍／${esc(ten.assumptions.per.standard)}倍（${esc(ten.assumptions.per.name)}）</li>` : ''}</ul>
      </details>
      <details class="pm-card"><summary>判定の内訳（${esc(j.bullScore)}点 / ${esc(j.bearScore)}点）</summary>
        <ul class="pm-small">${(j.signals || []).map(s => `<li>${esc(s.text)}</li>`).join('')}</ul>
        <ul class="pm-small">${(exit.signals || []).map(s => `<li>${esc(s.text)}</li>`).join('')}</ul>
      </details>
      <details class="pm-card"><summary>指標の定義</summary>
        <ul class="pm-small">${Object.entries(d.definitions || {}).map(([k, v]) => `<li><strong>${esc(k)}</strong>：${esc(v)}</li>`).join('')}</ul>
      </details>
      <p class="pm-muted pm-small" id="pm-analysis-source">
        出典：<a href="${esc(d.source && d.source.url)}" rel="noopener noreferrer" target="_blank">${esc(d.source && d.source.provider)}</a>
        ／取得 ${when(d.source && d.source.retrievedAt)}／通貨 ${esc(d.source && d.source.currency)}／${esc(d.source && d.source.note)}
        ${quote ? `／株価：${esc(quote.source)}` : ''}
      </p>`;
  }

  async function analyze(event) {
    event?.preventDefault();
    const input = $('pm-analysis-ticker');
    const ticker = String(input.value || '').trim().toUpperCase();
    if (!TICKER.test(ticker)) { status('銘柄コードの形式を確認してください（例：NVDA）。', 'error'); return; }
    input.value = ticker;
    const button = $('pm-analysis-run');
    button.disabled = true;
    status(ticker + ' のSEC財務データを取得しています…');
    $('pm-analysis-result').setAttribute('aria-busy', 'true');
    try {
      const out = await load(ticker);
      if (out.error) { status(out.error, 'error'); $('pm-analysis-result').innerHTML = ''; return; }
      render(out.data);
      status(out.cached ? '10分以内に取得したデータを表示しています。' : '');
    } finally {
      button.disabled = false;
      $('pm-analysis-result').removeAttribute('aria-busy');
    }
  }

  function refreshTickers() {
    const list = $('pm-analysis-tickers');
    if (!list) return;
    const state = root.PMApp && root.PMApp.state ? root.PMApp.state() : null;
    list.innerHTML = knownTickers(state).map(t => `<option value="${esc(t)}"></option>`).join('');
  }

  function init() {
    const form = $('pm-analysis-form');
    if (!form) return;
    form.addEventListener('submit', analyze);
    $('pm-analysis-ticker').addEventListener('focus', refreshTickers);
    refreshTickers();
    root.addEventListener('hashchange', () => { if (root.location.hash === '#analysis') refreshTickers(); });
  }

  root.PMAnalysis = { init, knownTickers, explain, load, render, clearCacheForTest: () => cache.clear() };
  if (typeof module === 'object' && module.exports) module.exports = root.PMAnalysis;
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(globalThis);
