'use strict';

// Rolling cumulative targets: A 50%, B 80%, C 100% of the currently
// revalued TOTAL additional investment need. Never fixed yen tranche budgets.
// This code is a reference calculator, not a broker order interface.
((root) => {
  const Market = typeof module === 'object' && module.exports
    ? require('./market.js') : root.PMMarket;
  const Rebalance = typeof module === 'object' && module.exports
    ? require('./rebalance.js') : root.PMRebalance;
  const TICKERS = Object.freeze(['NVDA', 'AVGO', 'CRDO']);
  const DEFAULT_TARGETS = Object.freeze({ NVDA: 15, AVGO: 10, CRDO: 3 });
  const TRANCHE = Object.freeze([0.5, 0.8, 1]);
  const FLOOR = 30;
  const EPS = 0.001;
  const sum = (rows, f) => rows.reduce((acc, row) => acc + f(row), 0);
  const feeUsd = amount => amount <= 0 ? 0 : Math.min(22, amount * 0.00495);
  const same = (a, b) => Math.abs(a - b) < 0.005;

  function snapshot(state, now = Date.now()) {
    const baselineShares = Object.fromEntries(TICKERS.map(ticker => [
      ticker, sum((state.positions || []).filter(p => p.kind === 'stock' && p.ticker === ticker), p => p.shares)
    ]));
    return { startedAt: new Date(now).toISOString(), baselineShares };
  }

  function calc(state, market, stage = 1, now = Date.now()) {
    const errors = [], alerts = [];
    if (![1, 2, 3].includes(stage)) errors.push('購入段階が不正です。');
    if (!state || !state.confirmed) errors.push('保有ロット・現金残高を口座と照合して確定してください。');
    const plan = state && state.stagedFunding;
    if (!plan || !plan.baselineShares)
      errors.push('A日の購入前に「買付計画を開始」を押し、当初保有株数を保存してください。');
    if (Market.fxStatus(market && market.fx, now) !== 'ready' ||
        !['spot', 'hourly', 'manual'].includes(market && market.fx && market.fx.kind))
      errors.push('売買計算には更新時刻の確認できるUSD/JPYレート、または10分以内に証券会社で確認した手入力レートが必要です（日次ECB参考値は使用しません）。');
    const rate = market && market.fx && market.fx.rate;
    const lots = (state && state.positions || []).filter(p => p.kind === 'stock');
    const tickers = new Set([...lots.map(p => p.ticker), ...TICKERS, 'PLTR']);
    for (const ticker of tickers)
      if (Market.quoteStatus(market && market.quotes && market.quotes[ticker], now) !== 'ready')
        errors.push(ticker + 'の株価が未取得または古い状態です。');
    const shares = new Map();
    for (const p of lots) {
      if (!Number.isSafeInteger(p.shares) || p.shares < 0)
        errors.push(p.ticker + 'の保有数量が整数株ではありません。');
      shares.set(p.ticker, (shares.get(p.ticker) || 0) + p.shares);
    }
    const targetMap = new Map((state && state.targets || []).map(t => [t.ticker, t]));
    const weights = Object.fromEntries(TICKERS.map(ticker =>
      [ticker, targetMap.has(ticker) ? targetMap.get(ticker).pct : DEFAULT_TARGETS[ticker]]));
    if (TICKERS.some(t => !Number.isFinite(weights[t]) || weights[t] < 0 || weights[t] > 100) ||
        sum(TICKERS, t => weights[t]) > 100)
      errors.push('3銘柄の目標比率が正しくありません。');
    if (plan && plan.baselineShares &&
        TICKERS.some(t => !Number.isSafeInteger(plan.baselineShares[t]) || plan.baselineShares[t] < 0))
      errors.push('開始時の保有株数が不正です。');
    const pltr = lots.filter(p => p.ticker === 'PLTR');
    const pltrShares = shares.get('PLTR') || 0;
    if (!pltrShares) errors.push('PLTRの保有株がありません。');
    if (pltr.some(p => p.costJpy == null || !Number.isFinite(p.costJpy) ||
        !p.broker || p.accountType !== 'specific'))
      errors.push('PLTRの取得原価または特定口座情報を確認してください。');
    const cash = rate > 0 ? Rebalance.cashValue(state.cash, rate) : null;
    if (cash == null || !Number.isFinite(cash) || cash < 0)
      errors.push('円・米ドルの現金情報が不正です。');
    if (errors.length) return { errors, alerts, stage, rate };
    const price = ticker => market.quotes[ticker].usd * rate;
    const total = cash + sum(lots, p => p.shares * price(p.ticker));
    if (!(total > 0)) return { errors: ['評価対象の資産がありません。'], alerts, stage, rate };
    const pltrPrice = price('PLTR');
    const pUsd = market.quotes.PLTR.usd;
    const accounts = new Map();
    for (const p of pltr) {
      const key = JSON.stringify([p.broker, p.account, p.accountType]);
      if (!accounts.has(key)) accounts.set(key, { shares: 0, basis: 0 });
      const entry = accounts.get(key);
      entry.shares += p.shares;
      entry.basis += p.costJpy;
    }
    const taxRate = state.tax && state.tax.rate != null ? state.tax.rate : 20.315;
    function sale(q) {
      let left = q, grossGain = 0, positiveGain = 0;
      for (const acc of accounts.values()) {
        const used = Math.min(left, acc.shares);
        if (!used) continue;
        const profit = used * (pltrPrice - acc.basis / acc.shares);
        grossGain += profit;
        positiveGain += Math.max(0, profit);
        left -= used;
      }
      const grossUsd = q * pUsd, gross = q * pltrPrice;
      const commission = feeUsd(grossUsd) * rate;
      const taxable = state.tax && state.tax.offset === 'eligible' ? grossGain : positiveGain;
      const tax = Math.ceil(Math.max(0, taxable - commission) * taxRate / 100);
      const postTotal = total - tax - commission;
      return { shares: q, gross, grossUsd, fee: commission,
        tax, net: gross - tax - commission, postTotal,
        pltrValue: (pltrShares - q) * pltrPrice,
        pltrPct: postTotal > 0 ? 100 * (pltrShares - q) * pltrPrice / postTotal : 0 };
    }

    // Estimate stage's cumulative target amount using the POST-tax portfolio.
    // Baseline holdings are valued at the CURRENT prices, not inception prices.
    // Previously purchased shares are also revalued at CURRENT prices.
    function goals(s) {
      let buyFees = 0, rows = [];
      for (let iteration = 0; iteration < 8; iteration++) {
        const investableTotal = s.postTotal - buyFees;
        rows = TICKERS.map(ticker => {
          const p = price(ticker);
          const currentShares = shares.get(ticker) || 0;
          const initialShares = plan.baselineShares[ticker];
          const targetPct = weights[ticker];
          const targetValue = Math.max(0, investableTotal * targetPct / 100);
          const initialValue = initialShares * p;
          const currentValue = currentShares * p;
          const totalInitialGap = Math.max(0, targetValue - initialValue);
          const cumulativeGoal = totalInitialGap * TRANCHE[stage - 1];
          const executedValue = (currentShares - initialShares) * p;
          // No purchase beyond CURRENT full target, even if earlier transactions
          // were done outside the staged plan or rounding changed.
          const pending = Math.max(0, Math.min(cumulativeGoal - executedValue,
            targetValue - currentValue));
          const maxQty = Math.max(0, Math.floor(pending / p + 1e-9));
          return { ticker, targetPct, initialShares, currentShares, initialValue,
            currentValue, targetValue, totalInitialGap, cumulativeGoal,
            executedValue, gap: pending, maxQty, qty: maxQty, usd: market.quotes[ticker].usd,
            priceJpy: p };
        });
        const nextFee = sum(rows, r => feeUsd(r.maxQty * r.usd) * rate);
        if (same(nextFee, buyFees)) { buyFees = nextFee; break; }
        buyFees = nextFee;
      }
      const buyValue = sum(rows, r => r.maxQty * r.priceJpy);
      const buyFeesFinal = sum(rows, r => feeUsd(r.maxQty * r.usd) * rate);
      return { rows, buyValue, buyFees: buyFeesFinal,
        required: buyValue + buyFeesFinal,
        idealShortfall: sum(rows, r => r.gap) };
    }

    // Check strict PLTR 30% floor after tax and PLTR sale fees.
    // If PLTR is already below 30%, zero shares is the only permitted sale.
    let maxShares = 0;
    if (sale(0).pltrPct + 1e-8 >= FLOOR) {
      let lo = 0, hi = pltrShares;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (sale(mid).pltrPct + 1e-8 >= FLOOR) lo = mid;
        else hi = mid - 1;
      }
      maxShares = lo;
    }
    const maxFunding = sale(maxShares);
    const affordable = q => sale(q).net + EPS >= goals(sale(q)).required;
    // Minimum integer PLTR shares required to fund the dynamically revalued
    // tranche target. Both the required amount and the tax depend on q.
    let selected = 0;
    if (!affordable(0)) {
      if (affordable(maxShares)) {
        let lo = 0, hi = maxShares;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          if (affordable(mid)) hi = mid;
          else lo = mid + 1;
        }
        selected = lo;
      } else selected = maxShares;
    }
    const funding = sale(selected);
    const ideal = goals(funding);
    const budget = Math.max(0, funding.net);

    // The floor can make full purchase impossible. Allocate only within NET
    // proceeds; do not silently use unrelated cash or exceed each ticker's gap.
    const rows = ideal.rows.map(r => ({ ...r }));
    function actualCost() {
      return sum(rows, r => r.qty * r.priceJpy + feeUsd(r.qty * r.usd) * rate);
    }
    if (actualCost() > budget + EPS) {
      const fraction = ideal.required > 0 ? Math.min(1, budget / ideal.required) : 0;
      for (const row of rows) row.qty = Math.floor(row.maxQty * fraction);
      while (actualCost() > budget + EPS) {
        const row = rows.filter(r => r.qty > 0)
          .sort((a, b) => a.qty * a.priceJpy - b.qty * b.priceJpy)[0];
        if (!row) break;
        row.qty--;
      }
      // Remaining cash is allocated to the ticker with the greatest
      // proportional shortfall relative to its stage-specific target.
      for (let i = 0; i < 20000; i++) {
        const available = rows.filter(r => r.qty < r.maxQty &&
          actualCost() + r.priceJpy +
          (feeUsd((r.qty + 1) * r.usd) - feeUsd(r.qty * r.usd)) * rate <= budget + EPS);
        if (!available.length) break;
        available.sort((a, b) =>
          (b.maxQty - b.qty) / Math.max(1, b.maxQty) -
          (a.maxQty - a.qty) / Math.max(1, a.maxQty));
        available[0].qty++;
      }
    }
    const buyValue = sum(rows, r => r.qty * r.priceJpy);
    const buyFees = sum(rows, r => feeUsd(r.qty * r.usd) * rate);
    const buyTotal = buyValue + buyFees;
    const shortage = Math.max(0, ideal.required - buyTotal);
    if (shortage > EPS && selected === maxShares)
      alerts.push('PLTR30%下限により、今回の累積買付目標には未達です。不足額を確認してください。');
    if (maxShares === 0)
      alerts.push('PLTRは現在30%以下、または追加売却の余地がありません。売却0株とします。');
    if (buyTotal > funding.net + EPS)
      errors.push('購入額がPLTR税引後売却代金を超えました。発注不可です。');
    if (funding.shares > 0 && funding.pltrPct + 1e-8 < FLOOR)
      errors.push('PLTRの売却後比率が30%を下回ります。発注不可です。');
    return {
      errors, alerts, stage, stagePct: TRANCHE[stage - 1] * 100,
      rate, fx: market.fx, total, cash,
      weights, initial: plan, beforePltrPct: sale(0).pltrPct,
      afterPltrPct: funding.pltrPct,
      maxShares, maxFunding: maxFunding.net, sale: funding,
      idealBudget: ideal.required, idealShortfall: ideal.idealShortfall,
      buyValue, buyFees, buyTotal, shortage,
      leftOver: Math.max(0, funding.net - buyTotal), rows
    };
  }

  const yen = n => Number.isFinite(n) ? '¥' + Math.round(n).toLocaleString('ja-JP') : '—';
  const usd = n => Number.isFinite(n) ? '$' + n.toFixed(2) : '—';
  const pct = n => Number.isFinite(n) ? n.toFixed(2) + '%' : '—';
  const safe = s => String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cell = (label, value) => '<div><small>' + safe(label) +
    '</small><strong>' + safe(value) + '</strong></div>';
  let stage = 1;
  function render(state, market) {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('pm-staged-funding-result');
    if (!host) return;
    const started = !!state.stagedFunding;
    const start = document.getElementById('pm-staged-start');
    const reset = document.getElementById('pm-staged-reset');
    if (start) { start.hidden = started; start.disabled = !state.confirmed; }
    if (reset) reset.hidden = !started;
    const select = document.getElementById('pm-staged-funding-stage');
    if (select) select.value = String(stage);
    const label = document.getElementById('pm-staged-funding-status');
    if (label) label.textContent = started ?
      'A日開始時の保有株数を保存済み（' + new Date(state.stagedFunding.startedAt).toLocaleString('ja-JP') +
      '）。各日に時価再計算。累積購入率50% → 80% → 100%。PLTRは売却後30%を維持。' :
      'A日購入前に初期保有を保存してください。500万・300万・200万円などの固定予算は使いません。';
    const out = calc(state, market, stage);
    if (out.errors.length) {
      host.innerHTML = '<p class="pm-callout" data-warn="true" role="alert">' +
        out.errors.map(safe).join(' ') +
        '</p><p class="pm-muted pm-small">この状態での売買株数は表示しません。</p>';
      return;
    }
    const warnings = out.alerts.length ?
      '<p class="pm-callout" data-warn="true" role="alert">' +
      out.alerts.map(safe).join(' ') + '</p>' : '';
    const tableRows = out.rows.map(r => '<tr><td><strong>' + safe(r.ticker) +
      '</strong></td><td>' + pct(r.targetPct) + '</td><td>' +
      r.initialShares + '株</td><td>' + r.currentShares + '株</td><td>' +
      yen(r.targetValue) + '</td><td>' + yen(r.gap) + '</td><td><strong>' +
      r.qty + '株</strong></td><td>' + usd(r.qty * r.usd) + '</td><td>' +
      yen(r.qty * r.priceJpy) + '</td></tr>').join('');
    host.innerHTML =
      '<div class="pm-stage-grid">' +
      cell('現時点の対象資産', yen(out.total)) +
      cell('USD/JPY（' + (out.fx.kind === 'spot' ? 'スポット' : out.fx.kind === 'manual' ? '証券会社・手入力' : '時間更新') + '）', out.rate.toFixed(4)) +
      cell('第' + stage + '弾・累積到達率', pct(out.stagePct)) +
      cell('今回の購入必要額・概算手数料込', yen(out.idealBudget)) +
      cell('PLTR売却する株数', out.sale.shares + '株') +
      cell('PLTR税引後の売却代金', yen(out.sale.net)) +
      cell('PLTR売却後構成比', pct(out.afterPltrPct)) +
      cell('予算不足（整数株ベース）', yen(out.shortage)) +
      cell('未使用の売却資金', yen(out.leftOver)) +
      '</div>' +
      warnings +
      '<p class="pm-muted pm-small">参考：税引前PLTR売却額 ' + yen(out.sale.gross) +
      '（' + usd(out.sale.grossUsd) + '）／概算譲渡税 ' + yen(out.sale.tax) +
      '／売却手数料 ' + yen(out.sale.fee) +
      '。30%下限で最大売却可能 ' + out.maxShares + '株、税引後 ' +
      yen(out.maxFunding) + '。</p>' +
      '<div class="pm-wrap" tabindex="0"><table class="pos-table"><thead>' +
      '<tr><th>銘柄</th><th>目標比率</th><th>A日前保有</th><th>現在保有</th>' +
      '<th>現在の最終目標額</th><th>今回の残必要額</th><th>購入株数</th>' +
      '<th>買付ドル額</th><th>買付円額</th></tr></thead><tbody>' +
      tableRows + '</tbody></table></div>' +
      '<p class="pm-muted pm-small">3銘柄の買付額 ' + yen(out.buyValue) +
      '＋買付手数料 ' + yen(out.buyFees) + '＝今回の試算買付費用 ' +
      yen(out.buyTotal) + '。A日の予想株数ではなく、証券会社の実際の約定株数と最新現金残高を登録してからB日・C日を計算してください。</p>' +
      '<p class="pm-muted pm-small">売買は実行しません。株価・為替は参考値であり、実際の適用レート、源泉徴収、売買手数料、約定価格との照合が必要です。発注時点で再計算してください。</p>';
  }

  function init() {
    if (typeof document === 'undefined') return;
    const select = document.getElementById('pm-staged-funding-stage');
    if (!select) return;
    const prev = Number(localStorage.getItem('pm-staged-funding-stage'));
    if ([1, 2, 3].includes(prev)) stage = prev;
    select.value = String(stage);
    select.addEventListener('change', e => {
      stage = Number(e.target.value);
      localStorage.setItem('pm-staged-funding-stage', String(stage));
      root.PMApp.render();
    });
    document.getElementById('pm-staged-funding-refresh').addEventListener('click', () =>
      root.PMApp.refreshPrices({ indicators: false }));
    document.getElementById('pm-staged-start').addEventListener('click', () => {
      const state = root.PMApp.state();
      if (!state.confirmed) return root.PMApp.showNotice('証券口座の保有を確認してください。', true);
      if (state.stagedFunding) return;
      if (!confirm('買付前のNVDA・AVGO・CRDO保有株数を開始基準として保存します。よろしいですか？')) return;
      stage = 1;
      localStorage.setItem('pm-staged-funding-stage', '1');
      root.PMApp.commit({ ...state, stagedFunding: snapshot(state) }, true);
    });
    document.getElementById('pm-staged-reset').addEventListener('click', () => {
      const state = root.PMApp.state();
      if (!confirm('開始時の保有株数をリセットしますか？ 途中の段階計算が変わります。')) return;
      stage = 1;
      localStorage.setItem('pm-staged-funding-stage', '1');
      root.PMApp.commit({ ...state, stagedFunding: null }, true);
    });
    render(root.PMApp.state(), root.PMApp.market());
  }

  const api = { calc, snapshot, render, init, TRANCHE, TICKERS, DEFAULT_TARGETS, FLOOR };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMStagedFunding = api;
})(globalThis);
