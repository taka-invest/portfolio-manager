'use strict';
// Legacy engine fed with corrected data (functions/src/sec/legacy-adapter.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const load = () => import('file://' + join(__dirname, '..', 'functions/src/sec/legacy-adapter.js'));
const fixture = t => JSON.parse(readFileSync(join(__dirname, 'fixtures/sec', t + '.json'), 'utf8'));

test('legacy base trend: newest first, Q4 present, YoY/QoQ matched by date (PLTR)', async () => {
  const { legacyBase } = await load();
  const b = legacyBase(fixture('PLTR'));
  assert.equal(b.baseTrend[0].end, '2026-09-30');
  assert.equal(b.baseTrend[0].label, '2026 Q3');
  assert.equal(+b.baseTrend[0].revYoY.toFixed(1), 95.9);           // legacy Netlify showed 130.5
  const q4 = b.baseTrend.find(q => q.end === '2025-12-31');
  assert.ok(q4 && q4.derivedQ4);
  assert.equal(+q4.revM.toFixed(1), 1406.8);
  for (let i = 1; i < b.baseTrend.length; i++) {
    const gap = (Date.parse(b.baseTrend[i - 1].end) - Date.parse(b.baseTrend[i].end)) / 864e5;
    assert.ok(gap >= 80 && gap <= 100, 'continuous quarters');
  }
  assert.equal(+b.baseTrend[0].revQoQ.toFixed(1), +((b.baseTrend[0].revM / b.baseTrend[1].revM - 1) * 100).toFixed(1));
});

test('legacy annual arrays have one row per fiscal year (APP restatement no longer duplicated)', async () => {
  const { legacyBase } = await load();
  const b = legacyBase(fixture('APP'));
  const ends = b.revA.map(a => a.end);
  assert.equal(new Set(ends).size, ends.length);
  assert.equal(b.revA[0].end, '2025-12-31');
  assert.equal(Math.round(b.revA[1].val / 1e5) / 10, 3224.1);       // restated continuing ops, not 4,709.2
});

test('patched legacy engine output keeps the legacy shape the old UI expects', () => {
  const d = JSON.parse(readFileSync(join(__dirname, 'fixtures/legacy-analyze-PLTR.json'), 'utf8'));
  for (const k of ['ticker', 'companyName', 'cik', 'filings', 'market', 'trend', 'companyPhase', 'analyst', 'judgment', 'exitSignal', 'financials', 'calc']) {
    assert.ok(k in d, k);
  }
  assert.equal(d.trend[0].label, '2026 Q3');
  assert.equal(+d.trend[0].revYoY.toFixed(1), 95.9);
  assert.ok(d.trend.some(q => q.derivedQ4));
  for (const k of ['revM', 'opMargin', 'rof40', 'signalScore', 'signals', 'opLeverage', 'yoyAccel']) assert.ok(k in d.trend[0], k);
});

test('legacy engine source: only the data extraction was replaced; FIX markers are explicit', () => {
  const src = readFileSync(join(__dirname, '..', 'functions/src/legacy/analyze.js'), 'utf8');
  assert.match(src, /legacyBase\(data\)/);
  assert.doesNotMatch(src, /function bestConcept|function dedupeByEnd/);   // old extraction removed
  assert.match(src, /const trend = baseTrend\.map/);                         // legacy derivation kept
  assert.equal((src.match(/\/\/ FIX:/g) || []).length, 2);
});
