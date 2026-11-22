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
        const shares = Math.min(lot.shares, fromAccount);
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
      else errors.push(`${ticker}の株価を確認できません。`);
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
      const shares = a?.shares ?? 0;
      const value = a?.value ?? 0;
      const target = total * (t?.pct ?? 0) / 100;
      const delta = target - value;
      return { ticker, t, lots: a?.lots ?? [], shares, value, target, delta, usd, jpy,
        targetShares: jpy ? target / jpy : null, order: 0, status: watch.has(ticker) ? 'watch' : 'none' };
    });

    for (const row of rows) {
      if (row.jpy == null || row.delta >= 0) continue;
      const { sales, limited } = liquidate(row, -row.delta / row.jpy, row.t ? row.t.sellCap : 0);
      row.sales = sales;
      row.order = -totalOf(sales, s => s.shares);
      row.status = limited ? (row.t ? 'sale-limited' : 'no-target') : 'none';
    }

    const sales = rows.flatMap(row => row.sales ?? []);
    const tax = taxEstimate(sales, state.tax.rate, state.tax.offset);
    const withoutOffset = taxEstimate(sales.map(sale => ({ ...sale })), state.tax.rate, 'none');
    const postTotal = total - tax;
    const reserve = postTotal * state.cashTarget / 100;
    let cashAfter = cash + totalOf(sales, s => s.jpy) - tax;

    // Fund the largest yen shortfalls first using proceeds net of the tax reserve.
    for (const row of [...rows].sort((a, b) => b.delta - a.delta || a.ticker.localeCompare(b.ticker))) {
      if (row.delta <= 0 || !row.jpy) continue;
      if (row.t?.group === 'satellite' && row.t.wait) {
        row.status = 'wait';
        continue;
      }
      const wanted = Math.floor(row.delta / row.jpy);
      const funded = Math.max(0, Math.floor((cashAfter - reserve) / row.jpy));
      row.order = Math.min(wanted, funded);
      if (row.order < wanted) row.status = 'cash-limited';
      cashAfter -= row.order * row.jpy;
    }

    for (const row of rows) {
      row.tradeJpy = row.order * (row.jpy ?? 0);
      row.tradeUsd = row.order * (row.usd ?? 0);
      row.tax = totalOf(row.sales ?? [], sale => sale.tax);
      row.afterShares = row.shares + row.order;
      row.afterValue = row.value + row.tradeJpy;
      row.afterPct = postTotal > 0 ? row.afterValue / postTotal * 100 : 0;
    }
    const startJpy = state.cash.jpy + (state.cash.extraIncluded ? 0 : state.cash.extraJpy);
    const usdNet = state.cash.usd - totalOf(rows, row => row.tradeUsd);
    const cashAfterUsd = Math.max(0, usdNet - Math.max(0, tax - startJpy) / fx.rate);
    const cashAfterJpy = Math.max(0, cashAfter - cashAfterUsd * fx.rate);
    return { errors, assets, equity, cash, total, rows, sales, pctSum, tax, withoutOffset, reserve, postTotal, cashAfter,
      cashAfterJpy, cashAfterUsd, cashAfterPct: postTotal > 0 ? cashAfter / postTotal * 100 : 0, fx };
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
