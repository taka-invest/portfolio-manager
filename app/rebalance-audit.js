'use strict';

((root) => {
  const TOLERANCE_PCT = 0.5;
  const EPS = 1e-7;
  const add = (items, severity, code, ticker, actual, target, reason, action) => {
    items.push({ severity, code, ticker, actualPct: actual, targetPct: target,
      gapPct: actual - target, reason, action });
  };
  const isFiniteValue = n => typeof n === 'number' && Number.isFinite(n);

  // An audit of the *simulated outcome*, not an order or an instruction to trade.
  // A 0% target requires zero residual shares even when its weight is under 0.5pp.
  function assess(out, state, tolerancePct = TOLERANCE_PCT) {
    if (!out || !Array.isArray(out.errors) || out.errors.length ||
      !isFiniteValue(out.postTotal) || out.postTotal <= 0 ||
      !Array.isArray(out.rows) || !isFiniteValue(out.cashAfterPct)) {
      return { status: 'pending', label: '計算保留', tolerancePct, issues: [],
        maxGapPct: null, sumGapPct: null, count: 0, cashAfterPct: null,
        message: '実保有・現金・株価・為替と保存済み配分を確認すると、売買後の目標達成度を検証します。' };
    }
    const issues = [];
    const cashTarget = state.cashTarget;
    const calcTotal = out.rows.reduce((n, row) => n + row.afterValue, out.cashAfter);
    if (!isFiniteValue(calcTotal) ||
        Math.abs(calcTotal - out.postTotal) > Math.max(2, out.postTotal * 1e-6)) {
      add(issues, 'blocked', 'reconciliation', 'TOTAL', 0, 0,
        '売買後評価額の合計と税引き後対象資産が一致していません。',
        '売買計画を実行せず、計算条件・データを再確認してください。');
    }
    for (const row of out.rows) {
      const target = row.t?.pct ?? 0;
      const actual = row.afterPct;
      if (!isFiniteValue(actual) || !isFiniteValue(row.afterShares) || row.afterShares < -EPS) {
        add(issues, 'blocked', 'invalid', row.ticker, 0, target,
          '計算結果が不正です。', '注文せずに株数と価格を点検してください。');
        continue;
      }
      const gap = actual - target;
      const targetNotHeld = !row.t || target === 0;
      if (targetNotHeld && row.afterShares > EPS) {
        add(issues, 'blocked', row.t ? 'zero-target' : 'unregistered', row.ticker,
          actual, target,
          row.t ? '目標0%の保有株が売却後も残ります。' :
            '目標配分に登録されていない保有銘柄が残ります。',
          row.t ? '①の売却上限を確認し、売却を許可する場合は上限を空欄にしてください。' :
            '①に目標0%で銘柄を追加し、売却上限を空欄にしてください。');
        continue;
      }
      if (Math.abs(gap) <= tolerancePct + EPS) continue;
      if (gap > tolerancePct) {
        if (row.t?.sellCap === 0) {
          add(issues, 'blocked', 'sale-zero', row.ticker, actual, target,
            '売却上限0株のため、目標を超過した保有株を売れません。',
            '①の売却上限0株を見直し、売却可能なら空欄にしてください。');
        } else if (row.t?.sellCap != null && row.t.sellCap > 0 &&
          -row.order >= row.t.sellCap) {
          add(issues, 'blocked', 'sale-cap', row.ticker, actual, target,
            '売却上限株数に達しており、超過分が残ります。',
            '①の売却上限株数を見直してください。');
        } else if (row.lots?.some(lot =>
          !lot.broker || (lot.accountType !== 'nisa' &&
          (lot.costJpy == null || !['specific','general'].includes(lot.accountType))))) {
          add(issues, 'blocked', 'lot-unavailable', row.ticker, actual, target,
            '証券会社・課税区分・取得原価などの不足で売却できないロットがあります。',
            '保有資産でロット情報を照合してください。');
        } else {
          add(issues, 'blocked', 'unsold-overweight', row.ticker, actual, target,
            '売却後も目標超過が解消できていません。',
            '売却上限、整数株数、税計算の条件と注文案を確認してください。');
        }
      } else if (row.t?.group === 'satellite' && row.t.wait) {
        add(issues, 'partial', 'satellite-wait', row.ticker, actual, target,
          'サテライトの購入待機により目標比率に届きません。',
          '調整まで購入を待つ場合、目標未達を許容してください。');
      } else if (row.status === 'watch' || !(row.jpy > 0)) {
        add(issues, 'partial', 'price-wait', row.ticker, actual, target,
          '有効な参考株価がなく購入株数を計算できません。',
          '株価が取得できてから売買計画を再計算してください。');
      } else if (row.jpy / out.postTotal * 100 > Math.abs(gap) - tolerancePct - EPS) {
        add(issues, 'partial', 'whole-shares', row.ticker, actual, target,
          '整数株の制約で目標比率に正確に一致しません。',
          '株価と買付余力を確認し、許容乖離を判断してください。');
      } else {
        add(issues, 'partial', 'buy-budget', row.ticker, actual, target,
          '売却後の買付余力が不足し、目標株数に届きません。',
          '現金を追加するか、売却上限・現金目標・配分を再検討してください。');
      }
    }
    const cashGap = out.cashAfterPct - cashTarget;
    if (cashGap < -EPS) {
      add(issues, 'blocked', 'cash-short', 'CASH', out.cashAfterPct, cashTarget,
        '売買後現金が最低目標を下回ります。',
        '売買を実行せず、現金・税額・買付余力を再計算してください。');
    } else if (cashGap > tolerancePct + EPS) {
      add(issues, 'partial', 'cash-excess', 'CASH', out.cashAfterPct, cashTarget,
        '目標を超える現金が残ります（購入待機や売買制限を含む）。',
        '購入待機銘柄や株数制約を確認してください。');
    }
    const maxGapPct = Math.max(Math.abs(cashGap), ...out.rows.map(r =>
      Math.abs(r.afterPct - (r.t?.pct ?? 0))));
    const sumGapPct = Math.abs(cashGap) + out.rows.reduce((n, r) =>
      n + Math.abs(r.afterPct - (r.t?.pct ?? 0)), 0);
    const status = issues.some(item => item.severity === 'blocked') ? 'blocked' :
      issues.length ? 'partial' : 'achieved';
    const labels = { achieved: '目標達成（試算）', partial: '一部未達成',
      blocked: '現設定では達成不可' };
    return { status, label: labels[status], tolerancePct, issues,
      count: issues.length, blockedCount: issues.filter(i => i.severity === 'blocked').length,
      maxGapPct, sumGapPct, cashAfterPct: out.cashAfterPct,
      message: status === 'achieved' ? '各銘柄の乖離は許容範囲内で、目標現金も確保できる試算です。' :
        status === 'partial' ? '売買後も目標との差が残ります。下の理由を確認してください。' :
        '売買後に目標外保有または売却制限等が残るため、現在の条件では目標を再現できません。' };
  }

  const api = { assess, TOLERANCE_PCT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMRebalanceAudit = api;
})(globalThis);
