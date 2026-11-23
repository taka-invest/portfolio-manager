// Firebase Cloud Sync: opt-in, never changes local or cloud data without review.
// This module stays inactive until app/firebase-config.js holds the real web config.
//
// Upload (this PC → cloud) follows the migration safety procedure:
//   1. automatic full JSON backup download of local data
//   2. schema validation (PMData.validate) and storage-health check
//   3. fresh server read of the cloud document (no cache)
//   4. local ⇄ cloud diff shown to the user
//   5. the user explicitly chooses which side to adopt
//   6. server-side backup snapshot of the previous cloud revision (same transaction)
//   7. revision-checked transactional write (detects other devices)
//   8. re-read from the server and verify the stored data equals the local data
// Download (cloud → this PC) goes through the existing reviewed import dialog,
// which keeps the previous local data as a backup before replacing it.
'use strict';

const el = id => document.getElementById(id);
const status = (message, warning = false) => {
  const output = el('pm-cloud-status');
  if (output) { output.textContent = message; output.dataset.warn = String(warning); }
};
const MAX_BYTES = 750_000;
const CLOUD_SOURCE = 'Firebase同期';
const PROJECT_SDK = '12.11.0';
const base = 'https://www.gstatic.com/firebasejs/' + PROJECT_SDK + '/';
let auth, db, firebase, store, currentUser, remoteRevision = null, remoteData = null;
let busy = false, allowed = false;

const setEnabled = () => {
  const signedIn = Boolean(currentUser);
  el('pm-cloud-login').hidden = signedIn;
  el('pm-cloud-logout').hidden = !signedIn;
  el('pm-cloud-upload').disabled = !signedIn || !allowed || busy || remoteRevision === null;
  el('pm-cloud-download').disabled = !signedIn || !allowed || busy || !remoteData;
};
const ref = () => store.doc(db, 'users', currentUser.uid, 'workspaces', 'portfolio');
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
// Firestore rejects `undefined`; JSON round-trip drops it exactly like localStorage does.
const plain = value => JSON.parse(JSON.stringify(value));
// Key-order independent comparison (Firestore does not preserve map key order).
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}

function summary(data) {
  if (!data) return 'クラウド上には保存データがありません。';
  const when = data.updatedAt?.toDate?.();
  return 'クラウド更新: ' + (when ? when.toLocaleString('ja-JP') : '日時未確認')
    + '／リビジョン ' + data.revision
    + '／ロット ' + (data.payload?.positions?.length ?? '?') + '件';
}
function showDiff(text) {
  const box = el('pm-cloud-diff');
  if (!box) return;
  box.hidden = !text;
  el('pm-cloud-diff-text').textContent = text || '';
}
async function inspectRemote() {
  const snap = await store.getDocFromServer(ref()); // No cached values for financial data.
  remoteData = snap.exists() ? snap.data() : null;
  remoteRevision = remoteData?.revision ?? 0;
  status(summary(remoteData));
  setEnabled();
}
async function checkAllowlist(user) {
  try {
    const snap = await store.getDocFromServer(store.doc(db, 'allowlist', user.uid));
    return snap.exists() && snap.data().enabled === true;
  } catch { return false; }
}
function pretty(e) {
  const code = String(e?.code || '');
  if (code.includes('permission-denied')) return 'アクセス拒否です。このGoogleアカウントのUIDが許可リストに登録されているか確認してください。';
  if (code.includes('unavailable')) return 'クラウドに接続できません。再接続後に操作してください。';
  if (code.includes('popup-closed')) return 'ログイン画面が閉じられました。';
  if (code.includes('unauthorized-domain')) return 'このURLはFirebaseの承認済みドメインに登録されていません。';
  return e?.message || 'クラウド操作でエラーが発生しました。';
}
async function guarded(fn) {
  if (!currentUser || busy) return;
  busy = true; setEnabled();
  try { await fn(); }
  catch (e) { status(pretty(e), true); }
  finally { busy = false; setEnabled(); }
}

