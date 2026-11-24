'use strict';
// 個別企業分析 (Stock Analyzer integration), laid out like the legacy app the owner
// prefers: header card + tabs サマリー / チャート / 投資判断 / 財務諸表. All numbers come
// from the corrected /api/financials (SEC) and /api/chart. Read-only: never changes
// holdings, cash, plans or trades. Missing values are shown as "—", never as 0.
((root) => {
  const API = '/api/financials';
  const CACHE_MS = 10 * 60_000;
  const cache = new Map(); // ticker -> { at, data }
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const num = (v, d = 1) => fin(v) ? v.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—';
  const musd = v => {
    if (!fin(v)) return '—';
    const m = v / 1e6;
    return Math.abs(m) >= 1000 ? '$' + num(m / 1000, 1) + 'B' : '$' + num(m, Math.abs(m) >= 100 ? 0 : 1) + 'M';
  };
  const pct = v => fin(v) ? num(v, 1) + '%' : '—';
  const signed = (v, d = 1, unit = '%') => fin(v) ? (v > 0 ? '+' : '') + num(v, d) + unit : '—';
  const when = iso => iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) + ' JST' : '—';
  const tone = (v, good = 0) => !fin(v) ? 'pm-an-muted' : v > good ? 'pm-an-good' : v < good ? 'pm-an-bad' : '';
  const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
  const PHASE = { phase1: 'Phase1', phase2: 'Phase2', phase3: 'Phase3', financial: '金融' };
  let current = null;      // last rendered payload
  let chartHandle = null;  // lightweight-charts instance

  const knownTickers = state => root.PMApi.knownTickers(state);

  function status(message, kind = 'info') {
    const el = $('pm-analysis-status');
    el.textContent = message;
    el.dataset.warn = String(kind !== 'info');
    el.hidden = !message;
  }

  async function load(ticker, fetcher) {
    const hit = cache.get(ticker);
    if (hit && Date.now() - hit.at < CACHE_MS) return { data: hit.data, cached: true };
    const out = await root.PMApi.call(API + '?ticker=' + encodeURIComponent(ticker), { kind: '分析' }, fetcher);
    if (out.data) cache.set(ticker, { at: Date.now(), data: out.data });
    return out;
  }

  // ── small renderers ───────────────────────────────────────────
  function sparkline(values, { w = 92, h = 30, invert = false, zero = false } = {}) {
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => fin(v));
    if (pts.length < 2) return '<span class="pm-an-muted pm-small">データ不足</span>';
    const ys = pts.map(([, v]) => v);
    const min = Math.min(...ys), max = Math.max(...ys), range = Math.max(max - min, 0.01), pad = 3;
    const xy = pts.map(([i, v]) => [pad + (i / (values.length - 1)) * (w - pad * 2), pad + ((max - v) / range) * (h - pad * 2)]);
    const up = ys.at(-1) >= ys[0];
    const color = (invert ? !up : up) ? 'var(--green)' : 'var(--red)';
    const zy = zero && min < 0 && max > 0 ? pad + (max / range) * (h - pad * 2) : null;
    const last = xy.at(-1);
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
      ${zy != null ? `<line x1="${pad}" y1="${zy}" x2="${w - pad}" y2="${zy}" stroke="var(--border)" stroke-dasharray="2,2"/>` : ''}
      <polyline points="${xy.map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" fill="${color}"/></svg>`;
  }
  const rof40Badge = v => !fin(v) ? '—' : v >= 100 ? `<b class="pm-an-gold">${num(v, 0)}</b>` : v >= 80 ? `<b class="pm-an-good">${num(v, 0)}</b>`
    : v >= 40 ? `<span class="pm-an-good">${num(v, 0)}</span>` : `<span class="pm-an-muted">${num(v, 0)}</span>`;
  const scoreBadge = s => !fin(s) || s <= 0 ? '<span class="pm-an-muted">—</span>'
    : `<span class="pm-an-score ${s >= 70 ? 'hot' : s >= 60 ? 'warm' : ''}">${s}</span>`;
  const cell = (label, value, note = '', cls = '') =>
    `<div class="${cls}"><small>${esc(label)}</small><strong>${value}</strong>${note ? `<small>${note}</small>` : ''}</div>`;

  const ASSUMPTION_LABELS = {
    cagrBasis: '売上成長率の根拠', historicalCagrPct: '実績CAGR（%）', projectedCagrPct: '10年間の想定成長率（%）',
    cagrRule: '成長率の圧縮ルール', operatingMarginNowPct: '現在のTTM営業利益率（%）', sectorTargetPct: '業種の目標営業利益率（%）',
    operatingMargin10yPct: '10年後の想定営業利益率（%）', marginRule: '利益率のルール', taxFactor: '税・少数株主の調整係数',
    revenue10yUsd: '10年後の想定売上（USD）', sharesBasis: '株数の基準', shares: '株数',
    annualShareGrowthPct: '直近1年の株数増加率（%）', dilutionRule: '希薄化の扱い', discounting: '割引'
  };
  const assumptionValue = (k, v) => k === 'revenue10yUsd' ? musd(v) : k === 'shares' && fin(v) ? num(v / 1e6, 0) + '百万株' : esc(v);

  // ── tabs ──────────────────────────────────────────────────────
  function summaryTab(d) {
    const l = d.latest || {}, ev = d.evaluation || {}, ten = ev.tenYear || {}, a = ten.assumptions || {};
    const prices = ten.prices && (ten.prices.withDilution || ten.prices.constantShares);
    const price = d.quote?.price;
    const mult = p => fin(p) && fin(price) && price > 0 ? p / price : null;
    const retBox = (label, p, cls) => {
      const m = mult(p);
      return `<div class="pm-an-ret ${cls}"><small>${label}</small><strong>${fin(m) ? num(m, 1) + '倍' : '—'}</strong>
        <small>${fin(m) && m > 0 ? '年率' + signed((m ** 0.1 - 1) * 100, 1) : '株価未取得'}</small></div>`;
    };
    return `
      <section class="pm-card pm-an-panel">
        <h3>⚡ 10年後株価推定（マシャ式 EPS×PER）</h3>
        <p class="pm-an-muted pm-small">10年後EPS × PER = 目標株価 ｜ 業種：${esc(ev.sectorName || '—')} ｜ 現在TTM EPS：${fin(l.epsDilutedTtm) ? '$' + num(l.epsDilutedTtm, 2) : '—'}（希薄化後）</p>
        ${prices ? `<div class="pm-an-three">
          <div class="pm-an-box bear"><small>🐻 ベア価格（保守的）</small><strong>$${num(prices.bear, 2)}</strong><small>PER ${esc(a.per?.bear)}倍</small></div>
          <div class="pm-an-box base"><small>🎯 標準価格（メイン）</small><strong>$${num(prices.standard, 2)}</strong><small>PER ${esc(a.per?.standard)}倍</small></div>
          <div class="pm-an-box bull"><small>🚀 ブル価格（奥義）</small><strong>$${num(prices.bull, 2)}</strong><small>標準PER × 2倍</small></div>
        </div>
        <div class="pm-an-subpanel"><h4>期待リターン（現在株価 ${fin(price) ? '$' + num(price, 2) : '—'} からの上昇余地）</h4>
          <div class="pm-an-three">${retBox('🐻 ベア', prices.bear, '')}${retBox('🎯 標準', prices.standard, 'mid')}${retBox('🚀 ブル', prices.bull, 'hi')}</div>
        </div>` : `<p class="pm-callout" data-warn="true">算出しない：${esc(ten.reason || '前提データ不足')}</p>`}
        ${(ten.warnings || []).map(w => `<p class="pm-callout" data-warn="true">⚠ ${esc(w)}</p>`).join('')}
        <div class="pm-stage-grid">
          ${cell('TTM EPS（現在）', fin(l.epsDilutedTtm) ? '$' + num(l.epsDilutedTtm, 2) : '—')}
          ${cell('10年後EPS（推定）', fin(prices?.eps10y) ? '$' + num(prices.eps10y, 2) : '—', '希薄化版')}
          ${cell('売上CAGR（調整後）', fin(a.projectedCagrPct) ? signed(a.projectedCagrPct, 1) + ' / 年' : '—', fin(a.historicalCagrPct) ? '実績 ' + num(a.historicalCagrPct, 1) + '%' : '')}
          ${cell('目標OpM（成熟時）', fin(a.operatingMargin10yPct) ? num(a.operatingMargin10yPct, 1) + '%' : '—', fin(a.operatingMarginNowPct) ? 'GAAP ' + num(a.operatingMarginNowPct, 1) + '%' : '')}
        </div>
        <details class="pm-card" id="pm-analysis-tenyear"><summary>前提条件（すべて表示）</summary>
          <ul class="pm-small">${Object.entries(a).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `<li>${esc(ASSUMPTION_LABELS[k] || k)}：${assumptionValue(k, v)}</li>`).join('')}
          ${a.per ? `<li>PER（弱気／標準）：${esc(a.per.bear)}倍／${esc(a.per.standard)}倍（${esc(a.per.name)}）</li>` : ''}</ul>
        </details>
      </section>
      <section class="pm-card pm-an-panel">
        <h3>主要指標</h3>
        <div class="pm-stage-grid" id="pm-analysis-summary">
          ${cell('マシャ総合スコア', fin(ev.masyaScore?.score) ? ev.masyaScore.score + ' / 100' : '—', ev.masyaScore?.complete ? '' : 'データ不足あり')}
          ${cell('投資判断（参考）', esc(ev.judgment?.judgment || '—'), esc(ev.judgment?.note || ''))}
          ${cell('撤退シグナル', esc(ev.exit?.exitLabel || '—'), fin(ev.exit?.exitScore) ? '警戒スコア ' + ev.exit.exitScore : '')}
          ${cell('TTM売上成長率', pct(l.revenueTtmYoYPct), '直近四半期 前年比 ' + pct(l.revenueYoYPct))}
          ${cell('TTM営業利益率', pct(l.operatingMarginTtmPct), 'TTM原価率 ' + pct(l.costRatioTtmPct))}
          ${cell('Rule of 40', num(l.ruleOf40, 1), '旧定義 ' + num(l.ruleOf40Legacy, 1))}
          ${cell('TTM FCF', musd(l.fcfTtm), 'FCFマージン ' + pct(l.fcfMarginTtmPct))}
          ${cell('希薄化後EPS（TTM）', fin(l.epsDilutedTtm) ? '$' + num(l.epsDilutedTtm, 2) : '—')}
          ${cell('株価', fin(price) ? '$' + num(price, 2) : '—', d.quote ? when(d.quote.asOf) : '株価未取得')}
          ${cell('PER（TTM）', fin(ev.multiples?.perTtm) ? num(ev.multiples.perTtm, 1) + '倍' : '—', esc(ev.multiples?.perNote || '株価÷TTM希薄化後EPS'))}
          ${cell('PSR（TTM）', fin(ev.multiples?.psrTtm) ? num(ev.multiples.psrTtm, 1) + '倍' : '—', fin(ev.multiples?.marketCapUsd) ? '時価総額 ' + musd(ev.multiples.marketCapUsd) : '')}
        </div>
      </section>`;
  }

  function trendRows(d) {
    const sig = new Map((d.signals?.byQuarter || []).map(s => [s.end, s]));
    const qs = (d.quarters || []).slice();          // oldest -> newest
    const rows = qs.slice(-12).reverse();            // newest first, 12 quarters
    const idx = end => qs.findIndex(q => q.end === end);
    return rows.map((q, i) => {
      const k = idx(q.end), prev = qs[k - 1], yearAgo = qs[k - 4];
      const s = sig.get(q.end) || {};
      const score = s.score ?? 0;
      const qoq = prev && fin(q.revenue) && fin(prev.revenue) && prev.revenue > 0 ? (q.revenue / prev.revenue - 1) * 100 : null;
      const opmYoY = yearAgo && fin(q.operatingMarginPct) && fin(yearAgo.operatingMarginPct) ? q.operatingMarginPct - yearAgo.operatingMarginPct : null;
      const opYoY = yearAgo && fin(q.operatingIncome) && fin(yearAgo.operatingIncome) && yearAgo.operatingIncome !== 0
        ? (yearAgo.operatingIncome < 0 && q.operatingIncome > 0 ? '黒転' : signed((q.operatingIncome - yearAgo.operatingIncome) / Math.abs(yearAgo.operatingIncome) * 100, 0)) : null;
      const epsD = yearAgo && fin(q.epsDiluted) && fin(yearAgo.epsDiluted) ? q.epsDiluted - yearAgo.epsDiluted : null;
      const accel = fin(s.yoyAccel) ? (s.yoyAccel > 0 ? ' <span class="pm-an-good">↑</span>' : s.yoyAccel < 0 ? ' <span class="pm-an-bad">↓</span>' : '') : '';
      const flags = s.flags || {};
      const badges = [flags.redToBlack && '黒字転換', flags.opMInflection && 'OpM+', (flags.rof40Cross40 || flags.rof40Cross60 || flags.rof40Cross80) && 'RoF40突破', flags.yoyAccelStrong && '売上加速']
        .filter(Boolean).map(b => `<span class="pm-an-tag">${b}</span>`).join('');
      const label = (i === 0 ? '🔵 ' : score >= 75 ? '🚨 ' : score >= 50 ? '⚡ ' : '') + esc(q.end) + (q.revenueDerived ? ' <span class="pm-an-muted" title="通期−9か月累計で算出">※算出</span>' : '');
      return `<tr class="${score >= 75 ? 'pm-an-hot' : score >= 50 ? 'pm-an-warm' : ''}">
        <td><div>${label}</div>${badges}</td>
        <td>${musd(q.revenue)}</td>
        <td class="${tone(q.revenueYoYPct)}">${signed(q.revenueYoYPct)}${accel}</td>
        <td class="${tone(qoq)}">${signed(qoq)}</td>
        <td>${pct(q.costRatioPct)}</td>
        <td>${pct(q.operatingMarginPct)}${fin(s.opMDelta) ? ` <span class="pm-an-muted">(${signed(s.opMDelta, 1, '')})</span>` : ''}</td>
        <td class="${tone(opmYoY)}">${fin(opmYoY) ? signed(opmYoY, 1, 'pp') : '—'}</td>
        <td>${fin(q.operatingLeverageQ) ? num(q.operatingLeverageQ, 1) + 'x' : '—'}</td>
        <td>${rof40Badge(q.ruleOf40Legacy)}</td>
        <td>${num(q.ruleOf40, 0)}</td>
        <td class="${tone(q.operatingIncome)}">${musd(q.operatingIncome)}${opYoY ? ` <span class="pm-an-muted">${opYoY}${opYoY === '黒転' ? '' : '%'}</span>` : ''}</td>
        <td class="${tone(q.epsDiluted)}">${fin(q.epsDiluted) ? signed(q.epsDiluted, 2, '') + (q.epsDilutedDerived ? '※' : '') : '—'}${fin(epsD) ? ` <span class="pm-an-muted">(${signed(epsD, 2, '')})</span>` : ''}</td>
        <td>${scoreBadge(score)}</td></tr>`;
    }).join('');
  }

  function chartTab(d) {
    const qs = (d.quarters || []).slice(-12);
    return `
      <div class="pm-an-chartgrid">
        <section class="pm-card pm-an-panel">
          <div class="pm-an-legend"><span style="color:#818cf8">■</span> MA9週　<span style="color:#ef4444">▲</span> 参入シグナル　<span style="color:#f97316">▲</span> 注目　<span style="color:#fbbf24">●</span> 黒字転換　<span style="color:#6366f1">▲</span> 売上加速　<span style="color:#f97316">▼</span> 成長減速</div>
          <div id="pm-analysis-chart" class="pm-an-chart" aria-label="週足ローソク足チャート"></div>
          <p class="pm-an-muted pm-small" id="pm-analysis-chart-note"></p>
        </section>
        <section class="pm-card pm-an-panel">
          <div class="pm-an-trendhead">
            <div><h3>📈 四半期トレンド分析（過去${qs.length}四半期）</h3>
              <p class="pm-an-muted pm-small">🚨 赤行 = 参入シグナル検知四半期 ／ ※算出 = 通期−9か月累計で求めた第4四半期</p></div>
            <div class="pm-an-sparks">
              <div><small>売上推移</small>${sparkline(qs.map(q => q.revenue))}</div>
              <div><small>原価率 ↓良</small>${sparkline(qs.map(q => q.costRatioPct), { invert: true })}</div>
              <div><small>営業利益率</small>${sparkline(qs.map(q => q.operatingMarginPct), { zero: true })}</div>
              <div><small>RoF40</small>${sparkline(qs.map(q => q.ruleOf40Legacy))}</div>
            </div>
          </div>
          <p class="pm-an-muted pm-small">OpLev = 営業レバレッジ（前年比どうし）｜ RoF40 = 前年比% + 営業利益率%（旧定義。≥40 緑・≥80 太字・≥100 金）｜ R40 TTM = TTM成長率 + TTM FCFマージン ｜ ↑↓ = 前年比の加速/減速 ｜ Score 70+ = 高確度</p>
          <div class="pm-wrap" tabindex="0" aria-label="四半期推移"><table class="pos-table pm-an-trend" id="pm-analysis-quarters">
            <thead><tr><th>四半期 / シグナル</th><th>売上</th><th>YoY(加速)</th><th>QoQ</th><th>原価率</th><th>OpM(ΔQoQ)</th><th>YoY変化</th><th>OpLev</th><th>RoF40</th><th>R40 TTM</th><th>営業利益</th><th>EPS(Δ)</th><th>Score</th></tr></thead>
            <tbody>${trendRows(d)}</tbody></table></div>
        </section>
      </div>`;
  }

  function judgmentTab(d) {
    const ev = d.evaluation || {}, j = ev.judgment || {}, ex = ev.exit || {};
    const list = items => items.length ? `<ul>${items.map(s => `<li>${esc(s.text)}</li>`).join('')}</ul>` : '<p class="pm-an-muted pm-small">なし</p>';
    const sig = j.signals || [];
    const verdictCls = /買い/.test(j.judgment) ? 'good' : /売り|弱気/.test(j.judgment) ? 'bad' : '';
    const exitCls = ex.exitLabel === '継続保有' ? 'good' : ex.exitLabel === '撤退検討' ? 'bad' : 'warn';
    return `
      <section class="pm-card pm-an-panel">
        <h3>✅ マシャ式 投資判断</h3>
        <div class="pm-an-verdict ${verdictCls}">
          <div><strong>${esc(j.judgment || '—')}</strong><small>強気スコア ${esc(j.bullScore)}pt / 弱気スコア ${esc(j.bearScore)}pt</small></div>
          <div class="pm-an-ratio"><small>強気比率</small><b>${esc(j.bullRatio)}%</b><span><i style="width:${Math.max(0, Math.min(100, +j.bullRatio || 0))}%"></i></span></div>
        </div>
        ${j.note ? `<p class="pm-callout" data-warn="true">${esc(j.note)}</p>` : ''}
        <div class="pm-an-two">
          <div class="pm-an-list good"><h4>強気材料</h4>${list(sig.filter(s => s.type === 'bull' || s.type === 'neutral'))}</div>
          <div class="pm-an-list bad"><h4>弱気材料</h4>${list(sig.filter(s => s.type === 'bear'))}</div>
        </div>
        ${sig.some(s => s.type === 'missing') ? `<div class="pm-an-list"><h4>データ不足（加点・減点なし）</h4>${list(sig.filter(s => s.type === 'missing'))}</div>` : ''}
        <p class="pm-an-muted pm-small">※ 配点・閾値は旧アプリと同じ。入力は修正版のSECデータ。最終判断は自己責任で。</p>
      </section>
      <section class="pm-card pm-an-panel">
        <div class="pm-an-verdict ${exitCls}">
          <div><strong>撤退シグナルエンジン</strong><small>四半期トレンドの変曲点を定量検知</small></div>
          <div class="pm-an-ratio"><b>${esc(ex.exitLabel || '—')}</b><small>警戒スコア ${esc(ex.exitScore ?? '—')}点</small></div>
        </div>
        ${list(ex.signals || [])}
      </section>`;
  }

  function statementsTab(d) {
    const l = d.latest || {}, ann = d.annual || [], bal = d.balance || {}, ev = d.evaluation || {};
    const a0 = ann.at(-1), a1 = ann.at(-2);
    const annGrowth = a0 && a1 && fin(a0.revenue) && fin(a1.revenue) && a1.revenue > 0 ? (a0.revenue / a1.revenue - 1) * 100 : null;
    const bb = d.annualFlows?.buyback?.at(-1), iss = d.annualFlows?.stockIssued?.at(-1);
    const row = (k, v, cls = '') => `<div class="pm-an-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
    const asOf = x => x?.end ? ` <small class="pm-an-muted">（${esc(x.end)}）</small>` : '';
    const debt = bal.longTermDebt;
    const debtStale = debt && bal.equity && Date.parse(bal.equity.end) - Date.parse(debt.end) > 400 * 864e5;
    return `
      <div class="pm-an-three-col">
        <section class="pm-card pm-an-panel"><h3>📄 PL 損益計算書</h3>
          ${row('売上高（直近年）' + asOf(a0), musd(a0?.revenue))}
          ${row('売上成長率 TTM', signed(l.revenueTtmYoYPct), tone(l.revenueTtmYoYPct))}
          ${row('売上成長率 年次', signed(annGrowth), tone(annGrowth))}
          ${row('原価率 TTM', pct(l.costRatioTtmPct))}
          ${row('営業利益（直近年）', musd(a0?.operatingIncome), tone(a0?.operatingIncome))}
          ${row('営業利益（前年）', musd(a1?.operatingIncome), tone(a1?.operatingIncome))}
          ${row('営業利益率 TTM', pct(l.operatingMarginTtmPct))}
          ${row('PER（TTM）', fin(ev.multiples?.perTtm) ? num(ev.multiples.perTtm, 1) + '倍' : esc(ev.multiples?.perNote || '—'))}
          ${row('PSR（TTM）', fin(ev.multiples?.psrTtm) ? num(ev.multiples.psrTtm, 1) + '倍' : '—')}
        </section>
        <section class="pm-card pm-an-panel"><h3>🏦 BS 貸借対照表</h3>
          ${row('現金及び同等物' + asOf(bal.cash), musd(bal.cash?.val), 'pm-an-good')}
          ${row('長期借入金' + asOf(debtStale ? null : debt), debtStale ? '—（直近の開示なし）' : musd(debt?.val), 'pm-an-warnc')}
          ${row('自己資本' + asOf(bal.equity), musd(bal.equity?.val), tone(bal.equity?.val))}
          <p class="pm-small ${fin(bal.equity?.val) && bal.equity.val > 0 ? 'pm-an-good' : 'pm-an-bad'}">${fin(bal.equity?.val) ? (bal.equity.val > 0 ? '✓ 資本の部プラス — 健全' : '⚠ 債務超過') : 'データ不足'}</p>
        </section>
        <section class="pm-card pm-an-panel"><h3>💵 CF キャッシュフロー</h3>
          ${row('営業CF（直近四半期）', musd(l.operatingCashFlow), tone(l.operatingCashFlow))}
          ${row('FCF（TTM）', musd(l.fcfTtm), tone(l.fcfTtm))}
          ${row('FCFマージン（TTM）', pct(l.fcfMarginTtmPct))}
          ${row('自社株買い（直近年）' + asOf(bb), musd(bb?.val), 'pm-an-good')}
          ${row('株式発行（直近年）' + asOf(iss), musd(iss?.val), 'pm-an-bad')}
        </section>
      </div>`;
  }

  function render(d) {
    current = d;
    if (chartHandle) { try { chartHandle.remove(); } catch { /* ignore */ } chartHandle = null; }
    const ev = d.evaluation || {}, q = d.quarters?.at(-1);
    const judg = ev.judgment?.judgment;
    $('pm-analysis-result').innerHTML = `
      <p class="pm-callout" data-warn="true" id="pm-analysis-verification">
        <strong>検証中の参考値です。</strong>売買判断の正式な根拠には使わないでください（status: ${esc(d.status)}）。保有株数・現金・リバランス計算には一切反映されません。
      </p>
      <section class="pm-card pm-an-header">
        <div>
          <div class="pm-an-title"><h3>${esc(d.ticker)}</h3>
            ${q?.filed ? `<span class="pm-an-pill">${esc(q.filed)} 最新${esc(q.form || '')}</span>` : ''}
            ${d.signals?.phase ? `<span class="pm-an-pill phase">🏆 ${esc(PHASE[d.signals.phase] || d.signals.phase)}</span>` : ''}</div>
          <div class="pm-an-muted">${esc(d.name)}</div>
        </div>
        <div class="pm-an-price">
          <strong>${fin(d.quote?.price) ? '$' + num(d.quote.price, 2) : '—'}</strong>
          <small>現在株価 ｜ 時価総額 ${musd(ev.multiples?.marketCapUsd)}</small>
          ${judg ? `<b class="${/買い/.test(judg) ? 'pm-an-good' : /売り|弱気/.test(judg) ? 'pm-an-bad' : ''}">✓ ${esc(judg)}</b>` : ''}
        </div>
      </section>
      <div class="pm-an-tabs" role="tablist" aria-label="分析タブ">
        ${['サマリー', 'チャート', '投資判断', '財務諸表'].map((t, i) =>
          `<button type="button" role="tab" class="pm-an-tab" id="pm-an-tab-${i}" aria-controls="pm-an-pane-${i}" aria-selected="${i === 0}" data-pane="${i}">${['📊', '📈', '💰', '📑'][i]} ${t}</button>`).join('')}
      </div>
      <div role="tabpanel" id="pm-an-pane-0" aria-labelledby="pm-an-tab-0">${summaryTab(d)}</div>
      <div role="tabpanel" id="pm-an-pane-1" aria-labelledby="pm-an-tab-1" hidden>${chartTab(d)}</div>
      <div role="tabpanel" id="pm-an-pane-2" aria-labelledby="pm-an-tab-2" hidden>${judgmentTab(d)}</div>
      <div role="tabpanel" id="pm-an-pane-3" aria-labelledby="pm-an-tab-3" hidden>${statementsTab(d)}</div>
      <details class="pm-card"><summary>指標の定義</summary>
        <ul class="pm-small">${Object.entries(d.definitions || {}).map(([k, v]) => `<li><strong>${esc(k)}</strong>：${esc(v)}</li>`).join('')}</ul>
      </details>
      <p class="pm-muted pm-small" id="pm-analysis-source">
        出典：<a href="${esc(d.source && d.source.url)}" rel="noopener noreferrer" target="_blank">${esc(d.source && d.source.provider)}</a>
        ／取得 ${when(d.source && d.source.retrievedAt)}／通貨 ${esc(d.source && d.source.currency)}／${esc(d.source && d.source.note)}
        ${d.quote ? `／株価：${esc(d.quote.source)}` : ''}
      </p>`;
  }

  function selectTab(i) {
    document.querySelectorAll('#pm-analysis-result .pm-an-tab').forEach(b => b.setAttribute('aria-selected', String(+b.dataset.pane === i)));
    document.querySelectorAll('#pm-analysis-result [role=tabpanel]').forEach(p => { p.hidden = p.id !== 'pm-an-pane-' + i; });
    if (i === 1) drawChart();
  }

  // ── candlestick chart (TradingView Lightweight Charts, loaded on demand) ──
  const LW_URL = 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js';
  let lwPromise = null;
  function loadLightweight() {
    if (root.LightweightCharts) return Promise.resolve(root.LightweightCharts);
    if (!lwPromise) {
      lwPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = LW_URL; s.async = true;
        s.onload = () => (root.LightweightCharts ? resolve(root.LightweightCharts) : reject(new Error('lw missing')));
        s.onerror = () => { lwPromise = null; reject(new Error('lw load failed')); };
        document.head.appendChild(s);
      });
    }
    return lwPromise;
  }

  /** Chart markers (legacy semantics) placed on the first weekly bar on/after each quarter end. */
  function markersFor(d, points) {
    const sig = new Map((d.signals?.byQuarter || []).map(s => [s.end, s]));
    const firstT = points[0]?.t, lastT = points.at(-1)?.t;
    const snap = end => points.find(p => p.t >= end)?.t ?? null;
    const out = [];
    const qs = (d.quarters || []).slice(-16);
    qs.forEach((q, i) => {
      if (!q.end || !firstT || q.end < firstT || q.end > lastT) return;
      const t = snap(q.end); if (!t) return;
      const s = sig.get(q.end) || {}, prev = qs[i - 1];
      if ((s.score ?? 0) >= 75) out.push({ time: t, position: 'aboveBar', color: '#ef4444', shape: 'arrowUp', text: '🚨 ' + q.end.slice(0, 7) });
      else if ((s.score ?? 0) >= 50) out.push({ time: t, position: 'aboveBar', color: '#f97316', shape: 'arrowUp', text: '⚡ ' + q.end.slice(0, 7) });
      if (prev && fin(prev.operatingIncome) && fin(q.operatingIncome) && prev.operatingIncome < 0 && q.operatingIncome >= 0)
        out.push({ time: t, position: 'aboveBar', color: '#fbbf24', shape: 'circle', text: '🌱 黒字転換' });
      if (fin(s.yoyAccel) && s.yoyAccel >= 10) out.push({ time: t, position: 'belowBar', color: '#6366f1', shape: 'arrowUp', text: '📈 売上加速' });
    });
    const r = qs.slice(-3).map(q => q.revenueYoYPct);
    if (r.length === 3 && r.every(fin) && r[2] < r[1] && r[1] < r[0]) {
      const t = snap(qs.at(-2).end);
      if (t) out.push({ time: t, position: 'aboveBar', color: '#f97316', shape: 'arrowDown', text: '⚠️ 成長減速' });
    }
    return out.sort((a, b) => a.time.localeCompare(b.time));
  }

  async function drawChart() {
    const box = $('pm-analysis-chart'), note = $('pm-analysis-chart-note');
    if (!box || !current || box.dataset.ticker === current.ticker) return;
    box.dataset.ticker = current.ticker;
    box.textContent = '株価データを取得しています…';
    const out = await root.PMApi.call('/api/chart?ticker=' + encodeURIComponent(current.ticker) + '&range=5y', { kind: 'チャート' });
    if (out.error) { box.textContent = out.error; delete box.dataset.ticker; return; }
    const pts = (out.data.points || []).filter(p => fin(p.open) && fin(p.high) && fin(p.low) && fin(p.close));
    note.textContent = `出典：${out.data.source?.provider || ''}（${out.data.source?.note || ''}）／週足${pts.length}本／取得 ${when(out.data.source?.retrievedAt)}`;
    let LW;
    try { LW = await loadLightweight(); }
    catch {
      box.innerHTML = root.PMPriceChart ? root.PMPriceChart.svg(out.data.points, { width: Math.max(300, box.clientWidth - 8), height: 300 }) : '';
      note.textContent += '（チャートライブラリを読み込めないため簡易表示）';
      return;
    }
    box.textContent = '';
    const css = getComputedStyle(document.body);
    const light = document.body.classList.contains('light');
    chartHandle = LW.createChart(box, {
      width: box.clientWidth, height: box.clientHeight,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: light ? '#475569' : 'rgba(255,255,255,0.55)', fontSize: 11 },
      grid: { vertLines: { color: light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)' }, horzLines: { color: light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)' } },
      crosshair: { mode: LW.CrosshairMode.Normal },
      rightPriceScale: { borderColor: css.getPropertyValue('--border').trim() || '#2f3d68' },
      timeScale: { borderColor: css.getPropertyValue('--border').trim() || '#2f3d68', fixLeftEdge: true, fixRightEdge: true }
    });
    const candles = chartHandle.addCandlestickSeries({ upColor: '#10b981', downColor: '#ef4444', borderUpColor: '#10b981', borderDownColor: '#ef4444', wickUpColor: '#34d399', wickDownColor: '#f87171' });
    candles.setData(pts.map(p => ({ time: p.t, open: p.open, high: p.high, low: p.low, close: p.close })));
    const vol = chartHandle.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    chartHandle.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(pts.filter(p => fin(p.volume)).map(p => ({ time: p.t, value: p.volume, color: p.close >= p.open ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)' })));
    const ma = [];
    for (let i = 8; i < pts.length; i++) ma.push({ time: pts[i].t, value: pts.slice(i - 8, i + 1).reduce((s, p) => s + p.close, 0) / 9 });
    chartHandle.addLineSeries({ color: '#818cf8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(ma);
    candles.setMarkers(markersFor(current, pts));
    chartHandle.timeScale().fitContent();
    const handle = chartHandle;
    new ResizeObserver(e => { const r = e[0].contentRect; if (handle === chartHandle) handle.applyOptions({ width: r.width, height: r.height }); }).observe(box);
  }

  async function analyze(event) {
    event?.preventDefault();
    const input = $('pm-analysis-ticker');
    const ticker = String(input.value || '').trim().toUpperCase();
    if (!TICKER.test(ticker)) { status('銘柄コードの形式を確認してください（例：NVDA）。', 'error'); return; }
    input.value = ticker;
    const button = $('pm-analysis-run');
    button.disabled = true;
    status(ticker + ' のSEC財務データを取得しています…');
    $('pm-analysis-result').setAttribute('aria-busy', 'true');
    try {
      const out = await load(ticker);
      if (out.error) { status(out.error, 'error'); $('pm-analysis-result').innerHTML = ''; return; }
      render(out.data);
      status(out.cached ? '10分以内に取得したデータを表示しています。' : '');
    } finally {
      button.disabled = false;
      $('pm-analysis-result').removeAttribute('aria-busy');
    }
  }

  /** Open the analysis view for a ticker (used by the screener). */
  function analyzeTicker(ticker) {
    $('pm-analysis-ticker').value = ticker;
    if (root.location.hash !== '#analysis') root.location.hash = '#analysis';
    analyze();
  }

  function refreshTickers() {
    const list = $('pm-analysis-tickers');
    if (!list) return;
    const state = root.PMApp && root.PMApp.state ? root.PMApp.state() : null;
    list.innerHTML = knownTickers(state).map(t => `<option value="${esc(t)}"></option>`).join('');
  }

  function init() {
    const form = $('pm-analysis-form');
    if (!form) return;
    form.addEventListener('submit', analyze);
    $('pm-analysis-ticker').addEventListener('focus', refreshTickers);
    $('pm-analysis-result').addEventListener('click', e => {
      const tab = e.target.closest('.pm-an-tab');
      if (tab) selectTab(+tab.dataset.pane);
    });
    refreshTickers();
    root.addEventListener('hashchange', () => { if (root.location.hash === '#analysis') refreshTickers(); });
  }

  root.PMAnalysis = { init, knownTickers, load, render, analyzeTicker, selectTab, markersFor, clearCacheForTest: () => cache.clear() };
  if (typeof module === 'object' && module.exports) module.exports = root.PMAnalysis;
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(globalThis);
