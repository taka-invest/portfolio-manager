'use strict';
// Chart markers for the 個別企業分析 chart tab (legacy semantics on corrected data).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const A = require(join(__dirname, '..', 'app/analysis.js'));

const weekly = (from, to) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += 7 * 864e5) out.push({ t: new Date(t).toISOString().slice(0, 10) }); return out; };

test('markers: high signal score, red-to-black, acceleration and 3-quarter deceleration; snapped to weekly bars', () => {
  const quarters = [
    { end: '2025-03-31', operatingIncome: -5, revenueYoYPct: 30 },
    { end: '2025-06-30', operatingIncome: 4, revenueYoYPct: 60 },
    { end: '2025-09-30', operatingIncome: 9, revenueYoYPct: 50 },
    { end: '2025-12-31', operatingIncome: 12, revenueYoYPct: 40 }
  ];
  const signals = { byQuarter: [
    { end: '2025-06-30', score: 85, yoyAccel: 30 },
    { end: '2025-09-30', score: 55, yoyAccel: -10 }
  ] };
  const pts = weekly('2025-01-06', '2026-01-05');
  const m = A.markersFor({ quarters, signals }, pts);
  const texts = m.map(x => x.text);
  assert.ok(texts.includes('🚨 2025-06'));
  assert.ok(texts.includes('⚡ 2025-09'));
  assert.ok(texts.includes('🌱 黒字転換'));
  assert.ok(texts.includes('📈 売上加速'));
  assert.ok(texts.includes('⚠️ 成長減速'));       // 60 > 50 > 40 over the last three quarters
  const set = new Set(pts.map(p => p.t));
  assert.ok(m.every(x => set.has(x.time)), 'every marker sits on an existing bar');
  assert.deepEqual(m.map(x => x.time), [...m.map(x => x.time)].sort());
});

test('markers outside the price range or with missing data are not invented', () => {
  const m = A.markersFor({ quarters: [{ end: '2019-03-31', operatingIncome: null, revenueYoYPct: null }], signals: { byQuarter: [{ end: '2019-03-31', score: 99 }] } },
    weekly('2024-01-01', '2024-12-30'));
  assert.deepEqual(m, []);
});
