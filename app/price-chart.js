'use strict';
// 株価チャート: normalised price history from /api/chart drawn as an accessible inline
// SVG (no third-party chart library, works in light/dark via CSS variables).
((root) => {
  const $ = id => document.getElementById(id);
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const money = v => fin(v) ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '—';

  function status(message, warn = false) {
    const el = $('pm-chart-status');
    el.textContent = message; el.dataset.warn = String(warn); el.hidden = !message;
  }

  /** Build an SVG path for the closes. Exported for tests. */
  function svg(points, { width = 720, height = 260, pad = 36 } = {}) {
    const closes = points.map(p => p.close);
    const min = Math.min(...closes), max = Math.max(...closes);
    const span = max - min || 1;
    const x = i => pad + (i / Math.max(points.length - 1, 1)) * (width - pad * 2);
    const y = v => height - pad - ((v - min) / span) * (height - pad * 2);
    const d = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.close).toFixed(1)).join(' ');
    const first = points[0], last = points.at(-1);
    const up = last.close >= first.close;
    const label = `${first.t}から${last.t}までの終値。最安${money(min)}、最高${money(max)}、期間騰落率${((last.close / first.close - 1) * 100).toFixed(1)}%`;
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${root.PMApi.esc(label)}" style="width:100%;height:auto;display:block">
      <line x1="${pad}" y1="${y(max)}" x2="${width - pad}" y2="${y(max)}" stroke="var(--border)" stroke-dasharray="4 4"/>
      <line x1="${pad}" y1="${y(min)}" x2="${width - pad}" y2="${y(min)}" stroke="var(--border)" stroke-dasharray="4 4"/>
      <text x="${pad}" y="${y(max) - 6}" fill="var(--muted)" font-size="12">最高 ${money(max)}</text>
      <text x="${width - pad}" y="${y(min) - 6}" fill="var(--muted)" font-size="12" text-anchor="end">最安 ${money(min)}</text>
      <path d="${d}" fill="none" stroke="${up ? 'var(--green)' : 'var(--red)'}" stroke-width="2" stroke-linejoin="round"/>
      <text x="${pad}" y="${height - 8}" fill="var(--muted)" font-size="12">${root.PMApi.esc(first.t)}</text>
      <text x="${width - pad}" y="${height - 8}" fill="var(--muted)" font-size="12" text-anchor="end">${root.PMApi.esc(last.t)}</text>
    </svg>`;
  }

  async function draw(event) {
    event?.preventDefault();
    const ticker = String($('pm-chart-ticker').value || '').trim().toUpperCase();
    if (!root.PMApi.TICKER.test(ticker)) { status('銘柄コードの形式を確認してください（例：NVDA）。', true); return; }
    $('pm-chart-ticker').value = ticker;
    const range = $('pm-chart-range').value;
    status(ticker + ' の株価データを取得しています…');
    const out = await root.PMApi.call('/api/chart?ticker=' + encodeURIComponent(ticker) + '&range=' + encodeURIComponent(range), { kind: 'チャート' });
    if (out.error) { status(out.error, true); $('pm-chart-result').innerHTML = ''; return; }
    const d = out.data;
    if (!d.points || d.points.length < 2) { status('表示できる株価データがありません。', true); return; }
    const first = d.points[0], last = d.points.at(-1);
    const change = (last.close / first.close - 1) * 100;
    const esc = root.PMApi.esc;
    $('pm-chart-result').innerHTML = `
      <div class="pm-stage-grid">
        <div><small>最新終値（${esc(d.currency)}）</small><strong>${money(last.close)}</strong><small>${esc(last.t)}</small></div>
        <div><small>期間騰落率（${esc(d.range)}）</small><strong style="color:${change >= 0 ? 'var(--green)' : 'var(--red)'}">${change.toFixed(1)}%</strong><small>${esc(first.t)}起点</small></div>
        <div><small>データ点数</small><strong>${d.points.length}</strong><small>間隔 ${esc(d.interval)}</small></div>
      </div>
      <div class="pm-card" id="pm-chart-svg"></div>
      <p class="pm-muted pm-small">出典：${esc(d.source?.provider)}（${esc(d.source?.note)}）／取得 ${d.source?.retrievedAt ? new Date(d.source.retrievedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST' : '—'}。表示のみで、保有評価額や売買計算には使いません。</p>`;
    // Draw at the container's real width (1:1 scale) so labels stay readable on phones.
    const box = $('pm-chart-svg');
    const width = Math.max(300, Math.round(box.clientWidth - 32));
    box.innerHTML = svg(d.points, { width, height: Math.round(Math.min(320, Math.max(220, width * 0.45))), pad: width < 480 ? 28 : 36 });
    status('');
  }

  function init() {
    const form = $('pm-chart-form');
    if (!form) return;
    form.addEventListener('submit', draw);
    $('pm-chart-ticker').addEventListener('focus', () => {
      $('pm-chart-tickers').innerHTML = root.PMApi.knownTickers().map(t => `<option value="${root.PMApi.esc(t)}"></option>`).join('');
    });
  }

  root.PMPriceChart = { init, svg };
  if (typeof module === 'object' && module.exports) module.exports = root.PMPriceChart;
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(globalThis);
