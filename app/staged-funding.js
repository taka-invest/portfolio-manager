'use strict';

// PLTR-funded staged entry. Reference calculation only; never places orders.
// Each stage has a fixed tax-NET funding target. Current holdings, not old
// estimates, are authoritative for every subsequent stage.
((root) => {
  const Market = typeof module === 'object' && module.exports
    ? require('./market.js') : root.PMMarket;
  const Rebalance = typeof module === 'object' && module.exports
    ? require('./rebalance.js') : root.PMRebalance;
  const BUDGETS = Object.freeze([5000000, 3000000, 2000000]);
  const TARGETS = Object.freeze({ NVDA: 15, AVGO: 10, CRDO: 3 });
  const FLOOR = 30;
  const EPS = 0.001;
  const fee = usd => Math.min(22, Math.max(0, usd) * 0.00495);
  const sum = (xs, f) => xs.reduce((acc, v) => acc + f(v), 0);

  function calc(state, market, stage = 1, now = Date.now()) {
    const errors = [], alerts = [];
    if (![1, 2, 3].includes(stage)) errors.push('購入段階が不正です。');
    if (!state?.confirmed) errors.push('保有株数・取得原価・現金を証券口座と照合して確定してください。');
    if (Market.fxStatus(market?.fx, now) !== 'ready' ||
        !['spot', 'hourly'].includes(market?.fx?.kind))
      errors.push('当日のUSD/JPYスポット参考レートがありません。日次ECBレートでは売買計算を行いません。');
    const rate = market?.fx?.rate;
    const lots = (state?.positions ?? []).filter(p => p.kind === 'stock');
    const tickers = new Set([...lots.map(p => p.ticker), ...Object.keys(TARGETS), 'PLTR']);
    for (const ticker of tickers) {
      if (Market.quoteStatus(market?.quotes?.[ticker], now) !== 'ready')
        errors.push(ticker + 'の有効な株価がありません。更新してください。');
    }
    const cash = rate > 0 ? Rebalance.cashValue(state.cash, rate) : null;
    if (cash == null || cash < 0) errors.push('現在の現金残高が不正です。');
    const grouped = new Map();
    for (const p of lots) {
      if (!Number.isSafeInteger(p.shares) || p.shares < 0) {
        errors.push(p.ticker + 'の株数を確認してください。米国株は整数株で試算します。');
      }
      grouped.set(p.ticker, (grouped.get(p.ticker) ?? 0) + p.shares);
    }
    const price = ticker => (market.quotes[ticker]?.usd ?? 0) * rate;
    const equity = sum(lots, p => p.shares * price(p.ticker));
    const total = equity + cash;
    const pltrShares = grouped.get('PLTR') ?? 0;
    const pltr = lots.filter(p => p.ticker === 'PLTR');
    if (!pltrShares) errors.push('売却原資となるPLTRの保有がありません。');
    if (pltr.some(p => p.costJpy == null || !Number.isFinite(p.costJpy) ||
        !p.broker || p.accountType !== 'specific'))
      errors.push('PLTRの特定口座・取得原価が不明なため税額を算定できません。');
    if (!(total > 0)) errors.push('対象資産総額が不正です。');
    if (errors.length) return { errors, alerts, stage, budgets: BUDGETS, rate, total: Number.isFinite(total) ? total : null };

    // Separate weighted-average acquisition costs per taxable account.
    // This is an estimate, not the broker's realized year-to-date withholding.
    const accounts = new Map();
    for (const p of pltr) {
      const key = JSON.stringify([p.broker, p.account, p.accountType]);
      if (!accounts.has(key)) accounts.set(key, { shares: 0, basis: 0 });
      const a = accounts.get(key);
      a.shares += p.shares;
      a.basis += p.costJpy;
    }
    const accountRows = [...accounts.values()];
    const pUsd = market.quotes.PLTR.usd, pJpy = price('PLTR');
    const taxRate = state.tax?.rate ?? 20.315;
    function sale(q) {
      let left = q, gain = 0, groupTax = 0;
      for (const account of accountRows) {
        if (!left) break;
        const take = Math.min(left, account.shares);
        const accountGain = take * (pJpy - account.basis / account.shares);
        gain += accountGain;
        groupTax += Math.max(0, accountGain);
        left -= take;
      }
      const gross = q * pJpy, commission = fee(q * pUsd) * rate;
      // Conservatively do not assume unverified realized losses offset gains.
      const taxableGain = Math.max(0, state.tax?.offset === 'eligible' ? gain : groupTax);
      const tax = Math.ceil(Math.max(0, taxableGain - commission) * taxRate / 100);
      return { shares: q, gross, grossUsd: q * pUsd, fee: commission, gain,
        tax, net: gross - commission - tax, postTotal: total - commission - tax,
        postPltrValue: (pltrShares - q) * pJpy };
    }
    const withinFloor = q => {
      const s = sale(q);
      return s.postPltrValue + EPS >= s.postTotal * FLOOR / 100;
    };
    // Strict cap: after-tax portfolio denominator, never a pre-tax ratio.
    let low = 0, high = pltrShares;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (withinFloor(mid)) low = mid;
      else high = mid - 1;
    }
    const maxShares = low;
    const maxFunding = Math.max(0, sale(maxShares).net);
    const budget = BUDGETS[stage - 1];
    const nominalGaps = Object.entries(TARGETS).map(([ticker, targetPct]) => ({
      ticker, targetPct, currentShares: grouped.get(ticker) ?? 0,
      currentValue: (grouped.get(ticker) ?? 0) * price(ticker),
      usd: market.quotes[ticker].usd, priceJpy: price(ticker)
    }));
    const targetDemand = sum(nominalGaps, r => Math.max(0, r.targetPct * total / 100 - r.currentValue));
    // Do not liquidate PLTR for purchases that would breach the target caps.
    const desiredNet = Math.min(budget, targetDemand);
    let qLo = 0, qHi = maxShares;
    while (qLo < qHi) {
      const mid = Math.floor((qLo + qHi) / 2);
      if (sale(mid).net + EPS >= desiredNet) qHi = mid;
      else qLo = mid + 1;
    }
    let selected = desiredNet > 0 ? qLo : 0;
    if (sale(selected).net + EPS < desiredNet) selected = maxShares;
    let funding = sale(selected);

    function allocate(s) {
      const rows = nominalGaps.map(r => {
        const targetValue = s.postTotal * r.targetPct / 100;
        const gap = Math.max(0, targetValue - r.currentValue);
        return { ...r, targetValue, gap, maxQty: Math.floor(gap / r.priceJpy + 1e-9), qty: 0 };
      });
      const investable = Math.max(0, Math.min(budget, s.net));
      const totalGap = sum(rows, r => r.gap);
      if (totalGap > 0 && investable > 0) {
        const portion = Math.min(investable, totalGap);
        for (const r of rows) r.qty = Math.min(r.maxQty,
          Math.floor(portion * r.gap / totalGap / r.priceJpy + 1e-9));
        const purchaseCost = () => sum(rows, r => r.qty * r.priceJpy +
          fee(r.qty * r.usd) * rate);
        // Fee buffer before residual distribution; cap with integer lots.
        while (purchaseCost() > investable + EPS) {
          const r = rows.filter(r => r.qty > 0).sort((a, b) =>
            (a.gap - a.qty * a.priceJpy) - (b.gap - b.qty * b.priceJpy))[0];
          if (!r) break;
          r.qty--;
        }
        for (let i = 0; i < 10000; i++) {
          const options = rows.filter(r => r.qty < r.maxQty &&
            purchaseCost() + r.priceJpy +
              (fee((r.qty + 1) * r.usd) - fee(r.qty * r.usd)) * rate <= investable + EPS);
          if (!options.length) break;
          options.sort((a, b) =>
            (b.gap / totalGap - b.qty * b.priceJpy / Math.max(1, portion)) -
            (a.gap / totalGap - a.qty * a.priceJpy / Math.max(1, portion)));
          options[0].qty++;
        }
      }
      const buyValue = sum(rows, r => r.qty * r.priceJpy);
      const buyFees = sum(rows, r => fee(r.qty * r.usd) * rate);
      return { rows, buyValue, buyFees, used: buyValue + buyFees };
    }
    let allocation = allocate(funding);
    const floorPctAfter = funding.postTotal > 0
      ? funding.postPltrValue / funding.postTotal * 100 : 0;
    const remaining = Math.max(0, budget - funding.net);
    if (maxFunding + EPS < budget)
      alerts.push('PLTR30%下限を守ると、今回の税引後予算を全額調達できません。不足額を確認してください。');
    if (selected === 0 && desiredNet > 0)
      alerts.push('PLTRを30%以上維持する売却余地がありません。');
    if (targetDemand + EPS < budget)
      alerts.push('目標比率までの買付不足額が今回の予算を下回ります。不要なPLTR売却は行いません。');
    if (funding.net + EPS < allocation.used)
      errors.push('買付費用が税引後売却代金を超過しました。発注しないでください。');
    if (floorPctAfter + 1e-8 < FLOOR)
      errors.push('PLTR比率30%下限に違反しています。発注しないでください。');
    return {
      errors, alerts, stage, budget, rate, fx: market.fx, total,
      beforePltrPct: pltrShares * pJpy / total * 100,
      afterPltrPct: floorPctAfter,
      maxShares, maxFunding, maxGap: Math.max(0, budget - maxFunding),
      sale: funding, rows: allocation.rows,
      buyValue: allocation.buyValue, buyFees: allocation.buyFees,
      buyTotal: allocation.used,
      leftOver: Math.max(0, funding.net - allocation.used),
      shortage: remaining,
      targets: TARGETS, minFloor: FLOOR,
      completeFunding: funding.net + EPS >= budget
    };
  }

  const yen = n => Number.isFinite(n) ? '¥' + Math.round(n).toLocaleString('ja-JP') : '—';
  const percent = n => Number.isFinite(n) ? n.toFixed(2) + '%' : '—';
  const usd = n => Number.isFinite(n) ? '$' + n.toFixed(2) : '—';
  let stage = 1;
  function render(state, market) {
    const host = typeof document === 'undefined' ? null : document.getElementById('pm-staged-funding-result');
    if (!host) return;
    let out = calc(state, market, stage);
    const select = document.getElementById('pm-staged-funding-stage');
    if (select) select.value = String(stage);
    const status = document.getElementById('pm-staged-funding-status');
    if (status) status.textContent = '固定予算：第1弾 500万円 ／ 第2弾 300万円 ／ 第3弾 200万円。PLTRの売却後比率30%は絶対下限。通常リバランスの現金10%は本モードには適用しません。';
    if (out.errors.length) {
      host.innerHTML = '<p class="pm-callout" data-warn="true" role="alert">' +
        out.errors.map(safe).join(' ') + '</p><p class="pm-muted pm-small">保有を確認し、「株価・為替を更新」してください。未確認または古い値での株数提示は停止します。</p>';
      return;
    }
    const planned = out.rows.map(r => '<tr><td><strong>' + safe(r.ticker) + '</strong></td><td>' +
      r.targetPct + '%</td><td>' + r.currentShares + '株</td><td>' + yen(r.gap) +
      '</td><td>' + r.qty + '株</td><td>' + usd(r.qty * r.usd) +
      '</td><td>' + yen(r.qty * r.priceJpy) + '</td></tr>').join('');
    const warning = out.alerts.length ? '<p class="pm-callout" data-warn="true" role="alert">' +
      out.alerts.map(safe).join(' ') + '</p>' : '';
    host.innerHTML =
      '<div class="pm-stage-grid">' +
        cell('対象資産・現時点', yen(out.total)) +
        cell('USD/JPY・' + (out.fx.kind === 'spot' ? 'スポット' : '時間更新'), out.rate.toFixed(4)) +
        cell('第' + out.stage + '弾の予算', yen(out.budget)) +
        cell('PLTR売却案（整数株）', out.sale.shares + '株') +
        cell('PLTR税・手数料控除後', yen(out.sale.net)) +
        cell('PLTR売却後の比率', percent(out.afterPltrPct)) +
      '</div>' +
      warning +
      '<p class="pm-muted pm-small">PLTR売却：' + usd(out.sale.grossUsd) +
      ' / ' + yen(out.sale.gross) + '（税 ' + yen(out.sale.tax) + '、売却手数料見込 ' +
      yen(out.sale.fee) + '）。30%下限で最大 ' + out.maxShares + '株、税引後 ' +
      yen(out.maxFunding) + 'まで。第' + out.stage + '弾の調達不足 ' + yen(out.shortage) +
      '。残る調達余力は次回の株価・為替で再計算します。</p>' +
      '<div class="pm-wrap" tabindex="0"><table class="pos-table"><thead><tr><th>銘柄</th>' +
      '<th>目標</th><th>現保有</th><th>不足額</th><th>今回購入</th><th>USD</th><th>JPY</th></tr></thead>' +
      '<tbody>' + planned + '</tbody></table></div>' +
      '<p class="pm-muted pm-small">買付額 ' + yen(out.buyValue) + ' ＋ 買付手数料見込 ' +
      yen(out.buyFees) + ' ＝ ' + yen(out.buyTotal) + '。PLTR売却からの余剰 ' +
      yen(out.leftOver) + ' は現金で残します。株価・為替・取得原価・実際の口座税額を発注前に必ず照合してください。</p>' +
      '<p class="pm-muted pm-small">この表は試算のみで注文や約定記録を自動実行しません。次の段階は実際の約定を保有株数・現金へ反映してから選択してください。手数料は片道0.495%・上限22ドルの参考モデル。為替差額や約定時のスリッページは含みません。</p>';
  }
  function safe(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function cell(title, value) {
    return '<div><small>' + safe(title) + '</small><strong>' + safe(value) + '</strong></div>';
  }
  function init() {
    if (typeof document === 'undefined') return;
    const select = document.getElementById('pm-staged-funding-stage');
    if (!select) return;
    const cached = Number(localStorage.getItem('pm-staged-funding-stage'));
    if ([1, 2, 3].includes(cached)) stage = cached;
    select.value = String(stage);
    select.addEventListener('change', e => {
      stage = Number(e.target.value);
      localStorage.setItem('pm-staged-funding-stage', String(stage));
      root.PMApp.render();
    });
    document.getElementById('pm-staged-funding-refresh').addEventListener('click', () =>
      root.PMApp.refreshPrices({ indicators: false }));
    render(root.PMApp.state(), root.PMApp.market());
  }
  const api = { calc, render, init, BUDGETS, TARGETS, FLOOR };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMStagedFunding = api;
})(globalThis);
