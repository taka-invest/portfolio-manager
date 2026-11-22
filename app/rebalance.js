'use strict';

((root) => {
  const Market = typeof module === 'object' && module.exports ? require('./market.js') : root.PMMarket;
  const EPS = 1e-8;
  const totalOf = (rows, get) => rows.reduce((sum, row) => sum + get(row), 0);
  const stockLots = positions => positions.filter(p => p.kind === 'stock');
  const accountKey = lot => JSON.stringify([lot.broker, lot.account, lot.accountType]);

  function cashValue(cash, fx) {
    if (cash.usd && !(fx > 0)) return null;
    return cash.jpy + cash.usd * (fx ?? 0) + (cash.extraIncluded ? 0 : cash.extraJpy);
  }

  function aggregate(positions, prices, fx) {
    const groups = new Map();
    for (const lot of stockLots(positions)) {
      if (!groups.has(lot.ticker)) groups.set(lot.ticker, []);
      groups.get(lot.ticker).push(lot);
    }
    return [...groups].map(([ticker, lots]) => {
      const shares = totalOf(lots, p => p.shares);
      const costJpy = lots.some(p => p.costJpy == null) ? null : totalOf(lots, p => p.costJpy);
      const usd = prices[ticker]?.usd ?? null;
      const jpy = usd != null && fx != null ? usd * fx : null;
      const value = jpy == null ? null : jpy * shares;
      return { ticker, lots, shares, costJpy, usd, jpy, value, pnl: value == null || costJpy == null ? null : value - costJpy };
    });
  }

  function liquidate(row, required, cap) {
    const accounts = new Map();
    for (const lot of row.lots) {
      const key = accountKey(lot);
      if (!accounts.has(key)) accounts.set(key, []);
      accounts.get(key).push(lot);
    }
    let remaining = Math.min(Math.floor(required + EPS), cap ?? Infinity);
    const sales = [];
    for (const [account, lots] of accounts) {
      const first = lots[0];
      if (!first.broker || !first.account || !['specific', 'general', 'nisa'].includes(first.accountType)) continue;
      const taxable = first.accountType !== 'nisa';
      const available = totalOf(lots, p => p.shares);
      if (taxable && lots.some(p => p.costJpy == null)) continue;
      const perShareBasis = taxable ? totalOf(lots, p => p.costJpy) / available : 0;
      let fromAccount = Math.min(Math.floor(available + EPS), remaining);
      for (const lot of lots) {
        const shares = Math.min(Math.floor(lot.shares + EPS), fromAccount);
        if (shares <= EPS) break;
        sales.push({ lotId: lot.id, ticker: row.ticker, account, broker: lot.broker, name: lot.account,
          accountType: lot.accountType, taxable, shares, usd: shares * row.usd, jpy: shares * row.jpy,
          gain: taxable ? shares * (row.jpy - perShareBasis) : null, tax: 0 });
        fromAccount -= shares;
        remaining -= shares;
      }
      if (remaining <= EPS) break;
    }
    return { sales, limited: remaining > EPS || (cap != null && cap < Math.floor(required + EPS)) };
  }

  function taxEstimate(sales, rate, mode) {
    const groups = new Map();
    for (const sale of sales.filter(s => s.taxable)) {
      const key = mode === 'eligible' ? 'eligible' : mode === 'account' ? sale.account : sale;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sale);
    }
    for (const group of groups.values()) {
      const positive = totalOf(group, s => Math.max(0, s.gain));
      const assessed = Math.ceil(Math.max(0, totalOf(group, s => s.gain)) * rate / 100);
      let allocated = 0;
      const winners = group.filter(s => s.gain > 0);
      winners.forEach((sale, i) => {
        const portion = i === winners.length - 1 ? assessed - allocated : Math.floor(assessed * sale.gain / positive);
        sale.tax = portion;
        allocated += portion;
      });
    }
    return totalOf(sales, s => s.tax);
  }

  // Integer-share purchase allocation: water-fill the larger yen-value gaps, then
  // spend the rounding remainder on the greatest reduction in squared deviations
  // per yen. This is a deterministic approximation, not a guaranteed knapsack optimum.
  function allocateBuys(rows, cashBudget) {
    const candidates = rows.filter(row =>
      row.jpy > 0 && row.t?.pct > 0 &&
      !(row.t.group === 'satellite' && row.t.wait) &&
      row.targetAfterTax > row.afterSaleValue + EPS);
    const gap = row => Math.max(0, row.targetAfterTax - row.afterSaleValue);
    const whole = row => Math.max(0, Math.floor(gap(row) / row.jpy + EPS));
    const totalCost = totalOf(candidates, row => whole(row) * row.jpy);
    if (totalCost <= cashBudget + EPS) {
      for (const row of candidates) row.order = whole(row);
      return totalCost;
    }
    const hi = Math.max(0, ...candidates.map(gap));
    let low = 0, high = hi;
    for (let i = 0; i < 48; i++) {
      const mid = (low + high) / 2;
      const allocation = totalOf(candidates, row => Math.max(0, gap(row) - mid));
      if (allocation > cashBudget) low = mid;
      else high = mid;
    }
    let spent = 0;
    for (const row of candidates) {
      const planned = Math.max(0, gap(row) - high);
      row.order = Math.min(whole(row), Math.floor(planned / row.jpy + EPS));
      spent += row.order * row.jpy;
    }
    let remaining = Math.max(0, cashBudget - spent);
    // Rounding remainders are bounded by the sum of per-share prices.
    for (let i = 0; i < 5000; i++) {
      let chosen = null, best = -Infinity;
      for (const row of candidates) {
        if (row.order >= whole(row) || row.jpy > remaining + EPS) continue;
        const residual = gap(row) - row.order * row.jpy;
        const benefitPerYen = 2 * residual - row.jpy;
        if (benefitPerYen > best + EPS ||
            (Math.abs(benefitPerYen - best) <= EPS && row.ticker < (chosen?.ticker ?? 'ZZZZ'))) {
          chosen = row;
          best = benefitPerYen;
        }
      }
      if (!chosen || best <= 0) break;
      chosen.order++;
      spent += chosen.jpy;
      remaining -= chosen.jpy;
    }
    return spent;
  }

  function simulate(state, market, now = Date.now()) {
    const errors = [];
    const { fx, quotes } = market;
    if (!state.confirmed) errors.push('保有ロットと現金残高の確認が必要です。');
    const pctSum = totalOf(state.targets, t => t.pct) + state.cashTarget;
    if (Math.abs(pctSum - 100) > 1e-6) errors.push('株式と現金の目標配分を合計100%にしてください。');

    const fxState = Market.fxStatus(fx, now);
    const assets = aggregate(state.positions, quotes, fx?.rate);
    const targets = new Map(state.targets.map(t => [t.ticker, t]));
    const tickers = [...new Set([...targets.keys(), ...assets.map(a => a.ticker)])];
    const assetMap = new Map(assets.map(p => [p.ticker, p]));
    const watch = new Set();
    if (fxState !== 'ready') errors.push('USD/JPYの有効な参考レートがありません。');
    for (const ticker of tickers) {
      const hasPosition = assetMap.has(ticker);
      const needed = hasPosition || targets.get(ticker)?.pct > 0;
      if (!needed || Market.quoteStatus(quotes[ticker], now) === 'ready') continue;
      if (!hasPosition && (ticker === 'SPCX' || targets.get(ticker)?.wait)) watch.add(ticker);
      else errors.push(ticker + 'の株価を確認できません。');
    }
    const cash = cashValue(state.cash, fx?.rate);
    const equity = assets.some(p => p.value == null) ? null : totalOf(assets, p => p.value);
    const total = equity == null || cash == null ? null : equity + cash;
    if (!errors.length && !(total > 0)) errors.push('配分対象の個別株または現金を登録してください。');
    if (errors.length) return { errors, assets, equity, cash, total, rows: [], sales: [], pctSum };

    const rows = tickers.map(ticker => {
      const t = targets.get(ticker);
      const a = assetMap.get(ticker);
      const usd = watch.has(ticker) ? null : quotes[ticker]?.usd ?? null;
      const jpy = usd == null ? null : usd * fx.rate;
      const shares = a?.shares ?? 0, value = a?.value ?? 0;
      const target = total * (t?.pct ?? 0) / 100;
      const delta = target - value;
      return { ticker, t, lots: a?.lots ?? [], shares, value, target, delta,
        usd, jpy, targetUsd: target / fx.rate,
        targetShares: jpy ? target / jpy : null,
        idealWholeShares: jpy ? Math.floor(target / jpy + EPS) : null,
        order: 0, status: watch.has(ticker) ? 'watch' : 'none',
        afterSaleValue: value, targetAfterTax: target };
    });

    // Calculate sale constraints and estimated tax together: the tax reduces
    // the investable base and therefore the after-tax target value.
    let sales = [], tax = 0, postTotal = total;
    for (let iteration = 0; iteration < 7; iteration++) {
      for (const row of rows) {
        row.sales = [];
        if (row.jpy == null || row.value <= row.targetAfterTax + EPS) continue;
        const neededShares = (row.value - row.targetAfterTax) / row.jpy;
        const liquidation = liquidate(row, neededShares, row.t ? row.t.sellCap : 0);
        row.sales = liquidation.sales;
      }
      sales = rows.flatMap(row => row.sales);
      tax = taxEstimate(sales, state.tax.rate, state.tax.offset);
      const nextTotal = total - tax;
      if (Math.abs(nextTotal - postTotal) <= 1) { postTotal = nextTotal; break; }
      postTotal = nextTotal;
      for (const row of rows) row.targetAfterTax = postTotal * (row.t?.pct ?? 0) / 100;
    }
    postTotal = total - tax;
    const withoutOffset = taxEstimate(sales.map(sale => ({ ...sale, tax: 0 })), state.tax.rate, 'none');
    const proceeds = totalOf(sales, s => s.jpy);
    const saleUsd = totalOf(sales, s => s.usd);
    const reserve = postTotal * state.cashTarget / 100;
    const cashAfterSales = cash + proceeds - tax;
    const buyBudget = Math.max(0, cashAfterSales - reserve);
    for (const row of rows) {
      row.order = -totalOf(row.sales, sale => sale.shares);
      row.afterSaleValue = row.value + row.order * (row.jpy ?? 0);
      row.targetAfterTax = postTotal * (row.t?.pct ?? 0) / 100;
    }
    // Buy from the taxable proceeds net of provisional tax and cash reserve.
    // Optimizer only purchases underweight securities; existing sell orders are kept intact.
    const purchaseRows = rows.filter(row => row.order >= 0);
    allocateBuys(purchaseRows, buyBudget);

    const purchased = totalOf(rows.filter(row => row.order > 0), row => row.order * row.jpy);
    const cashAfter = cashAfterSales - purchased;
    for (const row of rows) {
      const sold = totalOf(row.sales, sale => sale.shares);
      if (sold) {
        const desiredSales = row.jpy ? Math.floor((row.value - row.targetAfterTax) / row.jpy + EPS) : 0;
        if (sold < desiredSales) row.status = row.t ? 'sale-limited' : 'no-target';
      }
      if (row.jpy == null) row.status = row.status === 'watch' ? 'watch' : row.status;
      else if (row.t?.group === 'satellite' && row.t.wait && row.targetAfterTax > row.afterSaleValue + EPS) row.status = 'wait';
      else if (row.order >= 0 && row.targetAfterTax - (row.afterSaleValue + row.order * row.jpy) > row.jpy + EPS) row.status = 'cash-limited';
      row.tradeJpy = row.order * (row.jpy ?? 0);
      row.tradeUsd = row.order * (row.usd ?? 0);
      row.tax = totalOf(row.sales, sale => sale.tax);
      row.afterShares = row.shares + row.order;
      row.afterValue = row.value + row.tradeJpy;
      row.afterPct = postTotal > 0 ? row.afterValue / postTotal * 100 : 0;
      row.afterTargetShares = row.jpy ? row.targetAfterTax / row.jpy : null;
      row.gapPct = row.afterPct - (row.t?.pct ?? 0);
    }
    // Currency settlement is indicative: US equity buys/sells occur in USD.
    // Estimated JPY tax is paid first from JPY cash, then converted at the indicative rate.
    const startJpy = state.cash.jpy + (state.cash.extraIncluded ? 0 : state.cash.extraJpy);
    let cashAfterUsd = state.cash.usd + saleUsd -
      totalOf(rows.filter(row => row.order > 0), row => row.order * row.usd);
    let cashAfterJpy = startJpy - tax;
    if (cashAfterJpy < 0) { cashAfterUsd += cashAfterJpy / fx.rate; cashAfterJpy = 0; }
    if (cashAfterUsd < 0) { cashAfterJpy += cashAfterUsd * fx.rate; cashAfterUsd = 0; }
    cashAfterUsd = Math.max(0, cashAfterUsd);
    cashAfterJpy = Math.max(0, cashAfterJpy);
    const allocationGap = totalOf(rows, row => Math.abs(row.gapPct)) +
      Math.abs(cashAfter / postTotal * 100 - state.cashTarget);
    return { errors, assets, equity, cash, total, rows, sales, pctSum, tax, withoutOffset,
      reserve, postTotal, cashAfter, cashAfterJpy, cashAfterUsd, cashAfterPct: cashAfter / postTotal * 100,
      saleJpy: proceeds, saleUsd, purchaseJpy: purchased, purchaseUsd: purchased / fx.rate,
      buyBudget, allocationGap, fx };
  }

  const statusText = {
    none: '—', watch: '監視・価格待ち', wait: '購入待機', 'sale-limited': '売却上限・口座条件',
    'no-target': '配分未登録・売却保留', 'cash-limited': '現金目標で制限'
  };

  function csv(result) {
    if (result.errors.length) throw new Error('売買計画を計算できる状態で出力してください。');
    const header = ['銘柄', '現在株数', '目標株数', '売買株数（買＋／売－）', '売買額（円）', '売買額（ドル）',
      '概算税（円）', '売買後株数', '売買後評価額（円）', '売買後比率（%）', '状態', '為替基準日', 'USD/JPY'];
    const rows = result.rows.map(r => [r.ticker, r.shares, r.targetShares?.toFixed(6) ?? '', r.order, r.tradeJpy.toFixed(2),
      r.tradeUsd.toFixed(2), r.tax, r.afterShares, r.afterValue.toFixed(2), r.afterPct.toFixed(4),
      statusText[r.status], result.fx.date, result.fx.rate]);
    rows.push(['現金', '', '', '', '', '', result.tax, '', result.cashAfter.toFixed(2), result.cashAfterPct.toFixed(4),
      '税引き後', result.fx.date, result.fx.rate]);
    return '\uFEFF' + [header, ...rows].map(row => row.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(',')).join('\r\n');
  }

  const api = { cashValue, aggregate, simulate, csv, statusText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMRebalance = api;
})(globalThis);