async function upload() {
  return guarded(async () => {
    const app = window.PMApp;
    if (app.storageError()) throw Error('このPCの保存データに問題があります（' + app.storageError() + '）。復元してから操作してください。');
    // (2) validate and normalise
    const local = plain(window.PMData.validate(app.state()));
    const size = bytes(local);
    if (size > MAX_BYTES) throw Error('現在のJSONが大きすぎます（' + size + ' bytes）。');
    // (3) fresh server read
    await inspectRemote();
    const old = remoteRevision;
    if (remoteData && canonical(window.PMData.validate(remoteData.payload)) === canonical(local)) {
      showDiff('');
      status('クラウドとこのPCの内容は一致しています（リビジョン ' + old + '）。保存の必要はありません。');
      return;
    }
    if (remoteData && !local.positions.length && remoteData.payload?.positions?.length)
      throw Error('クラウドには保有株がありますが、このPCの保有株は0件です。先に「クラウド → このPC」で確認してください。');
    // (4) diff
    const cloudPayload = remoteData ? window.PMData.validate(remoteData.payload) : window.PMData.blank();
    showDiff(app.diffText(cloudPayload, local, remoteData
      ? 'クラウド（リビジョン ' + old + '）→ このPC の差分。保存するとクラウドがこの内容になります。'
      : 'クラウドは空です。このPCの内容を初回保存します。'));
    // (5) explicit choice
    const message = (remoteData
      ? 'クラウドの既存データ（リビジョン ' + old + '、' + remoteData.payload.positions.length + 'ロット）を、このPCの内容（'
        + local.positions.length + 'ロット）で置き換えます。'
      : 'このPCの保有データ（' + local.positions.length + 'ロット）をクラウドに初めて保存します。')
      + '\n\n画面の「差分」を確認しましたか？\n実行前にこのPCのJSONバックアップを自動でダウンロードします。'
      + (remoteData ? '\n置き換え前のクラウドの内容もクラウド上にバックアップします。' : '') + '\n続行しますか？';
    if (!window.confirm(message)) { status('保存を中止しました。データは変更していません。'); return; }
    // (1) local full backup
    app.backupJson();
    // (6)(7) backup + revision-checked write in one transaction
    await store.runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref());
      const actual = snapshot.exists() ? snapshot.data().revision : 0;
      if (!Number.isSafeInteger(actual) || actual !== old) {
        throw Error('クラウドが別端末で更新されています（リビジョン ' + old + ' → ' + actual + '）。上書きせず中止しました。再確認してください。');
      }
      if (snapshot.exists()) {
        transaction.set(store.doc(db, 'users', currentUser.uid, 'backups', 'rev-' + actual + '-' + Date.now()), {
          payload: snapshot.data().payload, revision: actual,
          createdAt: store.serverTimestamp(), reason: 'before-overwrite'
        });
      }
      transaction.set(ref(), { payload: local, revision: old + 1, updatedAt: store.serverTimestamp() });
    });
    // (8) verify
    await inspectRemote();
    const same = remoteData && canonical(window.PMData.validate(remoteData.payload)) === canonical(local);
    if (!same) throw Error('保存後の照合でクラウドとこのPCの内容が一致しません。JSONバックアップを保管し、再確認してください。');
    showDiff('');
    status('クラウドへ保存し、再読み込みで一致を確認しました。' + summary(remoteData));
  });
}

async function download() {
  return guarded(async () => {
    await inspectRemote();
    if (!remoteData) throw Error('クラウドに復元可能なデータがありません。');
    const payload = window.PMData.validate(remoteData.payload);
    if (bytes(payload) > MAX_BYTES) throw Error('クラウドデータが想定サイズを超えています。');
    // Existing diff-review dialog confirms and backs up prior local data.
    window.PMApp.previewImport(payload, CLOUD_SOURCE + '（クラウド リビジョン ' + remoteData.revision + ' の差分を確認）');
    status('差分確認ダイアログを開きました。承認した場合のみこのPCのデータが変更されます。');
  });
}

async function login() {
  if (!auth || busy) return;
  try { await firebase.signInWithPopup(auth, new firebase.GoogleAuthProvider()); }
  catch (e) { status(pretty(e), true); }
}
async function logout() {
  if (!auth || busy) return;
  try { await firebase.signOut(auth); showDiff(''); }
  catch (e) { status(pretty(e), true); }
}

export async function init() {
  const cfg = window.PMFirebaseWebConfig;
  const valid = cfg && ['apiKey', 'authDomain', 'projectId', 'appId']
    .every(key => typeof cfg[key] === 'string' && cfg[key].length > 3);
  const buttons = ['pm-cloud-login', 'pm-cloud-logout', 'pm-cloud-upload', 'pm-cloud-download'];
  if (!buttons.every(id => el(id))) return;
  if (!valid) {
    status('Firebase未接続です。プロジェクト設定が完了するまで、従来のJSON保存を利用できます。');
    buttons.forEach(id => { el(id).disabled = true; });
    return;
  }
  try {
    const [a, f, d] = await Promise.all([
      import(base + 'firebase-app.js'),
      import(base + 'firebase-auth.js'),
      import(base + 'firebase-firestore.js')
    ]);
    firebase = f;
    store = d;
    auth = f.getAuth(a.initializeApp(cfg));
    db = d.getFirestore(a.getApp());
    window.PMCloud = { idToken: () => auth.currentUser?.getIdToken() ?? Promise.resolve(null) };
    el('pm-cloud-login').addEventListener('click', login);
    el('pm-cloud-logout').addEventListener('click', logout);
    el('pm-cloud-upload').addEventListener('click', upload);
    el('pm-cloud-download').addEventListener('click', download);
    window.addEventListener('pm:import-accepted', e => {
      if (!String(e.detail?.source || '').startsWith(CLOUD_SOURCE)) return;
      status('クラウド（リビジョン ' + (remoteData?.revision ?? '?') + '）の内容をこのPCに取り込みました。保有ロットと現金を確認してください。');
    });
    f.onAuthStateChanged(auth, async user => {
      currentUser = user;
      remoteRevision = null; remoteData = null; allowed = false;
      setEnabled();
      if (!user) {
        el('pm-cloud-user').textContent = '';
        status('未ログイン。Googleログインするとクラウド保存を利用できます。');
        return;
      }
      el('pm-cloud-user').textContent = (user.email || 'Googleログイン中') + '／UID: ' + user.uid;
      status('アクセス権を確認しています…');
      allowed = await checkAllowlist(user);
      if (!allowed) {
        setEnabled();
        status('このアカウントはまだ許可されていません。上記UIDを管理者がFirestoreの allowlist に登録すると利用できます（docs/firebase-migration.md 参照）。', true);
        return;
      }
      status('クラウドに接続しています…');
      await guarded(inspectRemote);
    }, err => status(pretty(err), true));
  } catch {
    status('Firebase SDKを読み込めません。オフラインの場合はJSON保存を利用してください。', true);
  }
}
init();
