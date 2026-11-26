'use strict';

((root) => {
  const amount = (v, digits = 0) => v == null || !Number.isFinite(v) ? '—' :
    v.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const yen = n => n == null || !Number.isFinite(n) ? '—' : '¥' + amount(Math.round(n));
  const usd = n => n == null || !Number.isFinite(n) ? '—' : '$' + amount(n, 2);
  const pct = n => n == null || !Number.isFinite(n) ? '—' : amount(n, 2) + '%';
  const safe = v => String(v ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const palette = ['#4679E8','#8F70D5','#15A9A1','#E7A84C','#D66E91',
    '#69A965','#6C9EC1','#D18B66','#9266A7','#5D93B6','#9EACBD','#D3A64C'];
  function color(ticker) {
    const special = { NVDA: palette[0], AVGO: palette[1], PLTR: palette[2],
      APP: palette[3], SOFI: palette[4], CRDO: palette[5],
      RKLB: palette[6], SPCX: palette[7], CASH: '#9AA3B1' };
    if (special[ticker]) return special[ticker];
    const h = Array.from(ticker).reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
    return palette[h % palette.length];
  }
  function whole(n) {
    return n == null || !Number.isFinite(n) ? '—' : amount(n);
  }
  function legend(ticker) {
    return '<span class="pm-swatch" style="background:' + color(ticker) + '"></span><strong>' + safe(ticker) + '</strong>';
  }
  // Tax-excluded, reference-only buy/sell deltas. NEVER use this output as
  // an executable brokerage order: sale limits, tax and cash are applied in ③.
  function ideal(out) {
    if (out.errors.length) return '';
    const rows = out.rows.map(row => {
      const targetPct = row.t?.pct ?? 0;
      const tradablePrice = Number.isFinite(row.jpy) && row.jpy > 0;
      const diff = tradablePrice ? row.idealWholeShares - row.shares : null;
      const sell = diff != null && diff < -1e-7;
      const buy = diff != null && diff > 1e-7;
      const waiting = buy && row.t?.group === 'satellite' && row.t.wait;
      const cap0 = sell && row.t?.sellCap === 0;
      const capped = sell && row.t?.sellCap != null && row.t.sellCap >= 0 &&
        -diff > row.t.sellCap;
      const noTarget = !row.t && row.shares > 0;
      const type = diff == null ? 'missing' : waiting ? 'wait' : buy ? 'buy' : sell ? 'sell' : 'hold';
      const badge = { buy: '買（理論）', sell: '売（理論）', wait: '購入待機',
        missing: '価格待ち', hold: '変更なし' }[type];
      const note = cap0 ? '売却上限0株：③では売却されません' :
        capped ? '売却上限あり：③では全株を売れません' :
        waiting ? '購入待機中：③では買いません' :
        noTarget ? '配分未登録：③での売却には目標0%登録が必要' :
        row.status === 'watch' ? '価格未確認・待機' :
        targetPct === 0 ? '目標0%' : '';
      const jpy = diff == null ? null : Math.abs(diff) * row.jpy;
      const dollars = diff == null ? null : Math.abs(diff) * row.usd;
      return '<tr class="pm-delta-row">' +
        '<td>' + legend(row.ticker) + (noTarget ? '<div class="pm-muted pm-small">配分未設定</div>' : '') + '</td>' +
        '<td>' + pct(targetPct) + '</td>' +
        '<td>' + whole(row.shares) + '</td>' +
        '<td>' + whole(row.idealWholeShares) +
        '<div class="pm-muted pm-small pm-target-values">目標 ' +
        usd(row.targetUsd) + ' / ' + yen(row.target) + '</div></td>' +
        '<td><span class="pm-delta-badge pm-delta-' + type + '">' + badge + '</span>' +
        '<strong class="pm-delta-count">' + (diff == null ? '—' : whole(Math.abs(diff)) + '株') + '</strong>' +
        (note ? '<div class="pm-delta-note">' + safe(note) + '</div>' : '') + '</td>' +
        '<td>' + usd(row.usd) + '</td>' +
        '<td>' + usd(dollars) + '</td>' +
        '<td>' + yen(jpy) + '</td></tr>';
    }).join('');
    return '<table class="pos-table pm-delta-table"><thead><tr>' +
      '<th>銘柄</th><th>目標%</th><th>現在株数</th><th>理想株数（整数）</th>' +
      '<th>売買差分（税引前）</th><th>参考株価 USD</th><th>差分 USD</th><th>差分 JPY</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function idealTotals(out, state) {
    if (out.errors.length) return '';
    let grossSell = 0, grossBuy = 0, waitingBuy = 0, unknown = 0;
    for (const row of out.rows) {
      if (!(row.jpy > 0)) { if ((row.t?.pct ?? 0) > 0) unknown++; continue; }
      const diff = row.idealWholeShares - row.shares;
      if (diff < 0) grossSell += -diff * row.jpy;
      if (diff > 0) {
        grossBuy += diff * row.jpy;
        if (row.t?.group === 'satellite' && row.t.wait) waitingBuy += diff * row.jpy;
      }
    }
    const incomplete = unknown > 0;
    const preTaxCash = out.cash + grossSell - grossBuy;
    const targetCash = out.total * state.cashTarget / 100;
    const kpis = [
      ['理論売却総額', yen(grossSell), '売却制限・譲渡税は未反映'],
      ['理論購入総額', incomplete ? '—' : yen(grossBuy), waitingBuy > 0 ? 'うち購入待機 ' + yen(waitingBuy) : '購入待機の設定を別途確認'],
      ['全差分実行後の現金', incomplete ? '—' : yen(preTaxCash), '税引前・株価固定の参考額'],
      ['目標現金', yen(targetCash), pct(state.cashTarget)]
    ];
    let notice = incomplete ? '未保有の目標銘柄で株価未確認があります。合計購入額・売買後現金は未確定です。' :
      preTaxCash < targetCash - 1 ? '理論売買だけでも目標現金を下回ります。税金を加味すると不足はさらに大きくなります。' :
      '理論差分は税金・売却上限・購入待機を無視した比較です。③の実行可能株数とは異なります。';
    if (waitingBuy > 0) notice += ' 購入待機の銘柄は③では買付対象にしません。';
    return '<div class="pm-delta-kpis">' + kpis.map(([title, value, sub]) =>
      '<div class="pm-delta-kpi"><small>' + title + '</small><strong>' + value +
      '</strong><span>' + sub + '</span></div>').join('') +
      '</div><p class="pm-delta-notice" role="note">' + safe(notice) + '</p>';
  }

  function tradeRows(rows, side) {
    if (!rows.length) return '<p class="pm-empty-trades">' +
      (side === 'sell' ? '売却予定の銘柄はありません。' : '購入予定の銘柄はありません。') + '</p>';
    return '<table class="pos-table pm-work-table"><thead><tr>' +
      '<th>銘柄</th><th>株価 USD</th><th>売買株数</th><th>売買額 USD</th>' +
      '<th>売買額 JPY</th><th>' + (side === 'sell' ? '概算税 JPY' : '購入後株数') +
      '</th></tr></thead><tbody>' + rows.map(row => {
        const tradeShares = Math.abs(row.order);
        return '<tr><td>' + legend(row.ticker) + '</td><td>' + usd(row.usd) +
          '</td><td class="pm-number-emphasis">' + whole(tradeShares) +
          '</td><td>' + usd(Math.abs(row.tradeUsd)) + '</td><td>' +
          yen(Math.abs(row.tradeJpy)) + '</td><td>' +
          (side === 'sell' ? yen(row.tax) : whole(row.afterShares)) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function trades(out) {
    if (out.errors.length) return '';
    const selling = out.rows.filter(row => row.order < 0);
    const buying = out.rows.filter(row => row.order > 0);
    const waiting = out.rows.filter(row => row.order === 0 && row.status !== 'none');
    const cards = '<div class="pm-trade-kpis">' + [
      ['売却予定額', yen(out.saleJpy), usd(out.saleUsd)],
      ['売却概算税', yen(out.tax), '所得税・住民税の概算'],
      ['売買手数料（概算）', yen(out.fees), '0.495%・1注文上限22ドル'],
      ['買付可能枠', yen(out.buyBudget), usd(out.buyBudget / out.fx.rate) + '相当'],
      ['購入予定額', yen(out.purchaseJpy), usd(out.purchaseUsd)]
    ].map(([label, value, sub]) =>
      '<div class="pm-trade-kpi"><small>' + label + '</small><strong>' + value +
      '</strong><span>' + sub + '</span></div>').join('') + '</div>';

    return cards + '<div class="pm-trade-columns">' +
      '<div class="pm-trade-board pm-trade-sell"><h3><span class="pm-side-pill">SELL</span> 売却する銘柄</h3>' +
      '<div class="pm-wrap">' + tradeRows(selling, 'sell') + '</div></div>' +
      '<div class="pm-trade-board pm-trade-buy"><h3><span class="pm-side-pill">BUY</span> 購入する銘柄</h3>' +
      '<div class="pm-wrap">' + tradeRows(buying, 'buy') + '</div></div></div>' +
      (waiting.length ? '<div class="pm-wait-list"><strong>保留・制限</strong><p>' +
        waiting.map(row => safe(row.ticker) + '：' + safe(row.status === 'watch' ? '株価未確認' :
          row.status === 'wait' ? '購入待機' : row.status === 'sale-limited' ?
            '売却上限制約' : row.status === 'no-target' ? '配分未登録・売却保留' :
            '資金または整数株制約')).join(' ／ ') + '</p></div>' : '');
  }

  function arc(start, fraction, stroke) {
    if (fraction <= 0.000001) return '';
    if (fraction >= 0.999999) return '<circle cx="80" cy="80" r="55" fill="none" stroke="' +
      stroke + '" stroke-width="24"/>';
    const point = unit => {
      const angle = (unit * 2 - 0.5) * Math.PI;
      return [80 + 55 * Math.cos(angle), 80 + 55 * Math.sin(angle)].map(v => v.toFixed(3)).join(' ');
    };
    return '<path d="M ' + point(start) + ' A 55 55 0 ' + (fraction > .5 ? '1' : '0') +
      ' 1 ' + point(start + fraction) + '" fill="none" stroke="' + stroke +
      '" stroke-width="24"/>';
  }
  function donut(values, total, title, subtitle) {
    let angle = 0;
    const positive = values.filter(x => Number.isFinite(x.value) && x.value > 0);
    const slices = positive.map(x => {
      const part = Math.min(1 - angle, Math.max(0, x.value / total));
      const shape = arc(angle, part, color(x.ticker));
      angle += part;
      return shape;
    }).join('');
    return '<div class="pm-donut-panel"><h3>' + title + '</h3><div class="pm-donut-chart">' +
      '<svg viewBox="0 0 160 160" role="img" aria-label="' + title + 'の資産構成">' +
      '<circle cx="80" cy="80" r="55" fill="none" stroke="var(--border)" stroke-width="24"/>' +
      slices + '</svg><div class="pm-donut-core"><small>評価資産額</small><strong>' +
      yen(total) + '</strong></div></div><p class="pm-muted pm-small">' +
      subtitle + '</p></div>';
  }
  function comparison(out, state) {
    if (out.errors.length) return '';
    const before = out.rows.map(row => ({ ticker: row.ticker, value: row.value }));
    const after = out.rows.map(row => ({ ticker: row.ticker, value: row.afterValue }));
    before.push({ ticker: 'CASH', value: out.cash });
    after.push({ ticker: 'CASH', value: out.cashAfter });
    const chart = '<div class="pm-chart-compare">' +
      donut(before, out.total, '売買前', '個別株と現在現金を含む') +
      donut(after, out.postTotal, '売買後', '税引き後、売買を実行したと仮定') + '</div>';
    const legendRows = out.rows.map(row =>
      '<tr><td>' + legend(row.ticker) + '</td><td>' + pct(row.value / out.total * 100) +
      '</td><td>' + pct(row.t?.pct ?? 0) + '</td><td>' + pct(row.afterPct) +
      '</td><td class="' + (Math.abs(row.gapPct) <= 1 ? 'pm-gap-good' : 'pm-gap-warn') + '">' +
      (row.gapPct > 0 ? '+' : '') + pct(row.gapPct) + '</td></tr>').join('');
    const cashGap = out.cashAfterPct - state.cashTarget;
    return chart + '<div class="pm-wrap"><table class="pos-table pm-work-table">' +
      '<thead><tr><th>銘柄</th><th>売買前</th><th>目標</th><th>売買後</th><th>目標との差</th></tr></thead><tbody>' +
      legendRows + '<tr><td>' + legend('CASH') + '</td><td>' +
      pct(out.cash / out.total * 100) + '</td><td>' + pct(state.cashTarget) +
      '</td><td>' + pct(out.cashAfterPct) + '</td><td class="' +
      (Math.abs(cashGap) <= 1 ? 'pm-gap-good' : 'pm-gap-warn') + '">' +
      (cashGap > 0 ? '+' : '') + pct(cashGap) + '</td></tr></tbody></table></div>' +
      '<p class="pm-reference-note">構成比の乖離合計（各項目の絶対差）：' + pct(out.allocationGap) +
      'pt。税額・為替手数料・注文時の価格変動で実際の数値は異なります。</p>';
  }

  function audit(report) {
    const label = safe(report.label);
    const introductory = '<div class="pm-audit-header"><div class="pm-audit-heading">' +
      '<span class="pm-audit-pill pm-audit-' + safe(report.status) + '">' + label + '</span>' +
      '<strong>リバランス目標達成判定</strong></div>' +
      (report.status === 'pending' ? '' :
        '<span class="pm-muted pm-small">判定許容差：各銘柄 ±' +
        pct(report.tolerancePct) + ' ／ 現金は最低目標以上</span>') + '</div>' +
      '<p class="pm-audit-message">' + safe(report.message) + '</p>';
    if (report.status === 'pending')
      return '<section class="pm-audit-box" data-audit-status="pending" role="status">' +
        introductory + '<p class="pm-muted pm-small">対象資産・株価・為替・ロット情報を確認してから③を再計算してください。</p></section>';
    const stats = '<div class="pm-audit-stats"><span>最大乖離 <strong>' +
      pct(report.maxGapPct) + '</strong></span><span>絶対乖離合計 <strong>' +
      pct(report.sumGapPct) + 'pt</strong></span><span>未達成項目 <strong>' +
      report.count + '件</strong></span></div>';
    const rows = report.issues.map(item => {
      const gap = item.gapPct;
      return '<tr><td>' + legend(item.ticker) + '</td><td>' +
        pct(item.actualPct) + '</td><td>' + pct(item.targetPct) +
        '</td><td>' + (gap > 0 ? '+' : '') + pct(gap) +
        '</td><td><strong class="' +
        (item.severity === 'blocked' ? 'pm-audit-blocker' : 'pm-audit-partial') +
        '">' + safe(item.reason) + '</strong>' +
        '<div class="pm-muted pm-small pm-audit-action">' + safe(item.action) +
        '</div></td></tr>';
    }).join('');
    const detail = report.issues.length
      ? '<div class="pm-wrap"><table class="pos-table pm-audit-table"><thead><tr>' +
        '<th>銘柄</th><th>売買後</th><th>目標</th><th>差</th><th>未達成理由・対応</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<a class="pm-audit-jump" href="#allocation">① 目標配分・売却上限を確認する</a>'
      : '<p class="pm-muted pm-small">目標外の残存保有はなく、株数・現金条件も許容範囲内です。</p>';
    return '<section class="pm-audit-box" data-audit-status="' + safe(report.status) +
      '" role="status">' + introductory + stats + detail +
      '<p class="pm-muted pm-small pm-audit-footnote">判定は現在の参考株価と概算税での試算です。注文保証ではありません。' +
      '必要株数の売買可能性、実際の手数料・為替差・税額・約定価格は証券会社で確認してください。</p></section>';
  }

  function auditSummary(report) {
    const detail = report.status === 'pending'
      ? '保有ロット・現金などの確認前です。②の理論差分は上で確認できます。'
      : report.status === 'achieved'
        ? '株数と現金の目標を、概算税引後で許容範囲内に再現する試算です。'
        : '未達成理由 ' + report.count + '件。下の「未達成の理由」を開くと原因と対応策を確認できます。';
    return '<div class="pm-audit-brief pm-audit-brief-' + safe(report.status) +
      '" role="status"><div><small>税引後の達成見込み</small><strong>' +
      safe(report.label) + '</strong></div><p>' + safe(detail) + '</p></div>';
  }

  const api = { ideal, idealTotals, trades, comparison, audit, auditSummary, color };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMRebalanceView = api;
})(globalThis);
