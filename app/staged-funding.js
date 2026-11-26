'use strict';

// Rolling cumulative targets: A 50%, B 80%, C 100% of the currently
// revalued TOTAL additional investment need. Never fixed yen tranche budgets.
// This code is a reference calculator, not a broker order interface.
((root) => {
  const Market = typeof module === 'object' && module.exports
    ? require('./market.js') : root.PMMarket;
  const Rebalance = typeof module === 'object' && module.exports
    ? require('./rebalance.js') : root.PMRebalance;
  const Data = typeof module === 'object' && module.exports
    ? require('./data.js') : root.PMData;
  const TICKERS = Object.freeze(['NVDA', 'AVGO', 'CRDO']);
  const DEFAULT_TARGETS = Object.freeze({ NVDA: 15, AVGO: 10, CRDO: 3 });
  const TRANCHE = Object.freeze([0.5, 0.8, 1]);
  const FLOOR = Data.PLTR_FLOOR;
  const EPS = 0.001;
  const sum = (rows, f) => rows.reduce((acc, row) => acc + f(row), 0);
  const feeUsd = amount => amount <= 0 ? 0 : Math.min(22, amount * 0.00495);
  const same = (a, b) => Math.abs(a - b) < 0.005;

  const heldShares = state => Object.fromEntries(TICKERS.map(ticker => [
    ticker, sum((state.positions || []).filter(p => p.kind === 'stock' && p.ticker === ticker), p => p.shares)
  ]));

  function snapshot(state, now = Date.now()) {
    return { startedAt: new Date(now).toISOString(), baselineShares: heldShares(state), stage: 1, stageLog: [] };
  }

  /**
   * Move the synced plan to the next stage. The cumulative targets assume the
   * fills of the current stage are registered as lots; if the holdings of all
   * three tickers are unchanged since the stage began, the caller must get an
   * explicit "not bought" confirmation (recorded as skipped) — otherwise the
   * next stage would repeat this stage's purchase.
   */
  function advance(state, now = Date.now()) {
    const plan = state && state.stagedFunding;
    if (!plan) return { error: '買付計画が開始されていません。' };
    const stage = plan.stage || 1;
    if (stage >= 3) return { error: 'C日（累積100%）が最終段階です。' };
    if (!state.confirmed)
      return { error: '約定株数を保有ロットに登録し、「実保有・現金を確認」を押してから次の段階へ進んでください。' };
    const log = plan.stageLog || [];
    const from = stage === 1 ? plan.baselineShares : log[stage - 2].shares;
    const shares = heldShares(state);
    if (TICKERS.some(t => !Number.isSafeInteger(shares[t])))
      return { error: 'NVDA・AVGO・CRDOの保有数量が整数株ではありません。' };
    const unchanged = TICKERS.every(t => shares[t] === from[t]);
    return { unchanged, from, shares, stagedFunding: { ...plan, stage: stage + 1,
      stageLog: [...log, { stage, at: new Date(now).toISOString(), shares, skipped: unchanged }] } };
  }

  function calc(state, market, stage = (state && state.stagedFunding && state.stagedFunding.stage) || 1, now = Date.now()) {
    const errors = [], alerts = [];
    if (![1, 2, 3].includes(stage)) errors.push('購入段階が不正です。');
    for (const issue of Data.specIssues(state)) errors.push(issue + '①で固定仕様に戻してください。');
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
    // No silent fallback: a missing target is reported by specIssues above.
    const weights = Object.fromEntries(TICKERS.map(ticker =>
      [ticker, targetMap.has(ticker) ? targetMap.get(ticker).pct : NaN]));
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
    const offset = state.tax && state.tax.offset || 'none';
    function sale(q) {
      // One sell order per account, each with its own commission (as in ③), and the
      // same tax rule as ③ (Rebalance.capitalGainsTax): commissions reduce the gain.
      let left = q, commission = 0;
      const orders = [];
      for (const [key, acc] of accounts) {
        const used = Math.min(left, acc.shares);
        if (!used) continue;
        const fee = feeUsd(used * pUsd) * rate;
        commission += fee;
        orders.push({ account: key, ticker: 'PLTR', taxable: true, gain: used * (pltrPrice - acc.basis / acc.shares) - fee, tax: 0 });
        left -= used;
      }
      const grossUsd = q * pUsd, gross = q * pltrPrice;
      const tax = Rebalance.capitalGainsTax(orders, taxRate, offset);
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
  const STAGE_NAMES = ['A日：累積50%', 'B日：累積80%', 'C日：累積100%'];
  function render(state, market) {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('pm-staged-funding-result');
    if (!host) return;
    const started = !!state.stagedFunding;
    const start = document.getElementById('pm-staged-start');
    const reset = document.getElementById('pm-staged-reset');
    if (start) { start.hidden = started; start.disabled = !state.confirmed; }
    if (reset) reset.hidden = !started;
    const stage = started ? state.stagedFunding.stage : 1;
    const stageLabel = document.getElementById('pm-staged-funding-stage');
    if (stageLabel) stageLabel.textContent = started ? STAGE_NAMES[stage - 1] : '未開始';
    const next = document.getElementById('pm-staged-advance');
    if (next) {
      next.hidden = !started || stage >= 3;
      if (stage < 3) next.textContent = 'ABC'[stage - 1] + '日の約定を登録済み → ' + 'ABC'[stage] + '日へ';
    }
    const label = document.getElementById('pm-staged-funding-status');
    if (label) label.textContent = started ?
      'A日開始時の保有株数を保存済み（' + new Date(state.stagedFunding.startedAt).toLocaleString('ja-JP') +
      '）。各日に時価再計算。累積購入率50% → 80% → 100%。PLTRは売却後30%を維持。' +
      (state.stagedFunding.stageLog || []).map(e => ' ' + 'ABC'[e.stage - 1] + '日：' +
        (e.skipped ? '購入なしで次へ' : '約定登録済み') + '（' + new Date(e.at).toLocaleString('ja-JP') + '）').join('') :
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
      cell(STAGE_NAMES[stage - 1].split('：')[0] + '・累積到達率', pct(out.stagePct)) +
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

  // One-time migration: the stage used to live only in this browser's storage.
  // It is NOT copied into the plan (it may be stale or from an earlier plan);
  // the owner advances explicitly after registering fills.
  function migrateLocalStage() {
    let prev = null;
    try {
      prev = Number(localStorage.getItem('pm-staged-funding-stage'));
      localStorage.removeItem('pm-staged-funding-stage');
    } catch (_) { return; }
    const plan = root.PMApp.state().stagedFunding;
    if (!plan || plan.stage !== 1 || (plan.stageLog || []).length || ![2, 3].includes(prev)) return;
    root.PMApp.showNotice('このブラウザーで選んでいた段階（' + STAGE_NAMES[prev - 1] +
      '）は使わず、計画の段階（A日）から表示します。A日の約定を登録済みなら「次へ」で進めてください。', true);
  }

  function init() {
    if (typeof document === 'undefined') return;
    if (!document.getElementById('pm-staged-funding-result')) return;
    migrateLocalStage();
    document.getElementById('pm-staged-advance').addEventListener('click', () => {
      const state = root.PMApp.state();
      const out = advance(state);
      if (out.error) return root.PMApp.showNotice(out.error, true);
      const cur = 'ABC'[state.stagedFunding.stage - 1];
      if (out.unchanged) {
        if (!confirm(cur + '日の開始時からNVDA・AVGO・CRDOの保有株数が変わっていません。\n\n' +
          '購入した場合は「キャンセル」を押し、約定株数を保有ロットに登録してください。登録しないまま進むと、次の段階で同じ分を再び買う計算になります。\n\n' +
          cur + '日に購入しなかった場合だけ「OK」を押してください。')) return;
      } else if (!confirm(cur + '日の約定を登録済みとして次の段階へ進みます（' +
          TICKERS.map(t => t + ' ' + out.from[t] + '→' + out.shares[t] + '株').join('、') + '）。よろしいですか？')) return;
      root.PMApp.commit({ ...state, stagedFunding: out.stagedFunding }, true);
    });
    document.getElementById('pm-staged-funding-refresh').addEventListener('click', () =>
      root.PMApp.refreshPrices({ indicators: false }));
    document.getElementById('pm-staged-start').addEventListener('click', () => {
      const state = root.PMApp.state();
      if (!state.confirmed) return root.PMApp.showNotice('証券口座の保有を確認してください。', true);
      if (state.stagedFunding) return;
      if (!confirm('買付前のNVDA・AVGO・CRDO保有株数を開始基準として保存します。よろしいですか？')) return;
      root.PMApp.commit({ ...state, stagedFunding: snapshot(state) }, true);
    });
    document.getElementById('pm-staged-reset').addEventListener('click', () => {
      const state = root.PMApp.state();
      if (!confirm('開始時の保有株数と段階の記録をリセットしますか？ 途中の段階計算が変わります。')) return;
      root.PMApp.commit({ ...state, stagedFunding: null }, true);
    });
    render(root.PMApp.state(), root.PMApp.market());
  }

  const api = { calc, snapshot, advance, render, init, TRANCHE, TICKERS, DEFAULT_TARGETS, FLOOR };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMStagedFunding = api;
})(globalThis);
