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

  function html(g) {
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
    if (g.notes.length) out += '<ul class="pm-today-notes pm-small pm-muted">' + g.notes.map(n => '<li>' + esc(n) + '</li>').join('') + '</ul>';
    return out;
  }

  function render(input) {
    if (typeof document === 'undefined') return null;
    const g = plan(input);
    const host = document.getElementById('today-guide');
    if (host) { host.innerHTML = html(g); host.dataset.mode = g.mode; }
    const mini = document.getElementById('today-mini');
    if (mini) {
      const s = summary(g);
      mini.dataset.warn = String(s.warn);
      mini.innerHTML = '<strong>今日やること</strong>　' + esc(s.text) + '　<a href="#today">開く →</a>';
    }
    return g;
  }

  const api = { plan, summary, html, render, STAGED_TICKERS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMTodayGuide = api;
})(globalThis);
