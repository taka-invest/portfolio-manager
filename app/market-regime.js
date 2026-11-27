'use strict';
// 現在の相場の状態と、過去に同じ状態だった日からの値動き（research-engine/regime_study.py の集計）。
// Today's state is classified with the SAME thresholds stored in the result (params).
// Live values come from the own market API; when they are unavailable the result's own
// last FRED date is used and labelled as such. Never produces an order.
((root) => {
  const ID = 'market-regime';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = (x, d = 1) => x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';
  const LEVEL_NAMES = { 'trend|vol|depth': 'トレンド・変動・下落幅がすべて同じ', 'vol|depth': '変動・下落幅が同じ', vol: '変動（VIX）が同じ', all: '全期間（基準）' };

  function volBand(vix, p) { for (const [upper, label] of p.vixBands) if (upper == null || vix < upper) return label; return null; }
  function depthBand(dd, p) { for (const [lower, label] of p.depthBands) if (lower == null || dd > lower) return label; return null; }

  /** Classify from daily closes (oldest first) and the latest VIX, using the study's params. */
  function classify(closes, vix, p) {
    const c = closes.filter(x => Number.isFinite(x) && x > 0);
    if (c.length < Math.max(p.ma, p.highWindow) || !Number.isFinite(vix)) return null;
    const px = c[c.length - 1];
    const ma = c.slice(-p.ma).reduce((a, b) => a + b, 0) / p.ma;
    const high = Math.max(...c.slice(-p.highWindow));
    const dd = px / high - 1;
    return { px, ma, dd, vix, trend: px >= ma ? '上昇' : '下落', vol: volBand(vix, p), depth: depthBand(dd, p) };
  }

  const keyOf = (state, level) => level === 'all' ? 'all:全期間' : level + ':' + level.split('|').map(f => state[f]).join('・');

  function html(r, state, source, horizon = '60', ccy = 'jpy') {
    const p = r.params;
    const rows = r.levels.map(level => {
      const g = r.groups[keyOf(state, level)];
      const c = g?.horizons?.[horizon]?.[ccy];
      return { level, g, c };
    });
    // Most specific level with enough separate episodes is the headline.
    const pick = rows.find(x => x.c && x.c.episodes >= p.minEpisodes && x.level !== 'all') || rows.find(x => x.level === 'all');
    const tr = rows.map(({ level, g, c }) => `<tr data-level="${level}"${pick && pick.level === level ? ' class="pm-regime-pick"' : ''}>
      <th scope="row">${esc(LEVEL_NAMES[level])}${level !== 'all' ? `<br><span class="pm-muted pm-small">${esc(keyOf(state, level).split(':')[1])}</span>` : ''}</th>
      ${c ? `<td>${c.episodes}回<br><span class="pm-muted pm-small">${g.days}日</span></td><td>${pct(c.median)}</td>
        <td>${c.medianCI95 ? `${pct(c.medianCI95[0])}〜${pct(c.medianCI95[1])}` : '—'}</td><td>${pct(c.q05)}</td><td>${pct(c.q95)}</td><td>${Math.round(c.positive * 100)}%</td>
        <td>${c.episodes < p.minEpisodes && level !== 'all' ? '少数（参考外）' : ''}</td>`
        : '<td colspan="7" class="pm-muted">過去に該当する日がありません</td>'}</tr>`).join('');
    const btn = (k, v, label, cur) => `<button type="button" class="btn btn-ghost btn-sm${v === cur ? ' pm-study-active' : ''}" data-${k}="${v}" aria-pressed="${v === cur}">${label}</button>`;
    return `
      <p class="pm-regime-now"><strong>${esc(state.trend)}トレンド</strong>（200日線比 ${pct(state.px / state.ma - 1)}）・
        <strong>変動 ${esc(state.vol)}</strong>（VIX ${state.vix.toFixed(1)}）・<strong>${esc(state.depth)}</strong>（52週高値から ${pct(state.dd)}）</p>
      <p class="pm-muted pm-small">${esc(source)}</p>
      <div class="pm-actions pm-study-switch">
        ${btn('rh', '20', '20営業日後', horizon)}${btn('rh', '60', '60営業日後', horizon)}${btn('rh', '250', '250営業日後', horizon)}
        <span class="pm-muted pm-small">｜</span>${btn('rc', 'jpy', '円建て', ccy)}${btn('rc', 'usd', 'ドル建て', ccy)}
      </div>
      <div class="pm-wrap" tabindex="0"><table class="pos-table pm-regime-table">
        <thead><tr><th scope="col">比べた過去の日</th><th scope="col">局面の数</th><th scope="col">中央値</th><th scope="col">中央値の95%区間</th>
          <th scope="col">下位5%</th><th scope="col">上位5%</th><th scope="col">プラスの割合</th><th scope="col"></th></tr></thead>
        <tbody>${tr}</tbody></table></div>
      <ul class="pm-muted pm-small pm-study-notes">
        <li>NASDAQ-100・${esc(r.dates[0])}〜${esc(r.dates[1])}・版 ${esc(r.version)}。翌営業日の終値で買った場合の値動き</li>
        ${(r.assumptions || []).map(a => `<li>${esc(a)}</li>`).join('')}
        <li>太字の行は、局面が${p.minEpisodes}回以上ある中で最も条件の近い比較。区間が「全期間」の中央値をまたぐなら、普段と差があるとは言えない。過去の傾向であり、売買の推奨ではない</li>
      </ul>`;
  }

  let result = null, state = null, source = '', horizon = '60', ccy = 'jpy', loading = null;
  function draw() {
    const host = document.getElementById('research-regime-body');
    if (!host || !result || !state) return;
    host.innerHTML = html(result, state, source, horizon, ccy);
    host.querySelectorAll('[data-rh]').forEach(b => { b.onclick = () => { horizon = b.dataset.rh; draw(); }; });
    host.querySelectorAll('[data-rc]').forEach(b => { b.onclick = () => { ccy = b.dataset.rc; draw(); }; });
  }
  function status(text) {
    const host = document.getElementById('research-regime-body');
    if (host) host.innerHTML = `<p class="pm-muted">${esc(text)}</p>`;
  }
  async function liveState(p) {
    const md = root.PMMarketData;
    if (!md) return null;
    try {
      const [ndx, vix] = await Promise.all([
        md.chart('https://query1.finance.yahoo.com/v8/finance/chart/%5ENDX?range=2y&interval=1d'),
        md.chart('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?range=5d&interval=1d')]);
      const closes = ndx?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      const v = (vix?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || []).filter(Number.isFinite).pop();
      const ts = (ndx?.chart?.result?.[0]?.timestamp || []).filter(Number.isFinite).pop();
      const s = classify(closes, v, p);
      return s ? { state: s, at: ts ? new Date(ts * 1000) : null } : null;
    } catch { return null; }
  }
  async function load() {
    if (loading || !document.getElementById('research-regime-body')) return loading;
    loading = (async () => {
      if (!root.PMCloud && root.PMCloudReady) await Promise.race([root.PMCloudReady, new Promise(r => setTimeout(r, 6000))]);
      const cloud = root.PMCloud;
      if (!cloud || typeof cloud.readResearch !== 'function') return status('相場の状態の研究結果はログイン後に表示します。');
      try {
        const doc = await cloud.readResearch(ID);
        if (!doc) return status('ログインすると表示します。保存済みの結果がない場合は、手元で research-engine を実行して保存してください。');
        result = JSON.parse(doc.json);
        const live = await liveState(result.params);
        if (live) {
          state = live.state;
          source = '判定に使った現在値：自前API（NASDAQ-100 日足・VIX）' + (live.at ? '・' + live.at.toLocaleDateString('ja-JP') + 'の終値まで' : '');
        } else {
          state = result.current;
          source = `現在値を取得できないため、研究データの最終日（${result.current.date}、FRED）の状態を表示しています`;
        }
        draw();
        root.dispatchEvent(new CustomEvent('pm:research-ready'));
      } catch {
        loading = null;
        status('相場の状態の研究結果を読み込めませんでした。再度この画面を開いてください。');
      }
    })();
    return loading;
  }
  /** Compact summary for 今日やること (60 trading days, JPY): today's state, closest comparison, baseline. */
  function summary(h = '60', c = 'jpy') {
    if (!result || !state) return null;
    const p = result.params;
    const rows = result.levels.map(level => ({ level, c: result.groups[keyOf(state, level)]?.horizons?.[h]?.[c] }));
    const pick = rows.find(x => x.c && x.c.episodes >= p.minEpisodes && x.level !== 'all');
    const base = rows.find(x => x.level === 'all')?.c || null;
    return { state, source, horizon: h, pick: pick || null, pickName: pick ? LEVEL_NAMES[pick.level] : null, base };
  }
  function init() {
    const maybe = () => { if (['market', 'today', 'allocation', 'rebalance', 'after', 'overview'].includes(decodeURIComponent(root.location.hash.slice(1)) || 'overview')) load(); };
    root.addEventListener('hashchange', maybe);
    maybe();
  }

  const api = { classify, keyOf, html, load, init, summary };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.PMMarketRegime = api; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init(); }
})(globalThis);
