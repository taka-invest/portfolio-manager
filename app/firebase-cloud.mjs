// Firebase Cloud Sync: opt-in, never changes local data without review.
// This module is intentionally inactive until app/firebase-config.js is configured.
'use strict';

const el = id => document.getElementById(id);
const status = (message, warning = false) => {
  const output = el('pm-cloud-status');
  if (output) { output.textContent = message; output.dataset.warn = String(warning); }
};
const MAX_BYTES = 750_000;
const PROJECT_SDK = '12.11.0';
const base = 'https://www.gstatic.com/firebasejs/' + PROJECT_SDK + '/';
let auth, db, firebase, store, currentUser, remoteRevision = null, remoteData = null;
let busy = false;
const setEnabled = () => {
  const signedIn = Boolean(currentUser);
  el('pm-cloud-login').hidden = signedIn;
  el('pm-cloud-logout').hidden = !signedIn;
  el('pm-cloud-upload').disabled = !signedIn || busy;
  el('pm-cloud-download').disabled = !signedIn || busy || !remoteData;
};
function ref() {
  return store.doc(db, 'users', currentUser.uid, 'workspaces', 'portfolio');
}
function bytes(value) { return new TextEncoder().encode(JSON.stringify(value)).length; }
function summary(data) {
  if (!data) return 'クラウド上には保存データがありません。';
  const when = data.updatedAt?.toDate?.();
  return 'クラウド更新: ' + (when ? when.toLocaleString('ja-JP') : '日時未確認')
    + '／リビジョン ' + data.revision
    + '／ロット ' + (data.payload?.positions?.length ?? '?') + '件';
}
async function inspectRemote() {
  const snap = await store.getDocFromServer(ref()); // No cached values for critical financial backups.
  remoteData = snap.exists() ? snap.data() : null;
  remoteRevision = remoteData?.revision ?? 0;
  status(summary(remoteData));
  setEnabled();
}
function pretty(e) {
  const code = String(e?.code || '');
  if (code.includes('permission-denied')) return 'アクセス拒否です。GoogleログインとFirestoreルールを確認してください。';
  if (code.includes('unavailable')) return 'クラウドに接続できません。再接続後に操作してください。';
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
    if (remoteRevision === null) throw Error('クラウドを先に確認してください。');
    const local = window.PMData.validate(window.PMApp.state());
    const size = bytes(local);
    if (size > MAX_BYTES) throw Error('現在のJSONが大きすぎます（' + size + ' bytes）。JSONバックアップを先に保存してください。');
    if (remoteData && !local.positions.length && remoteData.payload?.positions?.length)
      throw Error('クラウドには保有株がありますが、このPCの保有株は0件です。先にクラウドとの差分を確認してください。');
    const old = remoteRevision;
    const first = !remoteData;
    const message = first
      ? 'このPCの保有データをクラウドに初めて保存します。現金・株数・原価を確認しましたか？'
      : 'クラウドの既存データ（改訂 ' + old + '）を、このPCの内容で上書きします。\n'
        + 'クラウド: ' + remoteData.payload.positions.length + 'ロット ／ このPC: ' + local.positions.length + 'ロット\n'
        + '別PCで更新された可能性を確認し、必要なら先にJSONを書き出してください。続行しますか？';
    if (!window.confirm(message)) return;
    await store.runTransaction(db, async transaction => {
      const snapshot = await transaction.get(ref());
      const actual = snapshot.exists() ? snapshot.data().revision : 0;
      if (!Number.isSafeInteger(actual) || actual !== old) {
        throw Error('クラウドが別端末で更新されています。上書きせず、先にクラウドを再確認してください。');
      }
      transaction.set(ref(), {
        payload: local, revision: old + 1, updatedAt: store.serverTimestamp()
      });
    });
    await inspectRemote();
    status('クラウドへ保存しました。' + summary(remoteData));
  });
}
async function download() {
  return guarded(async () => {
    await inspectRemote();
    if (!remoteData) throw Error('クラウドに復元可能なデータがありません。');
    const payload = window.PMData.validate(remoteData.payload);
    if (bytes(payload) > MAX_BYTES) throw Error('クラウドデータが想定サイズを超えています。');
    // Existing diff-review confirms and backs up prior local data.
    window.PMApp.previewImport(payload, 'Firebase同期（クラウドの差分を確認）');
    status('差分確認ダイアログを開きました。内容を承認した場合のみローカルデータが変更されます。');
  });
}
async function login() {
  if (!auth || busy) return;
  try {
    await firebase.signInWithPopup(auth, new firebase.GoogleAuthProvider());
  } catch (e) { status(pretty(e), true); }
}
async function logout() {
  if (!auth || busy) return;
  try { await firebase.signOut(auth); }
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
    el('pm-cloud-login').addEventListener('click', login);
    el('pm-cloud-logout').addEventListener('click', logout);
    el('pm-cloud-upload').addEventListener('click', upload);
    el('pm-cloud-download').addEventListener('click', download);
    f.onAuthStateChanged(auth, async user => {
      currentUser = user;
      remoteRevision = null; remoteData = null;
      setEnabled();
      if (!user) { status('未ログイン。Googleログインするとクラウド保存を利用できます。'); return; }
      el('pm-cloud-user').textContent = user.email || 'Googleログイン中';
      status('クラウドに接続しています…');
      await guarded(inspectRemote);
    }, err => status(pretty(err), true));
  } catch (e) {
    status('Firebase SDKを読み込めません。オフラインの場合はJSON保存を利用してください。', true);
  }
}
init();
