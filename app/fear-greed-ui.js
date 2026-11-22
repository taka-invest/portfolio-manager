'use strict';

((root) => {
  const model = root.PMFearGreed;
  const url = 'https://raw.githubusercontent.com/taka-invest/portfolio-manager/market-data/fear-greed.json';
  const cacheKey = 'pm_fg_snapshot_v1';
  const labels = {
    'access-denied': '配信元のアクセス拒否または取得制限',
    http: '配信元の応答エラー', timeout: '配信元のタイムアウト', network: '配信元への接続エラー', format: '配信元のデータ形式エラー',
    missing: '公開データなし', unavailable: '公開データ取得失敗', invalid: '公開データの形式エラー'
  };
  const dateTime = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' });
  const dateLabel = new Intl.DateTimeFormat('ja-JP', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
  const $ = id => document.getElementById(id);
  const num = value => value.toLocaleString('ja-JP', { maximumFractionDigits: 1 });
  let data = null, problem = null, updating = false, days = 30, onChange = () => {};

  function drawChart(snapshot) {
    const chart = $('fg-chart');
    const line = $('fg-line');
    const empty = $('fg-chart-empty');
    const range = $('fg-chart-range');
    const series = snapshot && model.series(snapshot, days);
    const hasHistory = !!series && series.rows.length >= 2;
    chart.hidden = !hasHistory;
    empty.hidden = hasHistory;
    range.hidden = !hasHistory;
    if (!hasHistory) {
      line.removeAttribute('points');
      return;
    }

    const { start, end, rows } = series;
    line.setAttribute('points', rows.map(([when, value]) =>
      `${(34 + 266 * (when - start) / (end - start)).toFixed(2)},${(116 - 108 * value / 100).toFixed(2)}`
    ).join(' '));
    const first = rows[0][0], last = rows.at(-1)[0];
    range.textContent = `${dateLabel.format(first)} ～ ${dateLabel.format(last)}（${rows.length}件）` +
      (first - start > 7 * 86400000 ? '・取得できた期間のみ表示' : '');
    $('fg-chart').setAttribute('aria-label', `過去${days}日の推移。${range.textContent}`);
  }

  function currentScore() {
    return problem || data?.status !== 'ok' || model.stale(data.snapshot) ? null : data.snapshot.score;
  }

  function render() {
    const s = data?.snapshot;
    const stale = !!s && model.stale(s);
    const error = problem ?? (data?.status === 'error' ? data.error : null);
    $('fg-value').textContent = s ? num(s.score) : '—';
    $('fg-value').className = 's-value' + (s ? ' fg-' + s.rating.toLowerCase().replaceAll(' ', '-') : '');
    $('fg-label').textContent = s?.rating ?? '—';
    const flags = [error && labels[error], stale && '古いデータ（参考値）'].filter(Boolean);
    if (error && s && !stale) flags.push('保存済みの参考値');
    $('fg-status').textContent = flags.join(' ／ ') || (s ? '利用可' : '公開データを確認中…');
    $('fg-asof').textContent = s ? 'データ基準 ' + dateTime.format(new Date(s.asOf)) + ' JST' : '';
    $('fg-attempt').textContent = data ? '配信元への最終取得試行 ' + dateTime.format(new Date(data.attemptedAt)) + ' JST' : '';

    for (const key of ['previous', 'week', 'month']) {
      const value = s?.comparisons[key];
      $('fg-' + key).textContent = value == null ? '—' : `${num(value)}（${s.score > value ? '+' : ''}${num(s.score - value)} pt）`;
    }
    drawChart(s);
  }

  async function refresh() {
    if (updating) return;
    updating = true;
    try {
      const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) {
        problem = response.status === 404 ? 'missing' : 'unavailable';
        return;
      }
      try {
        const next = model.validate(await response.json());
        if (data && Date.parse(next.attemptedAt) < Date.parse(data.attemptedAt)) throw new Error();
        data = next;
        problem = null;
        try { localStorage.setItem(cacheKey, JSON.stringify(next)); } catch { /* optional cache */ }
      } catch { problem = 'invalid'; }
    } catch { problem = 'unavailable'; }
    finally {
      updating = false;
      render();
      onChange();
    }
  }

  function init(callback) {
    onChange = callback;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) data = model.validate(JSON.parse(raw));
    } catch { /* read the published feed when no valid cache exists */ }
    $('fg-range').addEventListener('click', event => {
      const button = event.target.closest('button[data-days]');
      if (!button) return;
      days = Number(button.dataset.days);
      for (const control of $('fg-range').querySelectorAll('button')) control.setAttribute('aria-pressed', String(control === button));
      drawChart(data?.snapshot);
    });
    render();
  }

  root.PMFearGreedUI = { init, refresh, currentScore };
})(globalThis);
