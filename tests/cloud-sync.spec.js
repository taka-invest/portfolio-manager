'use strict';
// Cloud sync end-to-end with an in-memory stand-in for the Firebase SDK (no network,
// no real project): another PC's save is never silently overwritten, and cloud data
// from a newer app version is refused instead of being trimmed.
const { test, expect } = require('@playwright/test');
const D = require('../app/data.js');

const UID = 'test-uid-0001';
const lot = (id, ticker, shares) => ({ id, ticker, kind: 'stock', broker: '架空証券', account: '', accountType: 'specific',
  shares, currency: 'JPY', unitCost: 1000, costJpy: shares * 1000, referenceJpy: null, layer: 1, note: '' });
const LOCAL = D.validate({ ...D.blank(), positions: [lot('a', 'NVDA', 10)], cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true } });

// Minimal modular-SDK surface used by app/firebase-cloud.mjs, backed by window.__fake.
const SDK = {
  'firebase-app.js': `export const initializeApp = c => ({ c }); export const getApp = () => ({});`,
  'firebase-auth.js': `
    const user = { uid: ${JSON.stringify(UID)}, email: '', getIdToken: async () => 'header.payload.sig' };
    export const getAuth = () => ({ currentUser: user, authStateReady: async () => {} });
    export const connectAuthEmulator = () => {};
    export class GoogleAuthProvider {}
    export const signInWithPopup = async () => {};
    export const signOut = async () => {};
    export const onAuthStateChanged = (auth, cb) => { setTimeout(() => cb(user), 0); return () => {}; };`,
  'firebase-firestore.js': `
    const F = () => window.__fake;
    const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
    const snap = path => { const v = F().docs[path]; return { exists: () => v !== undefined,
      data: () => v === undefined ? undefined : { ...clone(v), updatedAt: { toDate: () => new Date(v.updatedAt || 0) } } }; };
    const stamp = data => JSON.parse(JSON.stringify(data, (k, v) => v === '__ts__' ? Date.now() : v));
    export const getFirestore = () => ({});
    export const connectFirestoreEmulator = () => {};
    export const doc = (db, ...p) => ({ path: p.join('/') });
    export const collection = (db, ...p) => ({ path: p.join('/') });
    export const where = (field, op, value) => ({ field, value });
    export const query = (c, w) => ({ path: c.path, w });
    export const serverTimestamp = () => '__ts__';
    export const getDocFromServer = async r => snap(r.path);
    export const getDocsFromServer = async q => ({ docs: Object.keys(F().docs)
      .filter(p => p.startsWith(q.path + '/') && !p.slice(q.path.length + 1).includes('/') && F().docs[p][q.w.field] === q.w.value)
      .map(p => snap(p)) });
    export const runTransaction = async (db, fn) => {
      const writes = [];
      await fn({ get: async r => snap(r.path), set: (r, d) => writes.push([r.path, d]) });
      for (const [p, d] of writes) F().docs[p] = stamp(d);
      F().writes += writes.length;
    };`
};

const WS = `users/${UID}/workspaces/portfolio`;

async function open(page, { cloud = LOCAL, revision = 1 } = {}) {
  await page.addInitScript(({ key, local, ws, cloud, revision, uid }) => {
    localStorage.setItem(key, JSON.stringify(local));
    window.__fake = { writes: 0, docs: { ['allowlist/' + uid]: { enabled: true },
      ...(cloud ? { [ws]: { payload: cloud, revision, updatedAt: Date.now() } } : {}) } };
  }, { key: D.KEY, local: LOCAL, ws: WS, cloud, revision, uid: UID });
  await page.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1') return route.continue();
    const file = u.hostname === 'www.gstatic.com' && u.pathname.split('/').pop();
    if (file && SDK[file]) return route.fulfill({ contentType: 'text/javascript', body: SDK[file] });
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/portfolio_manager.html');
  await expect(page.locator('#pm-cloud-status')).toContainText('リビジョン ' + revision);
}
const statusText = page => page.locator('#pm-cloud-status');
const click = (page, id) => page.evaluate(id => document.getElementById(id).click(), id);
// Another PC saves: bump the revision and keep the pre-overwrite backup, like the real client.
const otherPcSaves = (page, change) => page.evaluate(({ ws, uid, change }) => {
  const cur = window.__fake.docs[ws];
  window.__fake.docs[`users/${uid}/backups/rev-${cur.revision}-1`] = { payload: cur.payload, revision: cur.revision, reason: 'before-overwrite', createdAt: 1 };
  window.__fake.docs[ws] = { payload: { ...cur.payload, ...change }, revision: cur.revision + 1, updatedAt: Date.now() };
}, { ws: WS, uid: UID, change });
const cloudDoc = page => page.evaluate(ws => window.__fake.docs[ws], WS);
const editLocal = (page, change) => page.evaluate(change => PMApp.commit({ ...PMApp.state(), ...change }), change);
const recheck = page => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('an unchanged PC cannot revert another PC\'s newer save', async ({ page }) => {
  await open(page);
  await expect(statusText(page)).toContainText('同期記録がありません');
  await click(page, 'pm-cloud-upload');                                  // identical → records the base revision
  await expect(statusText(page)).toContainText('一致しています（リビジョン 1）');

  await otherPcSaves(page, { cash: { ...LOCAL.cash, jpy: 250000 } });
  await recheck(page);
  await expect(statusText(page)).toContainText('別端末でクラウドが更新されています（リビジョン 1 → 2）');
  await expect(statusText(page)).toHaveAttribute('data-warn', 'true');
  page.on('dialog', d => { throw new Error('no dialog expected: ' + d.message()); });
  await click(page, 'pm-cloud-upload');
  await expect(statusText(page)).toContainText('上書きは中止しました');
  const doc = await cloudDoc(page);
  expect(doc.revision).toBe(2);
  expect(doc.payload.cash.jpy).toBe(250000);
});

