'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const mod = p => import('file://' + join(__dirname, '..', 'functions/src/sec', p));
const fixture = t => JSON.parse(readFileSync(join(__dirname, 'fixtures/sec', t + '.json'), 'utf8'));

const q = (end, yoy, opm, extra = {}) => ({ end, revenue: 100, revenueYoYPct: yoy, operatingMarginPct: opm,
  grossMarginPct: 70, costRatioPct: 30, ruleOf40Legacy: yoy != null && opm != null ? yoy + opm : null, ...extra });

test('entry signals keep legacy points: red-to-black +40, RoF40 cross 40 +30, accel +15', async () => {
  const { entrySignals } = await mod('screen.js');
  const trend = entrySignals([q('2025-03-31', 20, -5), q('2025-06-30', 35, 8)]); // returned newest-first
  const latest = trend[0];
  assert.equal(latest.signals.redToBlack, true);
  assert.equal(latest.signals.rof40Cross40, true);   // 15 -> 43
  assert.equal(latest.signals.opMInflection, true);  // +13pt
  assert.equal(latest.signals.yoyAccelStrong, true); // +15pt
  assert.equal(latest.signalScore, Math.min(100, 40 + 30 + 20 + 15));
});

test('missing previous quarter never fires a transition signal (legacy treated null as a loss)', async () => {
  const { entrySignals } = await mod('screen.js');
  const trend = entrySignals([q('2025-03-31', null, null), q('2025-06-30', 50, 10)]);
  assert.equal(trend[0].signals.redToBlack, false);
  assert.equal(trend[0].signals.rof40Cross40, false);
  assert.equal(trend[0].signalScore, 0);
});

test('phase rules: financial list, loss-making phase1, profitable RoF40>=40 phase3', async () => {
  const { phaseOf } = await mod('screen.js');
  const t = (opm, rof) => Array.from({ length: 4 }, () => ({ opMargin: opm, rof40: rof, revYoY: 50, costRatio: 0.3 }));
  assert.equal(phaseOf('SOFI', t(10, 60)), 'financial');
  assert.equal(phaseOf('ZZZ', t(-10, 40)), 'phase1');
  assert.equal(phaseOf('ZZZ', t(20, 60)), 'phase3');
  assert.equal(phaseOf('ZZZ', t(20, 30)), 'phase2');
  assert.equal(phaseOf('ZZZ', t(null, null)), 'phase2'); // unknown margins are not counted as losses
});

test('real data: PLTR / APP / NVDA screen rows are complete and use date-matched YoY', async () => {
  const { screenFacts } = await mod('screen.js');
  const pltr = screenFacts('PLTR', fixture('PLTR'));
  assert.equal(pltr.latestQ, '2026-09-30');
  assert.equal(pltr.revenueYoYPct, 95.9);
  assert.equal(pltr.revenueM, 2313.4);
  assert.equal(pltr.phase, 'phase3');
  assert.equal(pltr.masyaScore, 85);
  assert.equal(pltr.exitLabel, '継続保有');
  for (const t of ['APP', 'NVDA']) {
    const row = screenFacts(t, fixture(t));
    assert.ok(!row.error, t);
    assert.ok(Number.isFinite(row.signalScore));
    assert.ok(['phase1', 'phase2', 'phase3', 'financial'].includes(row.phase));
  }
});

test('screenTickers isolates per-ticker failures and labels sources', async () => {
  const { screenTickers } = await mod('screen.js');
  const fetchJson = async url => {
    if (url.endsWith('company_tickers.json')) return { 0: { cik_str: 1321655, ticker: 'PLTR', title: 'Palantir' } };
    if (url.includes('companyfacts')) return fixture('PLTR');
    throw new Error('no price');
  };
  const out = await screenTickers(['PLTR', 'NOPE'], { fetchJson });
  assert.equal(out.rows[0].ticker, 'PLTR');
  assert.equal(out.rows[0].price, null);            // price failure does not fail the row
  assert.match(out.rows[1].error, /見つかりません/);
  assert.equal(out.status, 'verification-pending');
  assert.match(out.source.provider, /SEC EDGAR/);
});

test('chart: normalises Yahoo closes, drops nulls, prefers adjusted closes, validates range', async () => {
  const { normalizeChart, priceHistory } = await mod('chart.js');
  const json = { chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: 10, regularMarketTime: 1795000000 },
    timestamp: [1700000000, 1700604800, 1701209600],
    indicators: { quote: [{ close: [1, null, 3] }], adjclose: [{ adjclose: [0.9, null, 2.95] }] } }] } };
  const n = normalizeChart(json);
  assert.deepEqual(n.points.map(p => p.close), [0.9, 2.95]);
  assert.equal(n.adjusted, true);
  assert.equal(n.currency, 'USD');
  await assert.rejects(priceHistory('NVDA', '99y', async () => json), /invalid range/);
  process.env.MASSIVE_API_KEY = process.env.MASSIVE_API_KEY || 'test-key';
  await assert.rejects(priceHistory('NVDA', '1y', async () => ({ results: [] })), e => e.status === 404);
  const t0 = Date.now() - 10 * 86400000;
  const ok = await priceHistory('NVDA', '1y', async url => { assert.match(url, /^https:\/\/api\.massive\.com\/v2\/aggs\/ticker\/NVDA\/range\/1\/day\//);
    return { results: [{ t: t0, o: 1, h: 2, l: 1, c: 1.5, v: 10 }, { t: t0 + 86400000, o: 1.5, h: 2, l: 1, c: 1.8, v: 10 }] }; });
  assert.equal(ok.points.length, 2);
  assert.match(ok.source.provider, /Massive/);
  assert.match(ok.source.note, /分割調整後/);
});
