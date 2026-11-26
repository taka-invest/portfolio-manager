'use strict';
// Cloud sync: lost-update detection (base revision per PC) and fields a newer
// app version wrote that this version would silently drop.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const C = require('../app/cloud-sync.js');

const memory = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)) }; };
const lot = (id, ticker, shares) => ({ id, ticker, kind: 'stock', broker: 'Monex', account: '', accountType: 'specific',
  shares, currency: 'JPY', unitCost: 1000, costJpy: shares * 1000, referenceJpy: null, layer: 1, note: '' });
const workspace = (over = {}) => D.validate({ ...D.blank(), positions: [lot('a', 'NVDA', 10)], ...over });

test('canonical/hash ignore key order and detect any value change', () => {
  assert.equal(C.canonical({ b: 1, a: [1, { d: 2, c: null }] }), C.canonical({ a: [1, { c: null, d: 2 }], b: 1 }));
  const w = workspace();
  assert.equal(C.hash(w), C.hash(JSON.parse(JSON.stringify(w))));
  assert.notEqual(C.hash(w), C.hash({ ...w, cash: { ...w.cash, jpy: 1 } }));
  assert.match(C.hash(w), /^[0-9a-f]{16}$/);
});

test('base revision is stored per Google account and survives bad storage', () => {
  const s = memory();
  assert.equal(C.readBase(s, 'u1'), null);
  C.writeBase(s, 'u1', 3, workspace(), Date.parse('2026-11-26T00:00:00Z'));
  C.writeBase(s, 'u2', 7, workspace());
  assert.equal(C.readBase(s, 'u1').revision, 3);
  assert.equal(C.readBase(s, 'u1').at, '2026-11-26T00:00:00.000Z');
  assert.equal(C.readBase(s, 'u2').revision, 7);
  s.setItem(C.KEY, '{broken');
  assert.equal(C.readBase(s, 'u1'), null);
});

test('relation: synced / ahead / behind / conflict / unknown / empty / mismatch', () => {
  const s = memory();
  const local = workspace();
  const edited = { ...local, cash: { ...local.cash, jpy: 5000 } };
  assert.equal(C.relation({ base: null, remoteRevision: 0, local }).kind, 'empty');
  assert.equal(C.relation({ base: null, remoteRevision: 2, local }).kind, 'unknown');
  const base = C.writeBase(s, 'u', 2, local);
  assert.deepEqual(C.relation({ base, remoteRevision: 2, local }), { kind: 'synced', localChanged: false });
  assert.deepEqual(C.relation({ base, remoteRevision: 2, local: edited }), { kind: 'ahead', localChanged: true });
  // Another PC saved revision 3: uploading this PC's unchanged copy would revert it.
  assert.deepEqual(C.relation({ base, remoteRevision: 3, local }), { kind: 'behind', localChanged: false });
  assert.deepEqual(C.relation({ base, remoteRevision: 3, local: edited }), { kind: 'conflict', localChanged: true });
  assert.equal(C.relation({ base, remoteRevision: 1, local }).kind, 'mismatch');
  assert.equal(C.relation({ base, remoteRevision: 0, local }).kind, 'mismatch');
  assert.ok(C.describe({ kind: 'behind' }, base, 3).warn);
  assert.match(C.describe({ kind: 'conflict' }, base, 3).text, /別端末の変更が失われます/);
  assert.equal(C.describe({ kind: 'synced' }, base, 2).warn, false);
});

test('droppedKeys reports fields a newer version wrote (top level and nested), not normalisation', () => {
  const w = workspace();
  assert.deepEqual(D.droppedKeys(w), []);
  // Normalised values (unknown → specific, default stage, missing nulls) are not data loss.
  const older = JSON.parse(JSON.stringify(w));
  older.positions[0].accountType = 'unknown';
  delete older.positions[0].referenceJpy;
  assert.deepEqual(D.droppedKeys(older), []);
  const newer = JSON.parse(JSON.stringify(w));
  newer.slippagePct = 0.3;
  newer.positions[0].fillPrice = 123;
  newer.cash.mmfJpy = 1000;
  newer.preferences.layout = 'compact';
  newer.empty = null;                                  // null carries no data
  assert.deepEqual(D.droppedKeys(newer).sort(), ['cash.mmfJpy', 'positions[0].fillPrice', 'preferences.layout', 'slippagePct']);
  assert.throws(() => D.droppedKeys({ version: 2 }));   // invalid data is still rejected, not "clean"
});
