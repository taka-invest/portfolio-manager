'use strict';
// Forecast quarter (stage 1): the client port of the legacy signal rules matches the
// server exactly, forecasts are matched to the right quarter or not shown, and the
// Finnhub outlook is parsed without leaking the key.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../research/forecast.js');
const fixture = require('./fixtures/legacy-analyze-PLTR.json');

const stripDerived = q => { const { opLeverage, rof40, yoyAccel, opMDelta, signals, inflectionLevel, signalScore, ...b } = q; return b; };

test('client signal rules = server signal rules on every actual quarter (PLTR fixture)', () => {
  const ported = F.enrich(fixture.trend.map(stripDerived));
  fixture.trend.forEach((q, i) => {
    assert.equal(ported[i].signalScore, q.signalScore, q.label + ' score');
    assert.equal(ported[i].rof40, q.rof40, q.label + ' RoF40');
    assert.deepEqual(ported[i].signals, q.signals, q.label + ' signals');
  });
});

test('forecast row: next calendar quarter, YoY against the matching year-ago actual, scored like actuals', () => {
  const t = fixture.trend;                                     // newest 2026-09-30
  const row = F.forecastRow(t, { revM: 2600, opMargin: 48, kind: 'own' });
  assert.equal(row.end, '2026-12-31');
  assert.equal(row.label, '2026 Q4');
  const ago = t.find(q => q.end === '2025-12-31');
  assert.ok(Math.abs(row.revYoY - (2600 / ago.revM - 1) * 100) < 1e-9);
  assert.equal(row.rof40, +(row.revYoY + 48).toFixed(1));
  assert.equal(row.forecast, true);
  // Same score as running the legacy rules with this quarter prepended.
  assert.equal(row.signalScore, F.enrich([{ ...row }, ...t.map(stripDerived)])[0].signalScore);
  // No operating margin -> no RoF40 / margin-based signals are invented.
  const cons = F.forecastRow(t, { revM: 2600, kind: 'consensus' });
  assert.equal(cons.opMargin, null);
  assert.equal(cons.rof40, null);
  assert.equal(cons.signals.rof40Cross40, false);
});

test('consensus is placed only when the report date fits the quarter after the latest actual', () => {
  const t = fixture.trend;
  assert.equal(F.consensusQuarter(t, { date: '2027-02-02' }), '2026-12-31');
  assert.equal(F.consensusQuarter(t, { date: '2026-11-03' }), null);   // report for the latest actual itself
  assert.equal(F.consensusQuarter(t, { date: '2027-08-01' }), null);   // too far: a later quarter
  assert.equal(F.consensusQuarter(t, null), null);
});

test('own assumption: revenue from $M or from YoY; saved per ticker; invalid storage is ignored', () => {
  const t = fixture.trend;
  const ago = t.find(q => q.end === '2025-12-31');
  assert.equal(F.ownRevenue(t, { revM: 2500 }), 2500);
  assert.ok(Math.abs(F.ownRevenue(t, { revYoY: 50 }) - ago.revM * 1.5) < 1e-9);
  assert.equal(F.ownRevenue(t, {}), null);
  const m = new Map(); const s = { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: k => m.delete(k) };
  F.saveOwn(s, 'PLTR', { revM: 2500, opMargin: 47 });
  assert.equal(F.readOwn(s, 'PLTR').revM, 2500);
  assert.equal(F.readOwn(s, 'APP'), null);
  F.saveOwn(s, 'PLTR', null);
  assert.equal(F.readOwn(s, 'PLTR'), null);
  m.set('pm_forecast_X', '{bad');
  assert.equal(F.readOwn(s, 'X'), null);
});

test('Finnhub outlook: next report + EPS surprises; no key -> null; failures never echo the key or URL', async () => {
  const { earningsOutlook } = await import('../functions/src/sec/estimates.js');
  const now = () => Date.parse('2026-11-26T00:00:00Z');
  const urls = [];
  const ok = async url => {
    urls.push(url);
    if (url.includes('calendar/earnings')) return { earningsCalendar: [
      { symbol: 'PLTR', date: '2026-11-03', epsActual: 0.2 },                       // past: ignored
      { symbol: 'PLTR', date: '2027-02-02', hour: 'amc', year: 2026, quarter: 4, epsEstimate: 0.25, revenueEstimate: 2.45e9 }] };
    return [{ period: '2026-06-30', actual: 0.16, estimate: 0.14, surprisePercent: 14.3 },
      { period: '2026-09-30', actual: 0.21, estimate: 0.17, surprisePercent: 23.5 }];
  };
  const out = await earningsOutlook('PLTR', { fetchJson: ok, apiKey: 'SECRET-KEY', now });
  assert.deepEqual(out.next, { date: '2027-02-02', hour: 'amc', fiscalYear: 2026, fiscalQuarter: 4, epsEstimate: 0.25, revenueEstimateM: 2450 });
  assert.deepEqual(out.epsHistory.map(h => h.period), ['2026-09-30', '2026-06-30']);
  assert.ok(urls.every(u => u.startsWith('https://finnhub.io/api/v1/')));
  assert.equal(await earningsOutlook('PLTR', { fetchJson: ok, apiKey: '', now }), null);
  const failing = await earningsOutlook('PLTR', { fetchJson: async u => { throw new Error('boom ' + u); }, apiKey: 'SECRET-KEY', now });
  assert.equal(failing.next, null);
  assert.ok(failing.error);
  assert.doesNotMatch(JSON.stringify(failing), /SECRET-KEY|finnhub\.io/);
});
