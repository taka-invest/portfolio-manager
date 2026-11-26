'use strict';

((root) => {
  const VERSION = 3;
  const KEY = 'pm_workspace_v3';
  const BACKUP = 'pm_workspace_v3_previous';
  const TYPES = { unknown: '未確認', specific: '特定', general: '一般', nisa: 'NISA', other: 'その他' };
  const KINDS = { stock: '米国個別株', fund: '積立NISA投信', excluded: 'その他・対象外', review: '要確認' };
  const METRICS = ['売上成長率', 'GAAP EPS', '調整後EPS', '営業利益率', 'フリーキャッシュフロー',
    '会社ガイダンス', 'アナリスト予想', 'Forward P/E', '2028年の想定EPS'];
  // Owner's fixed specification (not user-editable): stock weights and cash target.
  const FIXED_WEIGHTS = Object.freeze({ NVDA: 15, AVGO: 10, PLTR: 30, APP: 20, SOFI: 5, CRDO: 3, RKLB: 4, SPCX: 3 });
  const FIXED_CASH = 10;
  const PLTR_FLOOR = 30;
  const STAGED = ['NVDA', 'AVGO', 'CRDO'];
  const DEFAULT_TARGETS = Object.entries(FIXED_WEIGHTS)
    .map(([ticker, pct], i) => ({
      ticker, pct, group: i < 5 ? 'core' : 'satellite', wait: i >= 5, sellCap: ticker === 'PLTR' ? 0 : null
    }));
  const PREFS = ['theme', 'currency', 'perf_start', 'ac', 'l1_trigger', 'l2_harvest', 'cash_min'];
  const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,19}$/;
  const ID = /^[A-Za-z0-9_-]{1,100}$/;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const num = (v, min = 0, max = 1e14) => Number.isFinite(v) && v >= min && v <= max;
  const str = (v, max = 2000) => typeof v === 'string' && v.length <= max;
  const date = v => typeof v === 'string' && DATE.test(v) && Number.isFinite(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v;
  const when = v => str(v, 40) && Number.isFinite(Date.parse(v));
  const optional = (v, predicate) => v == null || predicate(v);
  const validId = v => typeof v === 'string' && ID.test(v);
  const ticker = v => typeof v === 'string' && TICKER.test(v);
  const readyLot = p => p.kind !== 'review' && (p.kind !== 'stock' || Boolean(p.broker.trim() && p.accountType !== 'unknown'));
  const copy = v => JSON.parse(JSON.stringify(v));
  const pick = (v, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(v, k)).map(k => [k, v[k]]));
  const assert = (valid, label) => { if (!valid) throw new Error(label + 'の形式を確認してください。'); };

  function uniqueRows(rows, validate, label, key = 'id') {
    assert(Array.isArray(rows) && rows.length <= 10000, label);
    const parsed = rows.map(validate);
    assert(new Set(parsed.map(row => row[key])).size === parsed.length, label + 'の識別子');
    return parsed;
  }

  function blank() {
    return {
      version: VERSION, positions: [], targets: copy(DEFAULT_TARGETS), cashTarget: 10,
      cash: { jpy: 0, usd: 0, extraJpy: 0, extraIncluded: true }, confirmed: false,
      tax: { rate: 20.315, offset: 'none' }, stagedFunding: null,
      plans: [], trades: [], watchlist: [], company: [], preferences: {}
    };
  }

  function position(v) {
    assert(record(v) && validId(v.id) && ticker(v.ticker) && Object.hasOwn(TYPES, v.accountType) &&
      Object.hasOwn(KINDS, v.kind) && str(v.broker, 120) && str(v.account, 120) && num(v.shares, 0.00000001) &&
      (v.layer === 1 || v.layer === 2) && ['JPY', 'USD'].includes(v.currency) &&
      optional(v.unitCost, num) && optional(v.costJpy, num) && optional(v.referenceJpy, num) && str(v.note), '保有ロット');
    return { ...pick(v, ['id', 'ticker', 'kind', 'broker', 'account', 'accountType', 'shares', 'currency',
      'unitCost', 'costJpy', 'referenceJpy', 'layer', 'note']), unitCost: v.unitCost ?? null,
      costJpy: v.costJpy ?? null, referenceJpy: v.referenceJpy ?? null,
      // User-confirmed rule: currently unclassified US-stock lots are in 特定口座.
      // Explicitly tagged NISA/general lots are preserved to avoid silent tax changes.
      accountType: v.kind === 'stock' && v.accountType === 'unknown' ? 'specific' : v.accountType };
  }

  function target(v) {
    assert(record(v) && ticker(v.ticker) && num(v.pct, 0, 100) && ['core', 'satellite'].includes(v.group) &&
      typeof v.wait === 'boolean' && optional(v.sellCap, n => num(n) && Number.isSafeInteger(n)), '銘柄別配分');
    return { ...pick(v, ['ticker', 'pct', 'group', 'wait']), sellCap: v.sellCap ?? null };
  }

  function plan(v) {
    assert(record(v) && validId(v.id) && ticker(v.ticker) && [1, 2].includes(v.layer) &&
      num(v.targetPct, 0, 100) && str(v.note ?? '') && when(v.createdAt) && typeof v.completed === 'boolean', '購入計画');
    const tranches = uniqueRows(v.tranches, t => {
      assert(record(t) && [1, 2, 3].includes(t.stage) && num(t.allocPct, 0, 100) && str(t.trigger ?? '') &&
        typeof t.executed === 'boolean' && optional(t.executedAt, when) && optional(t.executedShares, num) &&
        optional(t.executedPriceJpy, num), '購入計画の段階');
      return pick(t, ['stage', 'allocPct', 'trigger', 'executed', 'executedAt', 'executedShares', 'executedPriceJpy']);
    }, '購入計画の段階', 'stage');
    return { ...pick(v, ['id', 'ticker', 'layer', 'targetPct', 'note', 'createdAt', 'completed']), tranches };
  }

  const shareMap = v => record(v) && Object.keys(v).length === STAGED.length &&
    STAGED.every(k => Number.isSafeInteger(v[k]) && v[k] >= 0);

  function stagedFunding(v) {
    if (v == null) return null; // Existing V2.6 workspaces remain compatible.
    assert(record(v) && when(v.startedAt) && record(v.baselineShares), '段階買付計画');
    assert(shareMap(v.baselineShares), '開始時の保有株数');
    // The current stage is part of the synced plan (not per-browser), so every PC
    // computes the same tranche. Older workspaces without it start at stage 1.
    const stage = v.stage ?? 1;
    assert([1, 2, 3].includes(stage), '段階買付の現在の段階');
    const log = v.stageLog ?? [];
    assert(Array.isArray(log) && log.length <= stage - 1, '段階買付の実行記録');
    const stageLog = log.map((e, i) => {
      assert(record(e) && e.stage === i + 1 && when(e.at) && shareMap(e.shares) && typeof e.skipped === 'boolean',
        '段階買付の実行記録');
      return { stage: e.stage, at: e.at, shares: pick(e.shares, STAGED), skipped: e.skipped };
    });
    return { startedAt: v.startedAt, baselineShares: pick(v.baselineShares, STAGED), stage, stageLog };
  }

  /** Differences between the saved targets and the owner's fixed specification. */
  function specIssues(state) {
    const issues = [];
    const targets = new Map((state?.targets ?? []).map(t => [t.ticker, t]));
    for (const [ticker, pct] of Object.entries(FIXED_WEIGHTS)) {
      const t = targets.get(ticker);
      if (!t || Math.abs(t.pct - pct) > 1e-9) issues.push(`${ticker}の目標比率は${pct}%（固定仕様）です。`);
    }
    for (const t of targets.values())
      if (!Object.hasOwn(FIXED_WEIGHTS, t.ticker) && t.pct > 0) issues.push(`${t.ticker}は固定配分外のため目標比率0%です。`);
    if (Math.abs((state?.cashTarget ?? NaN) - FIXED_CASH) > 1e-9) issues.push(`現金目標は${FIXED_CASH}%（固定仕様）です。`);
    return issues;
  }

  /** Targets restored to the fixed specification; per-ticker operating settings are kept. */
  function fixedTargets(targets = []) {
    const by = new Map(targets.map(t => [t.ticker, t]));
    const fixed = DEFAULT_TARGETS.map(d => ({ ...d, ...(by.has(d.ticker) ? pick(by.get(d.ticker), ['group', 'wait', 'sellCap']) : {}), pct: d.pct }));
    const extra = targets.filter(t => !Object.hasOwn(FIXED_WEIGHTS, t.ticker)).map(t => ({ ...t, pct: 0 }));
    return [...fixed, ...extra];
  }

  function trade(v) {
    assert(record(v) && validId(v.id) && ticker(v.ticker) && str(v.action, 32) && when(v.date) &&
      num(v.shares) && num(v.priceJpy) && num(v.totalJpy, 0, 1e28) && str(v.note ?? ''), '取引履歴');
    const market = v.market ?? {};
    assert(record(market) && ['vix', 'fg', 'spyDrawdown'].every(k => optional(market[k], n => num(n, -1e6, 1e6))), '取引時の市場指標');
    return { ...pick(v, ['id', 'ticker', 'action', 'date', 'shares', 'priceJpy', 'totalJpy', 'note', 'lotId']),
      market: pick(market, ['vix', 'fg', 'spyDrawdown']) };
  }

  function watch(v) {
    assert(record(v) && validId(v.id) && ticker(v.ticker) && [1, 2].includes(v.layer) &&
      optional(v.targetPriceJpy, num) && optional(v.curPriceJpy, num) && str(v.condition ?? '') &&
      str(v.note ?? '') && optional(v.addedAt, when), 'ウォッチリスト');
    return pick(v, ['id', 'ticker', 'layer', 'targetPriceJpy', 'curPriceJpy', 'condition', 'note', 'addedAt']);
  }

  function company(v) {
    assert(record(v) && ticker(v.ticker) && str(v.thesis, 10000) && str(v.breaks, 10000) &&
      record(v.scenarios) && ['bear', 'base', 'bull'].every(k => str(v.scenarios[k], 5000)), '企業評価');
    const observations = uniqueRows(v.observations, o => {
      assert(record(o) && validId(o.id) && METRICS.includes(o.metric) &&
        ['actual', 'forecast', 'personal'].includes(o.kind) && str(o.value, 500) && str(o.source, 500) &&
        str(o.period, 100) && optional(o.date, date), '企業評価の指標');
      return pick(o, ['id', 'metric', 'kind', 'value', 'source', 'period', 'date']);
    }, '企業評価の指標');
    return { ...pick(v, ['ticker', 'thesis', 'breaks']), scenarios: pick(v.scenarios, ['bear', 'base', 'bull']), observations };
  }

  function preferences(v) {
    assert(record(v), '表示設定');
    const p = pick(v, PREFS);
    assert(optional(p.theme, t => ['light', 'dark'].includes(t)) && optional(p.currency, c => ['jpy', 'usd'].includes(c)) &&
      optional(p.perf_start, d => d === '' || date(d)) &&
      optional(p.ac, a => record(a) && Object.values(a).every(x => typeof x === 'boolean')) &&
      ['l1_trigger', 'l2_harvest', 'cash_min'].every(k => optional(p[k], n => num(n, 0, 100))), '表示設定');
    return p;
  }

  function validate(v) {
    assert(record(v) && v.version === VERSION, 'バックアップのバージョン');
    const { cash, tax } = v;
    assert(record(cash) && num(cash.jpy) && num(cash.usd) && num(cash.extraJpy) &&
      typeof cash.extraIncluded === 'boolean', '現金残高');
    assert(num(v.cashTarget, 0, 100) && typeof v.confirmed === 'boolean' &&
      record(tax) && num(tax.rate, 0, 100) && ['none', 'account', 'eligible'].includes(tax.offset), '計算設定');
    const positions = uniqueRows(v.positions, position, '保有ロット');
    assert(!v.confirmed || positions.every(readyLot), '保有確認');
    return {
      version: VERSION, positions, targets: uniqueRows(v.targets, target, '目標配分', 'ticker'),
      cashTarget: v.cashTarget, cash: pick(cash, ['jpy', 'usd', 'extraJpy', 'extraIncluded']),
      confirmed: v.confirmed, tax: pick(tax, ['rate', 'offset']),
      stagedFunding: stagedFunding(v.stagedFunding),
      plans: uniqueRows(v.plans, plan, '購入計画'), trades: uniqueRows(v.trades, trade, '取引履歴'),
      watchlist: uniqueRows(v.watchlist, watch, 'ウォッチリスト'), company: uniqueRows(v.company, company, '企業評価', 'ticker'),
      preferences: preferences(v.preferences)
    };
  }

  // The old application assigned random IDs and refreshed prices on the seeded rows.
  const seeds = { PLTR: [1021, 1500], APP: [15, 6000], SOFI: [300, 1200], RKLB: [200, 750], CRWV: [50, 6000] };
  function isSample(p) {
    const seed = Object.hasOwn(seeds, p.ticker) && seeds[p.ticker];
    return seed && seed[0] === p.shares && seed[1] === (p.buyPrice ?? (p.costJpy / p.shares)) &&
      (p.buyPrice != null || (p.kind === 'review' && !p.broker && !p.account));
  }

  function legacyPosition(v) {
    assert(record(v) && validId(v.id) && ticker(v.ticker) && [1, 2].includes(v.layer) &&
      num(v.buyPrice) && num(v.curPrice) && num(v.shares, 0.00000001) && str(v.note ?? ''), '旧保有ロット');
    return position({
      ...pick(v, ['id', 'ticker', 'layer', 'shares']), broker: '', account: '', accountType: 'unknown',
      kind: 'review', currency: 'JPY', unitCost: v.buyPrice, costJpy: v.buyPrice * v.shares,
      referenceJpy: v.curPrice, note: v.note ?? ''
    });
  }

  function prepare(payload, current = blank()) {
    if (record(payload) && Object.hasOwn(payload, 'version')) {
      return { next: { ...validate(payload), confirmed: false }, samples: 0 };
    }
    const v = Array.isArray(payload) ? { positions: payload } : payload;
    assert(record(v) && ['positions', 'plans', 'trades', 'watchlist'].some(k => Object.hasOwn(v, k)), '旧バックアップ');
    const hasPositions = Object.hasOwn(v, 'positions');
    assert(!hasPositions || (Array.isArray(v.positions) && v.positions.length <= 10000), '旧保有ロット');
    const lots = hasPositions ? v.positions : [];
    const samples = lots.filter(p => record(p) && isSample(p)).length;
    const positions = hasPositions ? lots.filter(p => !record(p) || !isSample(p)).map(legacyPosition) : current.positions;
    return {
      next: validate({ ...current, ...pick(v, ['plans', 'trades', 'watchlist', 'preferences']), positions, confirmed: false }),
      samples
    };
  }

  const api = { KEY, BACKUP, TYPES, KINDS, METRICS, FIXED_WEIGHTS, FIXED_CASH, PLTR_FLOOR, STAGED, ticker, date, blank,
    validate, prepare, copy, readyLot, specIssues, fixedTargets };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMData = api;
})(globalThis);
