'use strict';
// 「今日やること」: one ordered checklist that says which calculation to follow today
// (the staged A/B/C purchase or ③), the orders in execution order, and what to
// register afterwards. It never computes orders itself: it reads the results of
// PMRebalance.simulate (via PMApp.result) and PMStagedFunding.calc, so the numbers
// are always the same as in those sections. It never places orders.
((root) => {
  const Data = typeof module === 'object' && module.exports ? require('./data.js') : root.PMData;
  const Market = typeof module === 'object' && module.exports ? require('./market.js') : root.PMMarket;
  const ORDER_FX = ['spot', 'hourly', 'manual'];
  const STAGE = ['A日', 'B日', 'C日'];
  const CUM = ['累積50%', '累積80%', '累積100%'];
  const STAGED_TICKERS = ['NVDA', 'AVGO', 'CRDO'];

  /**
   * @param {object} p
   * @param {object} p.state     workspace
   * @param {object} p.market    { fx, quotes }
   * @param {object} p.result    PMApp.result() (③, already gated by spec/unsaved edits)
   * @param {object|null} p.staged  PMStagedFunding.calc(...) when a staged plan exists
   */
  function plan({ state, market, result, staged, blockers = [], now = Date.now() }) {
    const pending = (state.positions || []).filter(p => !Data.readyLot(p));
    const spec = Data.specIssues(state);
    const fx = market && market.fx;
    const fxReady = Market.fxStatus(fx, now) === 'ready' && ORDER_FX.includes(fx && fx.kind);
    const checks = [
      { key: 'holdings', ok: state.confirmed && !pending.length, href: '#overview',
        text: state.confirmed && !pending.length ? '実保有・現金を口座と照合済み'
          : pending.length ? '未確認の保有ロットが' + pending.length + '件あります。ロットを編集してから「実保有・現金を確認」を押す'
            : '保有ロットと現金を証券口座と照合し、「実保有・現金を確認」を押す' },
      { key: 'spec', ok: !spec.length, href: '#allocation',
        text: spec.length ? '目標配分が固定仕様と違います。①の「固定仕様に戻す」を押す' : '目標配分は固定仕様どおり' },
      { key: 'fx', ok: fxReady, href: fx && fx.rate ? '#rebalance' : '#overview',
        text: fxReady ? 'USD/JPY ' + fx.rate.toFixed(2) + '（' + fxLabel(fx) + '）を注文計算に使用'
          : !(fx && fx.rate) ? 'USD/JPYがまだ取得されていません。ダッシュボードの「株価・為替を更新」を押す'
            : 'USD/JPYが注文計算に使えません（日次参考値・期限切れ）。証券会社のUSD/JPYを②の「代替手段」に入力する' }
    ];
    const base = { checks, orders: [], notes: [], after: [], problems: [] };
    if (checks.some(c => !c.ok)) return { ...base, mode: 'blocked', title: '売買の前に確認すること' };
    if (blockers.length) return { ...base, mode: 'blocked', title: '売買の前に確認すること', problems: blockers };

    const sp = state.stagedFunding;
    if (sp) {
      const stage = sp.stage || 1;
      const name = STAGE[stage - 1] + '（' + CUM[stage - 1] + '）';
      const notes = ['段階買付の日は③の売買案を使いません。PLTR売却代金と3銘柄の購入を二重に数えてしまうためです。',
        'APP・SOFI・RKLB・SPCXなど段階買付の対象外の売買は、C日まで終えてから③で確認します。'];
      const after = ['約定したら、実際の約定株数・取得額を保有ロットに登録し、現金残高を更新する',
        '「実保有・現金を確認」を押す',
        stage < 3 ? '②の「' + STAGE[stage - 1] + 'の約定を登録済み → ' + STAGE[stage] + 'へ」を押す（次回は' + STAGE[stage] + 'の計算になります）'
          : 'C日が最終段階です。登録後は②の「初期保有の記録をリセット」で計画を終え、以後の調整は③で行う'];
      if (!staged || staged.errors.length)
        return { ...base, mode: 'blocked', title: '段階買付 ' + name + 'を計算できません', problems: staged ? staged.errors : ['段階買付の計算結果がありません。'] };
      const orders = [];
      if (staged.sale.shares > 0) orders.push({ side: 'sell', ticker: 'PLTR', shares: staged.sale.shares, jpy: staged.sale.gross,
        note: '税引後 約' + yen(staged.sale.net) + '・売却後PLTR ' + staged.afterPltrPct.toFixed(1) + '%' });
      for (const r of staged.rows) if (r.qty > 0) orders.push({ side: 'buy', ticker: r.ticker, shares: r.qty, jpy: r.qty * r.priceJpy });
      if (!orders.length) {
        return { ...base, mode: 'staged-none', title: '段階買付 ' + name + '：今日買う株はありません',
          notes: ['この段階の目標に既に届いています。' + (stage < 3 ? '購入しない場合は、②の「次へ」で「購入しなかった」を選んで進めます。' : '')],
          alerts: staged.alerts };
      }
      return { ...base, mode: 'staged', title: '段階買付 ' + name, orders, notes, after, alerts: staged.alerts,
        total: { sell: staged.sale.gross, buy: staged.buyTotal, tax: staged.sale.tax, fees: staged.sale.fee + staged.buyFees } };
    }

    if (!result || result.errors.length)
      return { ...base, mode: 'blocked', title: '③の売買案を計算できません', problems: result ? result.errors : ['③の計算結果がありません。'] };
    const rows = result.rows.filter(r => r.order);
    const orders = [
      ...rows.filter(r => r.order < 0).map(r => ({ side: 'sell', ticker: r.ticker, shares: -r.order, jpy: -r.order * r.jpy })),
      ...rows.filter(r => r.order > 0).map(r => ({ side: 'buy', ticker: r.ticker, shares: r.order, jpy: r.order * r.jpy }))
    ];
    const notes = ['PLTR売却資金でNVDA・AVGO・CRDOを3回に分けて買う場合は、③ではなく②の「買付計画を開始」から始めます。'];
    if (!orders.length) return { ...base, mode: 'none', title: '今日の売買はありません', notes: ['③の売買案に売買する銘柄がありません（目標配分の範囲内、または購入待機中）。', ...notes] };
    return { ...base, mode: 'rebalance', title: '③の売買案', orders, notes,
      after: ['約定したら、実際の約定株数・取得額を保有ロットに登録し、現金残高を更新する', '「実保有・現金を確認」を押す'],
      total: { sell: result.saleJpy, buy: result.purchaseJpy, tax: result.tax, fees: result.fees } };
  }

  function fxLabel(fx) {
    return fx.kind === 'manual' ? '証券会社・手入力' : fx.kind === 'spot' ? 'スポット' : '時間更新';
  }
  const yen = n => Number.isFinite(n) ? '¥' + Math.round(n).toLocaleString('ja-JP') : '—';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** One line for the dashboard. */
  function summary(g) {
    if (g.mode === 'blocked') return { text: g.title + '：' + (g.checks.find(c => !c.ok)?.text || g.problems[0] || ''), warn: true };
    if (!g.orders.length) return { text: g.title, warn: false };
    return { text: g.title + '：' + g.orders.map(o => (o.side === 'sell' ? '売 ' : '買 ') + o.ticker + ' ' + o.shares + '株').join('・'), warn: false };
  }

  const pct = (x, d = 1) => x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%';

  /**
   * Reference lines from the research (never changes orders):
   *  - regime: today's state and what followed the closest past state (60 days, JPY)
   *  - vix:    the VIX>=30 study, shown when VIX is >= its threshold or a staged plan is running
   */
  function researchNote(regime, study, { staged = false } = {}) {
    const lines = [];
    if (regime && regime.state) {
      const s = regime.state;
      const vol = s.vol ? `変動 ${s.vol}${Number.isFinite(s.vix) ? `（VIX ${Number(s.vix).toFixed(1)}）` : ''}・` : '';
      let line = `相場の参考：${s.trend}トレンド・${vol}${s.depth}（52週高値から ${pct(s.dd)}）。`;
      const c = regime.pick?.c, b = regime.base;
      if (c && b) {
        const ci = c.medianCI95;
        const vs = !ci ? '' : ci[0] > b.median ? '普段より高め' : ci[1] < b.median ? '普段より低め' : '普段と差があるとは言えない';
        line += `過去の近い状態（${regime.pickName}）から${regime.horizon}営業日後（円建て）：中央値 ${pct(c.median)}`
          + (ci ? `（95%区間 ${pct(ci[0])}〜${pct(ci[1])}、局面${c.episodes}回）` : '')
          + `／全期間 ${pct(b.median)} → ${vs}。下位5%は ${pct(c.q05)}（全期間 ${pct(b.q05)}）。`;
      }
      lines.push(line);
    }
    const sm = study?.summary?.['120'];
    const threshold = study?.params?.threshold ?? 30;
    const inEvent = !!regime?.state && Number.isFinite(regime.state.vix) && regime.state.vix >= threshold;
    if (sm && (inEvent || staged)) {
      const d2 = sm.S2?.jpy?.diffVsS1, d3 = sm.S3?.jpy?.diffVsS1;
      const v = d => !d ? '' : d.meanCI95[1] < 0 ? '不利（差あり）' : d.meanCI95[0] > 0 ? '有利（差あり）' : '差があるとは言えない';
      lines.push(`VIX≥${threshold}の局面の研究（過去${sm.events}回、120営業日後・円建て）：50/30/20の分割と翌日一括の差は平均 ${pct(d2?.mean)}（${v(d2)}）。`
        + `VIX<20まで待つのは平均 ${pct(d3?.mean)}（${v(d3)}）。`);
    }
    return lines;
  }

  function html(g, research = []) {
    const step = (ok, text, href) => '<li class="pm-today-check" data-ok="' + ok + '"><span aria-hidden="true">' + (ok ? '✓' : '!') + '</span> ' +
      (href && !ok ? '<a href="' + href + '">' + esc(text) + '</a>' : esc(text)) + '</li>';
    let out = '<ol class="pm-today-checks">' + g.checks.map(c => step(c.ok, c.text, c.href)).join('') + '</ol>';
    out += '<h3 class="pm-today-title">' + esc(g.title) + '</h3>';
    if (g.problems.length) out += '<p class="pm-callout" data-warn="true" role="alert">' + g.problems.map(esc).join(' ') + '</p>';
    if (g.alerts && g.alerts.length) out += '<p class="pm-callout" data-warn="true" role="alert">' + g.alerts.map(esc).join(' ') + '</p>';
    if (g.orders.length) {
      out += '<p class="pm-muted pm-small">発注の順番（売却 → 購入）。アプリは発注しません。証券会社の画面で株価・適用為替・買付余力を確認してから注文してください。</p>' +
        '<ol class="pm-today-orders">' + g.orders.map(o => '<li><strong class="pm-today-side" data-side="' + o.side + '">' + (o.side === 'sell' ? '売却' : '購入') +
          '</strong> ' + esc(o.ticker) + ' <strong>' + o.shares + '株</strong> <span class="pm-muted">（約' + yen(o.jpy) + (o.note ? '・' + esc(o.note) : '') + '）</span></li>').join('') + '</ol>';
      if (g.total) out += '<p class="pm-muted pm-small">売却 約' + yen(g.total.sell) + '／購入 約' + yen(g.total.buy) + '／概算譲渡税 ' + yen(g.total.tax) + '／手数料 ' + yen(g.total.fees) + '</p>';
    }
    if (g.after.length) out += '<h4 class="pm-today-sub">約定した後</h4><ol class="pm-today-after">' + g.after.map(a => '<li>' + esc(a) + '</li>').join('') + '</ol>';
    if (research.length) out += '<div class="pm-today-research pm-small"><h4 class="pm-today-sub">相場の参考（売買の株数・順番は変わりません）</h4>'
      + research.map(r => '<p>' + esc(r) + '</p>').join('') + '<p class="pm-muted">過去の傾向であり、売買の推奨ではありません。<a href="#market">市場分析で詳しく →</a></p></div>';
    if (g.notes.length) out += '<ul class="pm-today-notes pm-small pm-muted">' + g.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
    return out;
  }

  const researchNow = staged => researchNote(root.PMMarketRegime?.summary?.() || null, root.PMResearchResults?.summary?.() || null, { staged });
  let lastInput = null;

  function render(input) {
    if (typeof document === 'undefined') return null;
    lastInput = input;
    const g = plan(input);
    const staged = !!input.state?.stagedFunding;
    const research = researchNow(staged);
    const host = document.getElementById('today-guide');
    if (host) { host.innerHTML = html(g, research); host.dataset.mode = g.mode; }
    const stagedNote = document.getElementById('pm-staged-research');
    if (stagedNote) {
      const lines = researchNote(null, root.PMResearchResults?.summary?.() || null, { staged: true });
      stagedNote.textContent = lines.length ? '参考（研究結果）：' + lines.join(' ') : '';
      stagedNote.hidden = !lines.length;
    }
    const mini = document.getElementById('today-mini');
    if (mini) {
      const s = summary(g);
      mini.dataset.warn = String(s.warn);
      mini.innerHTML = '<strong>今日やること</strong>　' + esc(s.text) + '　<a href="#today">開く →</a>';
    }
    return g;
  }

  const api = { plan, summary, html, render, researchNote, STAGED_TICKERS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PMTodayGuide = api;
    // Research loads after the page; show it as soon as it arrives.
    root.addEventListener('pm:research-ready', () => { if (lastInput) render(lastInput); });
  }
})(globalThis);