test('both changed: the other PC\'s changes are shown and overwrite needs an explicit override', async ({ page }) => {
  await open(page);
  await click(page, 'pm-cloud-upload');
  await expect(statusText(page)).toContainText('一致しています');
  await otherPcSaves(page, { cash: { ...LOCAL.cash, jpy: 250000 } });
  await editLocal(page, { cash: { ...LOCAL.cash, usd: 500 } });
  await recheck(page);
  await expect(statusText(page)).toContainText('両方が変更されています');

  const dialogs = [];
  page.once('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await click(page, 'pm-cloud-upload');
  await expect(statusText(page)).toContainText('保存を中止しました');
  expect(dialogs[0]).toContain('別端末で保存された変更');
  await expect(page.locator('#pm-cloud-diff-text')).toContainText('別端末での変更（リビジョン 1 → 2）');
  await expect(page.locator('#pm-cloud-diff-text')).toContainText('250000');
  expect((await cloudDoc(page)).revision).toBe(2);

  // Explicit override: both confirmations accepted → revision 3 holds this PC's data.
  page.on('dialog', d => d.accept());
  const download = page.waitForEvent('download');
  await click(page, 'pm-cloud-upload');
  await download;                                                     // local JSON backup first
  await expect(statusText(page)).toContainText('再読み込みで一致を確認しました');
  const doc = await cloudDoc(page);
  expect(doc.revision).toBe(3);
  expect(doc.payload.cash.usd).toBe(500);
  await expect(statusText(page)).toContainText('リビジョン 3');
});

test('importing over unsaved local edits asks first, then records the base revision', async ({ page }) => {
  await open(page);
  await click(page, 'pm-cloud-upload');
  await expect(statusText(page)).toContainText('一致しています');
  await otherPcSaves(page, { cash: { ...LOCAL.cash, jpy: 250000 } });
  await editLocal(page, { cash: { ...LOCAL.cash, usd: 500 } });
  const asked = [];
  page.on('dialog', d => { asked.push(d.message()); d.accept(); });
  const download = page.waitForEvent('download');
  await click(page, 'pm-cloud-download');
  await download;
  expect(asked[0]).toContain('クラウド未保存の変更があります');
  await expect(page.locator('#data-review')).toBeVisible();
  await page.locator('#data-accept').click();
  await expect(statusText(page)).toContainText('取り込みました');
  expect(await page.evaluate(() => PMApp.state().cash.jpy)).toBe(250000);
  await recheck(page);
  await expect(statusText(page)).toContainText('同期済み');
});

test('cloud data from a newer app version is refused, not trimmed', async ({ page }) => {
  await open(page, { cloud: { ...JSON.parse(JSON.stringify(LOCAL)), slippagePct: 0.3 }, revision: 4 });
  page.on('dialog', d => { throw new Error('no dialog expected: ' + d.message()); });
  await click(page, 'pm-cloud-download');
  await expect(statusText(page)).toContainText('このページの版では保持できない項目（slippagePct）');
  await expect(page.locator('#data-review')).toBeHidden();
  await click(page, 'pm-cloud-upload');
  await expect(statusText(page)).toContainText('再読み込みしてから保存してください');
  expect(await page.evaluate(() => window.__fake.writes)).toBe(0);
});

test('a JSON backup from a newer version warns before import', async ({ page }) => {
  await open(page);
  await page.evaluate(() => PMApp.previewImport({ ...PMApp.state(), futureField: 1 }, 'テスト'));
  await expect(page.locator('#data-diff')).toContainText('取り込むと失われます：futureField');
});
