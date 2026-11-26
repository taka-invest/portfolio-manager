'use strict';

((root) => {
  const D = root.PMData;
  const S = root.PMStorage;
  const M = root.PMMarket;
  const R = root.PMRebalance;
  const V = root.PMRebalanceView;
  const A = root.PMRebalanceAudit;
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const number = (value, digits = 2) => value == null ? '—' : value.toLocaleString('ja-JP', { maximumFractionDigits: digits });
  const yen = value => value == null ? '—' : '¥' + number(value, 0);
  const usd = value => value == null ? '—' : '$' + number(value);
  const pct = value => value == null ? '—' : number(value) + '%';
  const stamp = t => t ? new Date(t).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
  const options = (values, selected) => Object.entries(values).map(([key, label]) =>
    `<option value="${escape(key)}"${selected === key ? ' selected' : ''}>${escape(label)}</option>`).join('');
  const market = { quotes: {}, fx: null };
  const names = { ready: '利用可', stale: '古いデータ', missing: 'データなし', failed: '通信失敗',
    limited: 'API制限', denied: '認証・利用権限', unverified: '発行体未確認', 'no-key': 'APIキー未設定' };
  const kinds = { actual: '実績', forecast: '外部予測', personal: '独自予測' };
  let state = D.blank();
  let storageError = '';
  let recovering = false;
  let pending = null;
  let updating = false;
  let queued = false;
  let lastAttempt = null;
  let limitedUntil = 0;
  let spaceX = false;
  let afterChange = () => {};
  const dirty = new Set();
  const formLabels = { 'cash-form': '現金残高', 'targets-form': '目標配分', 'tax-form': '税設定' };

  function marketTickerList() {
    return [...new Set([...state.positions.filter(p => p.kind === 'stock').map(p => p.ticker),
      ...state.targets.map(t => t.ticker), ...state.plans.map(p => p.ticker), ...state.watchlist.map(w => w.ticker)])];
  }

  function result() {
    const computed = R.simulate(state, market);
    // The owner's fixed specification (weights, cash 10%) gates every order view.
    const spec = D.specIssues(state);
    if (spec.length) computed.errors.unshift(...spec.map(s => s + '①の「固定仕様に戻す」を押してください。'));
    if (storageError || updating || dirty.size || spec.length) {
      if (storageError) computed.errors.unshift(storageError);
      if (updating) computed.errors.unshift('株価と為替を更新中です。');
      if (dirty.size) computed.errors.unshift([...dirty].map(key => formLabels[key]).join('・') + 'の変更を保存してください。');
      computed.rows = [];
    }
    return computed;
  }

  function commit(next, backup = false, restore = false) {
    if (storageError && !(restore && recovering)) return showNotice(storageError, true);
    try { state = S.save(next, backup, recovering && restore); }
    catch (e) { return showNotice(e.message, true); }
    storageError = '';
    recovering = false;
    afterChange();
    render();
    root.dispatchEvent(new CustomEvent('pm:state-saved'));
    return true;
  }

  function showNoticeHost() {
    // The original notice area is inside the dashboard; when another view is open,
    // mirror the message into a fixed toast so errors are never invisible.
    let toast = document.getElementById('pm-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'pm-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      toast.className = 'pm-toast';
      toast.hidden = true;
      document.body.appendChild(toast);
    }
    return toast;
  }

  function showNotice(message, error = false) {
    const dialog = document.querySelector('dialog[open]');
    const region = (error && dialog?.querySelector('[role=alert]')) || $('data-notice');
    region.textContent = message;
    region.dataset.warn = error;
    region.hidden = false;
    if (region.id === 'data-notice' && !region.offsetParent) {
      const toast = showNoticeHost();
      toast.textContent = message;
      toast.dataset.warn = error;
      toast.hidden = false;
      clearTimeout(showNotice.timer);
      showNotice.timer = setTimeout(() => { toast.hidden = true; }, error ? 12000 : 6000);
    }
    return false;
  }

  function download(name, content, type) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([content], { type }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  function backup() {
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace(/[-: ]/g, '').slice(0, 12);
    download('portfolio-manager-backup-' + stamp + '.json', JSON.stringify(D.validate(state), null, 2), 'application/json;charset=utf-8');
  }

  const sectionNames = { positions: '保有ロット', plans: '購入計画', trades: '取引履歴', watchlist: '監視銘柄',
    targets: '目標配分', company: '企業評価' };

  function diff(current, next, samples, source) {
    const lines = [source, '保存後は実保有と現金の確認が必要です。'];
    if (recovering) lines.push('現在の保存データは読み込めないため差分を表示できません。元のデータを別のキーに保管して復元します。');
    if (samples) lines.push(`旧サンプル ${samples} 件を取り込み対象から除外します。元データは保持されます。`);
    for (const [key, label] of Object.entries(sectionNames)) {
      const identifier = row => row.id ?? row.ticker;
      const labelRow = row => row.ticker + (key === 'positions'
        ? ` / ${[row.broker, row.account].filter(Boolean).join(' ') || '口座未確認'} / ${row.shares} 株・口 / 原価 ${yen(row.costJpy)}` : '');
      const before = new Map(current[key].map(row => [identifier(row), row]));
      const after = new Map(next[key].map(row => [identifier(row), row]));
      const changes = [];
      for (const [id, row] of before) if (!after.has(id)) changes.push('− ' + labelRow(row));
      for (const [id, row] of after) {
        const old = before.get(id);
        if (!old) changes.push('+ ' + labelRow(row));
        else if (JSON.stringify(old) !== JSON.stringify(row)) {
          const fields = Object.keys(row).filter(k => JSON.stringify(old[k]) !== JSON.stringify(row[k]));
          changes.push('~ ' + labelRow(row), ...fields.map(field =>
            '  ' + field + '　' + JSON.stringify(old[field] ?? null) + ' → ' + JSON.stringify(row[field] ?? null)));
        }
      }
      lines.push(`\n${label} ${before.size} → ${after.size} 件`, ...changes);
    }
    for (const [key, label] of Object.entries({ cash: '現金', cashTarget: '現金目標（%）', tax: '税設定', preferences: '表示設定',
      stagedFunding: '段階買付の基準株数', confirmed: '実保有の確認状態' })) {
      if (JSON.stringify(current[key]) !== JSON.stringify(next[key])) {
        lines.push(`\n${label}\n${JSON.stringify(current[key])} → ${JSON.stringify(next[key])}`);
      }
    }
    return lines.join('\n');
  }

  function preview(payload, source) {
    if (storageError && !recovering) return showNotice(storageError, true);
    try {
      const { next, samples } = D.prepare(payload, state);
      pending = { next, before: state, source };
      // A backup from a newer app version may hold fields this page cannot keep.
      const lost = payload && typeof payload === 'object' && Object.hasOwn(payload, 'version') ? D.droppedKeys(payload) : [];
      $('import-error').hidden = true;
      $('data-diff').textContent = (lost.length ? '⚠ このページの版では保持できない項目があり、取り込むと失われます：'
        + lost.slice(0, 5).join('、') + (lost.length > 5 ? ' ほか' + (lost.length - 5) + '件' : '')
        + '\n新しい版で作成されたデータの可能性があります。ページを再読み込みしてから取り込んでください。\n\n' : '')
        + diff(state, next, samples, source);
      $('data-review').showModal();
    } catch (e) { showNotice(e.message, true); }
  }

  function previewLegacy() {
    try {
      const legacy = S.legacyData();
      if (!['positions', 'plans', 'trades', 'watchlist'].some(k => Object.hasOwn(legacy, k))) {
        return showNotice('このブラウザーに旧保存データは見つかりませんでした。');
      }
      preview(legacy, '旧ブラウザー保存');
    } catch (e) { showNotice(e.message, true); }
  }

  function acceptPreview() {
    if (!pending || pending.before !== state) {
      $('data-review').close();
      return showNotice('確認中にデータが変わりました。差分を開き直してください。', true);
    }
    if (!commit(pending.next, true, true)) return;
    const source = pending.source;
    pending = null;
    $('data-review').close();
    fillSettings();
    showNotice('保存しました。保有ロットと現金を確認してください。');
    root.dispatchEvent(new CustomEvent('pm:import-accepted', { detail: { source } }));
    refreshPrices();
  }

  function fillSettings() {
    dirty.clear();
    $('cash-jpy').value = state.cash.jpy;
    $('cash-usd').value = state.cash.usd;
    $('cash-extra').value = state.cash.extraJpy;
    $('cash-included').checked = state.cash.extraIncluded;
    $('tax-rate').value = state.tax.rate;
    $('tax-offset').value = state.tax.offset;
    $('cash-target').value = state.cashTarget;
    drawTargets(state.targets);
    drawCompanyPicker();
  }

  function drawTargets(targets) {
    const fixed = t => Object.hasOwn(D.FIXED_WEIGHTS, t.ticker);
    $('target-rows').innerHTML = targets.map(t => `<tr>
      <td><input aria-label="ティッカー" data-field="ticker" maxlength="20" required value="${escape(t.ticker)}"${fixed(t) ? ' readonly' : ''}></td>
      <td><select aria-label="区分" data-field="group">${options({ core: 'コア', satellite: 'サテライト' }, t.group)}</select></td>
      <td><input aria-label="目標比率（%・固定仕様）" data-field="pct" type="number" readonly value="${t.pct}"></td>
      <td class="pm-target-advanced"><input aria-label="売却上限株数" data-field="cap" type="number" min="0" step="1" placeholder="上限なし" value="${t.sellCap ?? ''}"></td>
      <td class="pm-target-advanced"><input aria-label="サテライト購入待機" data-field="wait" type="checkbox"${t.wait ? ' checked' : ''}></td>
      <td><span data-price></span></td>
      <td>${fixed(t) ? '<span class="pm-muted pm-small">固定</span>' : '<button type="button" class="btn btn-ghost btn-sm" data-remove>削除</button>'}</td></tr>`).join('');
    updateDraftTargets();
    const issues = D.specIssues(state);
    $('target-spec').hidden = !issues.length;
    $('target-spec-text').textContent = issues.join(' ');
  }

  function updateDraftTargets() {
    const totals = { core: 0, satellite: 0 };
    for (const row of $('target-rows').rows) {
      const field = name => row.querySelector(`[data-field="${name}"]`);
      totals[field('group').value] += Number(field('pct').value);
      field('wait').disabled = field('group').value !== 'satellite';
      row.querySelector('[data-price]').textContent = priceLabel(field('ticker').value.trim().toUpperCase());
    }
    const sum = totals.core + totals.satellite + Number($('cash-target').value);
    $('target-sum').textContent = `コア ${pct(totals.core)} ／ サテライト ${pct(totals.satellite)} ／ 合計 ${pct(sum)}`;
    $('target-sum').dataset.warn = Math.abs(sum - 100) > 1e-6;
    const percent = value => Math.max(0, Math.min(100, value));
    const colored = [
      { label: 'コア', pct: totals.core, color: '#4679E8' },
      { label: 'サテライト', pct: totals.satellite, color: '#8F70D5' },
      { label: '現金', pct: Number($('cash-target').value), color: '#9AA3B1' }
    ];
    $('target-preview').innerHTML =
      '<div class="pm-target-line"><strong>目標アセットアロケーション</strong><span>' +
      (Math.abs(sum - 100) <= 1e-6 ? '合計100%' : '合計 ' + pct(sum) + '（要調整）') +
      '</span></div><div class="pm-target-bar" role="img" aria-label="目標 コア ' +
      pct(totals.core) + ' サテライト ' + pct(totals.satellite) +
      ' 現金 ' + pct(Number($('cash-target').value)) + '">' +
      colored.map(group => '<span style="width:' + percent(group.pct) +
      '%;background:' + group.color + '"></span>').join('') + '</div>' +
      '<div class="pm-target-legend">' + colored.map(group =>
        '<span><i style="background:' + group.color + '"></i>' + group.label +
        ' <strong>' + pct(group.pct) + '</strong></span>').join('') + '</div>';
  }

  function collectTargets() {
    return [...$('target-rows').rows].map(row => {
      const field = name => row.querySelector(`[data-field="${name}"]`);
      const ticker = field('ticker').value.trim().toUpperCase();
      // Weights are never taken from the form: the fixed spec, or 0% for extra rows.
      return { ticker, pct: Object.hasOwn(D.FIXED_WEIGHTS, ticker) ? D.FIXED_WEIGHTS[ticker] : 0, group: field('group').value,
        wait: field('group').value === 'satellite' && field('wait').checked, sellCap: field('cap').value === '' ? null : Number(field('cap').value) };
    });
  }

  function priceLabel(ticker) {
    const q = market.quotes[ticker];
    const status = M.quoteStatus(q);
    const text = names[status] ?? names.missing;
    return q?.usd ? `${usd(q.usd)} ・ ${stamp(q.at)} JST ・ ${text}` : text;
  }

  function freshPrice(ticker) {
    const q = market.quotes[ticker];
    return !updating && M.quoteStatus(q) === 'ready' && M.fxStatus(market.fx) === 'ready' ? q.usd * market.fx.rate : null;
  }

  function fxRate() {
    return M.fxStatus(market.fx) === 'ready' ? market.fx.rate : null;
  }

  async function refreshPrices({ indicators = true } = {}) {
    if (updating) { queued = true; return; }
    if (limitedUntil > Date.now()) return render();
    const key = $('s-api-key').value.trim();
    if (key) localStorage.setItem('pm_api_key', key);
    else if (localStorage.getItem('pm_api_key')) localStorage.removeItem('pm_api_key');
    updating = true;
    lastAttempt = Date.now();
    $('price-update').disabled = true;
    render();
    root.renderPlans();
    root.renderWatchlist();
    try {
      const [fx, batch] = await Promise.all([M.fetchFx(), M.fetchQuotes(marketTickerList(), key, undefined, spaceX)]);
      // Keep an explicitly verified, unexpired broker quote if the automatic
      // providers can supply only an untimestamped reference/failed result.
      // A genuinely fresh spot quote can supersede it.
      const verifiedBroker = market.fx?.kind === 'manual' && M.fxStatus(market.fx) === 'ready';
      const automaticFresh = fx.kind === 'spot' && M.fxStatus(fx) === 'ready';
      if (!verifiedBroker || automaticFresh)
        market.fx = fx.error ? { ...market.fx, error: fx.error } : fx;
      for (const [ticker, quote] of Object.entries(batch.quotes)) {
        market.quotes[ticker] = quote.error ? { ...market.quotes[ticker], error: quote.error } : quote;
      }
      spaceX = batch.spaceX;
      if (batch.limited) limitedUntil = Date.now() + batch.retryMs;
      if (key && indicators && !batch.limited) {
        root.fetchBothIndexes();
        root.fetchEarnings();
        root.fetchAllTechnicals();
      }
    } finally {
      updating = false;
      $('price-update').disabled = false;
      render();
      root.renderWatchlist();
      root.renderPlans();
      if (queued) {
        queued = false;
        refreshPrices({ indicators: false });
      }
    }
  }

  function render() {
    const out = result();
    const marketConfirmed = state.confirmed && M.fxStatus(market.fx) === 'ready' &&
      out.assets.every(a => M.quoteStatus(market.quotes[a.ticker]) === 'ready');
    const equity = !state.confirmed && !out.assets.length ? null : out.equity;
    const cards = [
      [state.confirmed ? '対象資産' : '対象資産（概算）', yen(out.total),
        '米国個別株 ＋ 対象現金' + (marketConfirmed ? ' ・実保有確認済み' : ' ・参考表示（売買計算は要確認）')],
      ['対象個別株', yen(equity), `${out.assets.length} 銘柄${marketConfirmed ? '' : ' ・参考表示'}`],
      ['既存現金', `${yen(state.cash.jpy)} / ${usd(state.cash.usd)}`, state.cash.extraIncluded ? '追加資金の別計上なし' : `未計上資金 ${yen(state.cash.extraJpy)}`],
      ['USD/JPY', market.fx?.rate ? number(market.fx.rate, 4) : '—', market.fx?.date ? `${market.fx.source || 'ECB日次参考'} ・ ${market.fx.date}${market.fx.at ? ' / 取得 ' + stamp(market.fx.at) : ''}` : 'USD/JPY 未取得']
    ];
    $('summary-row').innerHTML = cards.map(([label, value, sub]) =>
      `<div class="summary-card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>`).join('');
    const active = state.positions.filter(p => p.kind === 'stock');
    const pendingLots = state.positions.filter(p => !D.readyLot(p));
    const pendingDescription = pendingLots.slice(0, 6).map(p => {
      if (p.kind === 'review') return p.ticker + '（資産区分：要確認）';
      const missing = [];
      if (!p.broker.trim()) missing.push('証券会社');
      if (p.accountType === 'unknown') missing.push('口座区分（特定への設定を確認）');
      return p.ticker + '（' + missing.join('・') + '未設定）';
    }).join('、');
    $('trust-status').textContent = storageError ||
      (pendingLots.length ? '未確認の保有ロット ' + pendingLots.length + '件：' + pendingDescription +
        (pendingLots.length > 6 ? '、ほか' + (pendingLots.length - 6) + '件' : '') +
        '。左メニュー「保有資産」のロット一覧から「編集」してください。対象資産は概算を表示していますが、売買計算は保留中です。' :
      !state.confirmed ? (dirty.has('cash-form') ?
        '現金を保存し、証券口座の残高と照合してから「実保有・現金を確認」を押してください。' :
        '保有ロットと現金を入力し、証券口座と照合したら「実保有・現金を確認」を押してください。対象資産は確認前の概算表示です。') :
        '実保有・現金確認済み' + (marketConfirmed ? '' : '（株価・為替の鮮度は要確認）'));
    $('trust-status').dataset.warn = Boolean(storageError) || !state.confirmed;
    $('confirm-holdings').disabled = Boolean(storageError) || dirty.has('cash-form') || state.confirmed ||
      state.positions.some(p => !D.readyLot(p)) ||
      (active.length === 0 && !(R.cashValue(state.cash, 1) > 0));
    if (market.fx?.kind === 'manual' && M.fxStatus(market.fx) !== 'ready') {
      $('pm-broker-usdjpy-status').textContent =
        '手入力レートが10分を超えました。証券会社の最新USD/JPYを再確認して入力してください。';
    }
    $('market-status').textContent = updating ? '株価・為替を更新中…' :
      `株価 Finnhub ｜ 為替 ${market.fx?.source || '未取得'} ${names[M.fxStatus(market.fx)]} ｜ 更新試行 ${stamp(lastAttempt)} JST` +
      (limitedUntil > Date.now() ? ' ｜ API制限により再試行は ' + stamp(limitedUntil) + ' JST 以降' : '');
    updateDraftTargets();
    renderHoldings(out.assets);
    renderOrders(out, R.ideal(state, market));
    root.PMStagedFunding?.render(state, market);
    // Unsaved edits / storage problems / an update in progress block every order view.
    const blockers = [storageError, updating && '株価と為替を更新中です。',
      dirty.size && [...dirty].map(key => formLabels[key]).join('・') + 'の変更を保存してください。'].filter(Boolean);
    root.PMTodayGuide?.render({ state, market, result: out, blockers,
      staged: state.stagedFunding && root.PMStagedFunding ? root.PMStagedFunding.calc(state, market) : null });
    root.renderPerformance(S.read('pm_spy_return')?.pct ?? null);
  }

  function holdingIndicators(ticker) {
    const tech = root.pmTechnicals(ticker);
    return tech ? '<div>' + root.rsiChip(tech.rsi) + root.maDevChip(tech.maDev) + '</div>' : '';
  }

  function buildTable(headers, rows, empty) {
    const body = rows || `<tr><td colspan="${headers.length}" class="empty-state">${empty}</td></tr>`;
    return `<table class="pos-table"><thead><tr>${headers.map(h => '<th scope="col">' + h + '</th>').join('')}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function renderHoldings(assets) {
    const byTicker = new Map(assets.map(a => [a.ticker, a]));
    $('holdings-aggregate').innerHTML = buildTable(['銘柄', '株数', '口座数', '株価（USD）', '円取得原価', '円評価額', '円評価損益'],
      assets.map(a => `<tr><td>${a.ticker}${holdingIndicators(a.ticker)}</td><td>${number(a.shares, 8)}</td>
      <td>${new Set(a.lots.map(p => [p.broker, p.account, p.accountType].join('\0'))).size}</td><td>${priceLabel(a.ticker)}</td>
      <td>${yen(a.costJpy)}</td><td>${yen(a.value)}</td><td>${yen(a.pnl)}</td></tr>`).join(''), '対象の個別株は未登録です。');
    $('holdings-lots').innerHTML = buildTable(['銘柄・資産区分', '証券会社', '口座区分', '株数', '取得単価', '円取得原価', '現在株価', '円評価額', '円評価損益', 'メモ', '操作'],
      state.positions.map(p => {
        const a = byTicker.get(p.ticker);
        const price = p.kind === 'stock' ? a?.jpy ?? p.referenceJpy : p.referenceJpy;
        const value = price == null ? null : price * p.shares;
        const pnl = value == null || p.costJpy == null ? null : value - p.costJpy;
        return `<tr><td>${p.ticker}<div class="pm-muted pm-small">${D.KINDS[p.kind]}</div></td>
          <td class="pm-description">${escape(p.broker || '未確認')}</td>
          <td>${D.TYPES[p.accountType]}</td><td>${number(p.shares, 8)}</td>
          <td>${p.currency === 'USD' ? usd(p.unitCost) : yen(p.unitCost)}</td><td>${yen(p.costJpy)}</td>
          <td>${yen(price)}${price != null && (p.kind !== 'stock' || a?.jpy == null) ? '（登録参考値）' : ''}</td>
          <td>${yen(value)}</td><td>${yen(pnl)}</td><td class="pm-description">${escape(p.note)}</td>
          <td><div class="pm-actions"><button class="btn btn-ghost btn-sm" data-lot="${p.id}">編集</button>
          <button class="btn btn-danger btn-sm" data-delete="${p.id}">削除</button></div></td></tr>`;
      }).join(''), '個別株や対象外の投信をロット単位で登録できます。');
  }

  function renderOrders(out, preview) {
    // ② Ideal allocation is an independent, reference-only calculation.
    // Confirmed broker/tax-lot fields are NOT required for this section.
    if (preview.errors.length) {
      $('ideal-totals').innerHTML = '<p class="pm-callout" data-warn="true">' +
        escape('理論差分を計算できません：' + preview.errors.join(' ')) + '</p>';
      $('ideal-summary').innerHTML = '<p class="pm-callout" data-warn="true">' +
        escape('理想配分を計算できません：' + preview.errors.join(' ')) + '</p>';
      $('ideal-table').innerHTML = '';
    } else {
      const stockBudget = preview.total * (100 - state.cashTarget) / 100;
      const headline = [
        ['対象資産総額', yen(preview.total), state.confirmed ? '保有株式＋対象現金' : '参考値（保有確認前）'],
        ['目標株式枠', yen(stockBudget), '税引き前の理想額'],
        ['目標現金', yen(preview.total * state.cashTarget / 100), pct(state.cashTarget)],
        ['USD/JPY', number(preview.fx.rate, 4), preview.fx.date + ' 参考レート']
      ];
      const status = !state.confirmed
        ? '参考計算です。保有ロット・現金の確認前でも目標金額と理想株数を表示します。売買指示ではありません。'
        : '税引き前の理想配分です。実際の買付余力と注文株数は③で別途算出します。';
      const unsaved = dirty.has('targets-form')
        ? ' 目標比率の未保存変更は含まれません。「配分を保存」を押してください。' : '';
      const notices = preview.warnings.length
        ? ' ' + preview.warnings.join(' ') : '';
      $('ideal-totals').innerHTML = V.idealTotals(preview, state);
      $('ideal-summary').innerHTML =
        '<p class="pm-callout" role="status">' + escape(status + unsaved + notices) + '</p>' +
        headline.map(([label, value, note]) =>
          '<div class="pm-ideal-card"><small>' + label + '</small><strong>' + value +
          '</strong><span>' + note + '</span></div>').join('');
      $('ideal-table').innerHTML = V.ideal(preview);
    }

    // ③ Trade recommendations remain strictly gated on verified lots/cash,
    // clean saved forms and valid quote/fx data.
    const auditPending = Boolean(storageError) ||
      ['targets-form', 'cash-form', 'tax-form'].some(id => dirty.has(id));
    const audit = A.assess(auditPending ? { ...out, errors: ['保存していない変更があります。'] } : out, state);
    $('rebalance-audit').innerHTML = V.audit(audit);
    $('rebalance-audit-summary').innerHTML = V.auditSummary(audit);
    const errors = auditPending ? ['未保存の変更を保存してから、売買計画を再計算してください。'] : out.errors;
    if (errors.length) {
      $('trade-board').innerHTML = '';
      $('allocation-charts').innerHTML = '';
    } else {
      $('trade-board').innerHTML = V.trades(out);
      $('allocation-charts').innerHTML = V.comparison(out, state);
    }
    $('rebalance-state').textContent = errors.length ? '計算保留　' + errors.join(' ') : '保有と価格を確認済み。売買株数は買いを＋、売りを−で表示します。';
    $('rebalance-state').dataset.warn = Boolean(errors.length);
    $('csv-export').disabled = Boolean(errors.length);
    $('rebalance-table').innerHTML = errors.length ? '' : buildTable(
      ['銘柄', '現在評価額', '目標評価額', '過不足', '現在株数', '目標株数', '売買株数', '売買額（円）', '売買額（ドル）', '概算税', '売買後比率', '状態'],
      out.rows.map(r => `<tr><td>${r.ticker}</td><td>${yen(r.value)}</td><td>${yen(r.target)}</td><td>${yen(r.delta)}</td>
      <td>${number(r.shares, 8)}</td><td>${number(r.targetShares, 4)}</td><td>${r.order > 0 ? '+' : ''}${number(r.order, 8)}</td>
      <td>${yen(r.tradeJpy)}</td><td>${usd(r.tradeUsd)}</td><td>${yen(r.tax)}</td><td>${pct(r.afterPct)}</td>
      <td>${R.statusText[r.status]}</td></tr>`).join(''), '配分対象の銘柄はありません。');
    $('sale-breakdown').hidden = !out.sales.length || Boolean(errors.length);
    $('sale-lots').innerHTML = errors.length ? '' : buildTable(['銘柄', '証券会社・口座', 'ロット', '売却株数', '円売却額', '課税損益', '概算税'],
      out.sales.map(s => `<tr><td>${s.ticker}</td><td>${escape(s.broker + ' / ' + s.name)}（${D.TYPES[s.accountType]}）</td>
      <td>${s.lotId}</td><td>${number(s.shares, 8)}</td><td>${yen(s.jpy)}</td><td>${yen(s.gain)}</td><td>${yen(s.tax)}</td></tr>`).join(''), '');
    $('post-state').textContent = errors.length ? '計算条件がそろうと表示されます。' :
      `税引き後対象資産 ${yen(out.postTotal)} ｜ 税引き後現金 ${yen(out.cashAfter)}（${pct(out.cashAfterPct)}） ｜ 概算税 ${yen(out.tax)} ｜ 通算なしの場合 ${yen(out.withoutOffset)}`;
    $('post-table').innerHTML = errors.length ? '' : buildTable(['銘柄', '売買後株数', '売買後評価額', '売買後比率'],
      out.rows.map(r => `<tr><td>${r.ticker}</td><td>${number(r.afterShares, 8)}</td><td>${yen(r.afterValue)}</td><td>${pct(r.afterPct)}</td></tr>`).join('') +
      `<tr><td>現金</td><td>—</td><td>${yen(out.cashAfter)}（${yen(out.cashAfterJpy)} + ${usd(out.cashAfterUsd)}）</td><td>${pct(out.cashAfterPct)}</td></tr>`, '');
  }

  function syncLotTypeFields(form) {
    const stock = form.elements.namedItem('kind').value === 'stock';
    $('lot-stock-type').hidden = !stock;
    $('lot-other-type').hidden = stock;
    if (stock) form.elements.namedItem('accountType').value = 'specific';
  }

  function openLot(lotId) {
    const lot = state.positions.find(p => p.id === lotId);
    const form = $('lot-form');
    form.reset();
    $('lot-error').hidden = true;
    form.elements.namedItem('kind').innerHTML = options(D.KINDS, lot?.kind ?? 'stock');
    form.elements.namedItem('accountType').innerHTML = options(D.TYPES, lot?.accountType ?? 'specific');
    for (const [k, v] of Object.entries(lot ?? { id: '', currency: 'JPY', layer: 1 })) {
      if (form.elements.namedItem(k)) form.elements.namedItem(k).value = v ?? '';
    }
    syncLotTypeFields(form);
    const kept = lot?.kind === 'stock' && ['nisa', 'general'].includes(lot.accountType);
    $('lot-stock-type').querySelector('input').value = kept ? D.TYPES[lot.accountType] + '（登録済み・保持）' : '特定（固定）';
    $('lot-title').textContent = lot ? '保有ロットを編集' : '保有ロットを登録';
    $('lot-dialog').showModal();
  }

  // US stocks are registered in 特定口座; an existing lot explicitly tagged NISA/一般
  // keeps its account type so editing a note never changes how it is taxed.
  function stockAccountType(lotId) {
    const old = state.positions.find(p => p.id === lotId);
    return old?.kind === 'stock' && ['nisa', 'general'].includes(old.accountType) ? old.accountType : 'specific';
  }

  function saveLot(form) {
    const fields = Object.fromEntries(new FormData(form));
    const ticker = fields.ticker.trim().toUpperCase();
    const shares = Number(fields.shares);
    const unitCost = fields.unitCost === '' ? null : Number(fields.unitCost);
    const costJpy = fields.costJpy !== '' ? Number(fields.costJpy) : fields.currency === 'JPY' && unitCost != null ? unitCost * shares : null;
    const lot = { ...fields, id: fields.id || id(), ticker, shares, unitCost, costJpy, layer: Number(fields.layer),
      broker: fields.broker.trim(), account: fields.account?.trim() ?? '',
      accountType: fields.kind === 'stock' ? stockAccountType(fields.id) : fields.accountType,
      referenceJpy: fields.referenceJpy === '' ? null : Number(fields.referenceJpy) };
    if (lot.kind === 'stock' && !lot.broker) {
      return showNotice('米国個別株の証券会社を入力してください。口座区分は特定で固定です。', true);
    }
    const exists = state.positions.some(p => p.id === lot.id);
    const positions = exists ? state.positions.map(p => p.id === lot.id ? lot : p) : [...state.positions, lot];
    if (commit({ ...state, positions, confirmed: false })) {
      $('lot-dialog').close();
      if (lot.kind === 'stock' && !market.quotes[ticker]?.usd) refreshPrices();
    }
  }

  function drawCompanyPicker(select = $('company-ticker').value) {
    const tickers = [...new Set([...state.targets.map(t => t.ticker), ...state.positions.filter(p => p.kind === 'stock').map(p => p.ticker),
      ...state.company.map(v => v.ticker)])];
    $('company-ticker').innerHTML = options(Object.fromEntries(tickers.map(t => [t, t])), select);
    renderCompany();
  }

  function companyRecord(ticker) {
    return state.company.find(v => v.ticker === ticker) ?? { ticker, thesis: '', breaks: '',
      scenarios: { bear: '', base: '', bull: '' }, observations: [] };
  }

  function renderCompany() {
    const ticker = $('company-ticker').value;
    const company = companyRecord(ticker);
    $('company-thesis').textContent = company.thesis || '—';
    $('company-breaks').textContent = company.breaks || '—';
    $('company-edit').disabled = !ticker;
    $('company-observe').disabled = !ticker;
    $('company-earnings').textContent = root.getEarningsDate(ticker) || '取得済みの決算予定なし';
    for (const s of ['bear', 'base', 'bull']) $('company-' + s).textContent = company.scenarios[s] || '—';
    $('company-table').innerHTML = buildTable(['指標', '区分', '期間', '値・内容', '出典', '基準日', '操作'],
      company.observations.map(o => `<tr><td>${o.metric}</td><td>${kinds[o.kind]}</td><td>${escape(o.period)}</td>
      <td class="pm-description">${escape(o.value)}</td><td class="pm-description">${escape(o.source)}</td><td>${o.date ?? '—'}</td>
      <td><button class="btn btn-ghost btn-sm" data-observation="${o.id}">編集</button>
      <button class="btn btn-danger btn-sm" data-remove-observation="${o.id}">削除</button></td></tr>`).join(''), '評価指標の記録はありません。');
  }

  function saveCompany(value) {
    const company = [...state.company.filter(v => v.ticker !== value.ticker), value];
    if (!commit({ ...state, company })) return false;
    renderCompany();
    return true;
  }

  function openObservation(id) {
    const ticker = $('company-ticker').value;
    const o = companyRecord(ticker).observations.find(v => v.id === id);
    const form = $('observation-form');
    form.reset();
    form.elements.namedItem('metric').innerHTML = options(Object.fromEntries(D.METRICS.map(m => [m, m])), o?.metric);
    form.elements.namedItem('kind').innerHTML = options(kinds, o?.kind);
    for (const [k, v] of Object.entries(o ?? { id: '' })) form.elements.namedItem(k).value = v ?? '';
    form.elements.namedItem('ticker').value = ticker;
    $('observation-dialog').showModal();
  }

  function markEdited(form) {
    if (dirty.has(form)) return;
    dirty.add(form);
    render();
    root.renderPlans();
  }

  function saveForm(form, next) {
    const edited = dirty.delete(form);
    if (commit(next)) return true;
    if (edited) dirty.add(form);
    return false;
  }

  function init(changed) {
    afterChange = changed;
    try { state = S.load(); }
    catch {
      storageError = '保存済みV2.3データを読み込めません。データ管理からバックアップを復元できます。';
      recovering = true;
    }
    window.addEventListener('storage', event => {
      if (event.key === D.KEY || event.key === null) {
        recovering = false;
        storageError = '別タブで保存が変更されました。再読み込みしてください。';
        render();
      }
    });
    $('price-update').onclick = () => refreshPrices();
    $('pm-broker-usdjpy-use').onclick = () => {
      const input = $('pm-broker-usdjpy');
      const entered = input.value;
      const broker = M.manualFx(entered);
      if (broker.error) {
        $('pm-broker-usdjpy-status').textContent = 'USD/JPYを50～300の範囲の有効な数値で入力してください。';
        return;
      }
      if (!confirm('証券会社で現在確認したUSD/JPY=' + broker.rate.toFixed(4) +
          ' を10分間だけ参考レートとして利用します。実際の約定為替や買付余力と異なる場合があります。続行しますか？')) return;
      market.fx = broker;
      $('pm-broker-usdjpy-status').textContent =
        '証券会社で確認した手入力レートを使用中（10分間有効・発注前に要再確認）。';
      render();
    };
    $('confirm-holdings').onclick = () => {
      if (confirm('証券口座と照合して、保有株数・口座区分・円とドルの現金を確認しましたか？')) {
        commit({ ...state, confirmed: true });
      }
    };
    for (const form of Object.keys(formLabels)) {
      $(form).oninput = () => {
        if (form === 'targets-form') updateDraftTargets();
        markEdited(form);
      };
    }
    $('cash-form').onsubmit = e => {
      e.preventDefault();
      saveForm('cash-form', { ...state, confirmed: false, cash: { jpy: Number($('cash-jpy').value), usd: Number($('cash-usd').value),
        extraJpy: Number($('cash-extra').value), extraIncluded: $('cash-included').checked } });
    };
    $('tax-form').onsubmit = e => {
      e.preventDefault();
      saveForm('tax-form', { ...state, tax: { rate: Number($('tax-rate').value), offset: $('tax-offset').value } });
    };
    $('targets-form').onsubmit = e => {
      e.preventDefault();
      const targets = collectTargets();
      const cashTarget = D.FIXED_CASH;
      if (Object.keys(D.FIXED_WEIGHTS).some(t => !targets.some(x => x.ticker === t)))
        return alert('固定仕様の銘柄は削除できません。「固定仕様に戻す」を押してください。');
      if (Math.abs(targets.reduce((sum, t) => sum + t.pct, cashTarget) - 100) > 1e-6) return alert('目標配分の合計を100%にしてください。');
      if (saveForm('targets-form', { ...state, targets, cashTarget })) {
        drawTargets(state.targets);
        drawCompanyPicker();
        if (targets.some(t => !market.quotes[t.ticker]?.usd)) refreshPrices();
      }
    };
    $('target-detail-toggle').onclick = () => {
      const expanded = $('targets-form').classList.toggle('pm-targets-detailed');
      $('targets-form').classList.toggle('pm-targets-simple', !expanded);
      $('target-detail-toggle').setAttribute('aria-expanded', String(expanded));
      $('target-detail-toggle').textContent = expanded
        ? '売却上限・購入待機を閉じる' : '売却上限・購入待機を表示する';
    };
    $('target-spec-fix').onclick = () => {
      const issues = D.specIssues(state);
      if (!issues.length) return;
      if (!confirm('目標配分を固定仕様（NVDA15・AVGO10・PLTR30・APP20・SOFI5・CRDO3・RKLB4・SPCX3、現金10%）に戻します。\n\n' +
        issues.join('\n') + '\n\n売却上限・購入待機の設定は保持します。よろしいですか？')) return;
      if (commit({ ...state, targets: D.fixedTargets(state.targets), cashTarget: D.FIXED_CASH }, true)) {
        dirty.delete('targets-form');
        drawTargets(state.targets);
      }
    };
    $('target-add').onclick = () => {
      drawTargets([...collectTargets(), { ticker: '', pct: 0, group: 'satellite', wait: true, sellCap: 0 }]);
      markEdited('targets-form');
    };
    $('target-rows').onclick = e => {
      if (e.target.matches('[data-remove]')) {
        e.target.closest('tr').remove();
        updateDraftTargets();
        markEdited('targets-form');
      }
    };
    $('lot-add').onclick = () => openLot();
    $('holdings-lots').onclick = e => {
      const { lot, delete: remove } = e.target.dataset;
      if (lot) openLot(lot);
      if (remove && confirm('選択した保有ロットを削除しますか？')) {
        commit({ ...state, positions: state.positions.filter(p => p.id !== remove), confirmed: false }, true);
      }
    };
    $('lot-form').onsubmit = e => { e.preventDefault(); saveLot(e.currentTarget); };
    $('lot-form').elements.namedItem('kind').onchange = e => syncLotTypeFields(e.currentTarget.form);
    $('csv-export').onclick = () => {
      const out = result();
      if (out.errors.length) return render();
      download('portfolio-rebalance.csv', R.csv(out), 'text/csv;charset=utf-8');
    };
    $('data-export').onclick = backup;
    $('data-local').onclick = previewLegacy;
    $('data-old-file').onclick = async () => {
      try { preview(await S.legacyFile(), '旧ローカルファイル'); }
      catch (e) { showNotice(e.message, true); }
    };
    $('data-previous').onclick = () => {
      const old = S.read(D.BACKUP);
      if (old) preview(old, '上書き直前の自動バックアップ');
      else showNotice('自動バックアップはまだありません。');
    };
    $('data-upload').onchange = async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file) try { preview(await S.readFile(file), '選択したJSON'); }
      catch (err) { showNotice(err.message, true); }
    };
    $('data-accept').onclick = acceptPreview;
    $('data-review').onclose = () => { pending = null; };
    $('cloud-load').onclick = async () => {
      if (!$('cloud-consent').checked) return showNotice('JSONBinへの接続を許可してください。', true);
      try { preview(await S.jsonbin($('s-jb-key').value.trim(), $('s-jb-bin').value.trim()), 'JSONBinのバックアップ'); }
      catch (e) { showNotice(e.message, true); }
    };
    $('cloud-save').onclick = async () => {
      if (!$('cloud-consent').checked) return showNotice('JSONBinへの接続を許可してください。', true);
      if (storageError || !confirm('現在の資産・履歴のバックアップをJSONBinの新規プライベートBinに送信しますか？')) return;
      const button = $('cloud-save');
      button.disabled = true;
      try {
        $('s-jb-bin').value = await S.jsonbin($('s-jb-key').value.trim(), null, D.validate(state));
        showNotice('新規プライベートBinを作成しました。Bin IDを保存してください。');
      } catch (e) { showNotice(e.message, true); }
      finally { button.disabled = false; }
    };
    $('company-ticker').onchange = renderCompany;
    $('company-edit').onclick = () => {
      const c = companyRecord($('company-ticker').value);
      const form = $('company-form');
      for (const [k, v] of Object.entries({ ticker: c.ticker, thesis: c.thesis, breaks: c.breaks, ...c.scenarios })) {
        form.elements.namedItem(k).value = v;
      }
      $('company-dialog').showModal();
    };
    $('company-form').onsubmit = e => {
      e.preventDefault();
      const { ticker, thesis, breaks, bear, base, bull } = Object.fromEntries(new FormData(e.currentTarget));
      if (saveCompany({ ...companyRecord(ticker), thesis, breaks, scenarios: { bear, base, bull } })) $('company-dialog').close();
    };
    $('company-observe').onclick = () => openObservation();
    $('company-table').onclick = e => {
      const { observation, removeObservation } = e.target.dataset;
      if (observation) openObservation(observation);
      if (removeObservation && confirm('評価指標を削除しますか？')) {
        const c = companyRecord($('company-ticker').value);
        saveCompany({ ...c, observations: c.observations.filter(o => o.id !== removeObservation) });
      }
    };
    $('observation-form').onsubmit = e => {
      e.preventDefault();
      const { ticker, ...o } = Object.fromEntries(new FormData(e.currentTarget));
      const c = companyRecord(ticker);
      o.id ||= id();
      o.date ||= null;
      const observations = c.observations.some(v => v.id === o.id)
        ? c.observations.map(v => v.id === o.id ? o : v) : [...c.observations, o];
      if (saveCompany({ ...c, observations })) $('observation-dialog').close();
    };
    document.querySelectorAll('[data-close-dialog]').forEach(button => {
      button.onclick = () => button.closest('dialog').close();
    });
    fillSettings();
    afterChange();
    render();
    if (!localStorage.getItem(D.KEY) && ['pm_positions', 'pm_plans', 'pm_trade_log', 'pm_watchlist'].some(k => localStorage.getItem(k) != null)) {
      showNotice('旧ブラウザー保存を移行できます。「旧ブラウザーデータを確認」から差分を確認してください。');
    }
    root.PMStagedFunding?.init();
    refreshPrices();
    setInterval(refreshPrices, 30 * 60 * 1000);
    setInterval(() => {
      render();
      root.renderWatchlist();
      root.renderPlans();
    }, 60 * 1000);
  }

  // Valuation for reference cards (performance, rule panels): reference FX is fine
  // here; order-grade FX is required only for ③ share counts.
  const valuation = () => R.ideal(state, market);
  root.PMApp = { init, state: () => state, market: () => market, commit, render, renderCompany, result, valuation, freshPrice, fxRate, refreshPrices, escape, id, showNotice, previewImport: preview,
    backupJson: backup, storageError: () => storageError, diffText: (current, next, source) => diff(current, next, 0, source) };
})(globalThis);
