'use strict';
// 研究結果：VIX≥30の局面での買い方の比較（research-engine/vix_event_study.py の集計）。
// Read-only view of users/{uid}/research/vix-event-study. Shows counts, intervals,
// assumptions and limits next to every number; never turns the result into an order.
((root) => {
  const ID = 'vix-event-study';
  const NAMES = { S1: '翌日に全額', S2: '50/30/20で分割', S3: 'VIX<20まで待つ', S4: '反発を確認して買う' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x, d = 1) => x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';

  /** Verdict from a 95% interval of (strategy − S1). */
  function verdict(ci) {
    if (!ci) return { text: '—', cls: '' };
    if (ci[1] < 0) return { text: '不利（差あり）', cls: 'pm-study-worse' };
    if (ci[0] > 0) return { text: '有利（差あり）', cls: 'pm-study-better' };
    return { text: '差があるとは言えない', cls: 'pm-study-none' };
  }

  function html(r, horizon = '120', ccy = 'jpy') {
    const s = r.summary?.[horizon];
    if (!s) return '<p class="pm-muted">この期間の結果がありません。</p>';
    const n = s.events;
    const rows = Object.keys(NAMES).map(k => {
      const c = s[k]?.[ccy] || {};
      const d = c.diffVsS1;
      const v = verdict(d?.meanCI95);
      return `<tr data-strategy="${k}">
        <th scope="row">${k} ${esc(NAMES[k])}</th>
        <td>${pct(c.median)}</td><td>${c.positive ?? '—'}/${n}</td><td>${pct(c.q05)}</td><td>${pct(c.min)}</td>
        <td>${pct(c.medianMae)}</td><td>${c.lagMedian ?? '—'}日</td>
        <td>${d ? `${pct(d.mean)}<br><span class="pm-muted pm-small">95%区間 ${pct(d.meanCI95[0])}〜${pct(d.meanCI95[1])}</span>` : '—'}</td>
        <td>${d ? `${d.better}/${d.better + d.worse}` : '—'}</td>
        <td class="${v.cls}">${k === 'S1' ? '基準' : v.text}</td></tr>`;
    }).join('');
    const pending = (r.perEvent || []).filter(e => e.strategies?.S1?.[horizon] == null);
    const events = (r.perEvent || []).filter(e => e.strategies?.S1?.[horizon] != null).map(e =>
      `<tr><td>${esc(e.t0)}</td><td>${Number(e.vix).toFixed(1)}</td>${Object.keys(NAMES).map(k => `<td>${pct(e.strategies[k][horizon]?.[ccy])}</td>`).join('')}
        <td>${esc(e.strategies.S3.firstFill || '—')}${e.strategies.S3.signalFired ? '' : '（期限）'}</td><td>${esc(e.strategies.S4.firstFill || '—')}</td></tr>`).join('');
    const btn = (key, val, label, cur) => `<button type="button" class="btn btn-ghost btn-sm${val === cur ? ' pm-study-active' : ''}" data-${key}="${val}" aria-pressed="${val === cur}">${label}</button>`;
    return `
      <p class="pm-small">NASDAQ-100（配当なしの価格指数）・${esc(r.dates?.[0])}〜${esc(r.dates?.[1])}・VIX≥30の局面 ${r.eventCount}回（この期間を評価できたのは${n}回）・版 ${esc(r.version)}・計算 ${esc(String(r.computedAt || '').slice(0, 10))}</p>
      <div class="pm-actions pm-study-switch">
        ${btn('horizon', '60', '60営業日後', horizon)}${btn('horizon', '120', '120営業日後', horizon)}${btn('horizon', '250', '250営業日後', horizon)}
        <span class="pm-muted pm-small">｜</span>${btn('ccy', 'jpy', '円建て', ccy)}${btn('ccy', 'usd', 'ドル建て', ccy)}
      </div>
      <div class="pm-wrap" tabindex="0"><table class="pos-table pm-study-table">
        <thead><tr><th scope="col">買い方</th><th scope="col">中央値</th><th scope="col">プラスの回数</th><th scope="col">下位5%</th><th scope="col">最悪</th>
          <th scope="col">買った後の最大下落（中央値）</th><th scope="col">買うまで（中央値）</th><th scope="col">S1との差（平均）</th><th scope="col">S1より良かった回数</th><th scope="col">判定</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      ${pending.length ? `<p class="pm-callout pm-small" data-warn="true">集計に入っていない進行中の局面：${pending.map(e => `${esc(e.t0)}（VIX ${Number(e.vix).toFixed(1)}）`).join('、')}</p>` : ''}
      <details class="pm-card pm-extra-details"><summary>局面ごとの結果（${n}回）</summary>
        <div class="pm-wrap" tabindex="0"><table class="pos-table"><thead><tr><th>開始日</th><th>VIX</th>${Object.keys(NAMES).map(k => `<th>${k}</th>`).join('')}<th>S3の購入日</th><th>S4の購入日</th></tr></thead><tbody>${events}</tbody></table></div>
      </details>
      <ul class="pm-muted pm-small pm-study-notes">
        ${(r.assumptions || []).map(a => `<li>${esc(a)}</li>`).join('')}
        <li>判定は「S1との差」の95%信頼区間（局面単位のブートストラップ）が0をまたぐかどうか。比べた組み合わせは3戦略×3期間×2通貨の18通りで、多重比較の補正はしていない</li>
        <li>局面の数が少なく、2000年・2008年のような長い下落相場が結果を大きく左右する。過去の傾向であり、売買の推奨ではない</li>
      </ul>`;
  }

  let result = null, horizon = '120', ccy = 'jpy', loading = null;
  function draw() {
    const host = typeof document !== 'undefined' && document.getElementById('research-vix-body');
    if (!host || !result) return;
    host.innerHTML = html(result, horizon, ccy);
    host.querySelectorAll('[data-horizon]').forEach(b => { b.onclick = () => { horizon = b.dataset.horizon; draw(); }; });
    host.querySelectorAll('[data-ccy]').forEach(b => { b.onclick = () => { ccy = b.dataset.ccy; draw(); }; });
  }
  function status(text) {
    const host = document.getElementById('research-vix-body');
    if (host) host.innerHTML = `<p class="pm-muted">${esc(text)}</p>`;
  }
  async function load() {
    if (loading || !document.getElementById('research-vix-body')) return loading;
    loading = (async () => {
      if (!root.PMCloud && root.PMCloudReady) await Promise.race([root.PMCloudReady, new Promise(r => setTimeout(r, 6000))]);
      const cloud = root.PMCloud;
      if (!cloud || typeof cloud.readResearch !== 'function') return status('研究結果はログイン後に表示します（「設定・データ管理」からGoogleログイン）。');
      try {
        const doc = await cloud.readResearch(ID);
        if (!doc) return status('ログインすると研究結果を表示します。保存済みの結果がない場合は、手元で research-engine を実行して保存してください。');
        result = JSON.parse(doc.json);
        draw();
        root.dispatchEvent(new CustomEvent('pm:research-ready'));
      } catch {
        loading = null;
        status('研究結果を読み込めませんでした。再度この画面を開いてください。');
      }
    })();
    return loading;
  }
  function init() {
    const maybe = () => { if (['market', 'today', 'allocation', 'rebalance', 'after', 'overview'].includes(decodeURIComponent(root.location.hash.slice(1)) || 'overview')) load(); };
    root.addEventListener('hashchange', maybe);
    maybe();
  }

  const api = { html, verdict, load, init, NAMES, summary: () => result };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PMResearchResults = api; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init(); }
})(globalThis);
