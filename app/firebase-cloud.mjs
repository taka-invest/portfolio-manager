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
// Lost-update guard (app/cloud-sync.js): this PC records the cloud revision its data
// is based on. Uploading stale data over another PC's newer save is refused, and when
// both sides changed, the other PC's changes are shown and need an explicit override.
// Cloud data written by a newer app version (fields this page cannot keep) is refused.
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
let busy = false, allowed = false, pendingImport = null;
const sync = () => window.PMCloudSync;

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
export function canonical(value) { return window.PMCloudSync.canonical(value); }

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
function relationNow() {
  const base = sync().readBase(localStorage, currentUser.uid);
  let local = null;
  try { local = plain(window.PMData.validate(window.PMApp.state())); } catch { /* storage problem: shown elsewhere */ }
  return { base, local, rel: sync().relation({ base, remoteRevision, local }) };
}
function showStatus() {
  if (!currentUser || remoteRevision === null) return;
  const { base, rel } = relationNow();
  const line = sync().describe(rel, base, remoteRevision);
  status(summary(remoteData) + (line.text ? '\n' + line.text : ''), line.warn);
}
async function inspectRemote() {
  const snap = await store.getDocFromServer(ref()); // No cached values for financial data.
  remoteData = snap.exists() ? snap.data() : null;
  remoteRevision = remoteData?.revision ?? 0;
  showStatus();
  setEnabled();
}
// Fields the cloud copy holds that this page version would drop on re-save.
function refuseNewerData(action) {
  const lost = remoteData ? window.PMData.droppedKeys(remoteData.payload) : [];
  if (!lost.length) return;
  throw Error('クラウドのデータには、このページの版では保持できない項目（' + lost.slice(0, 5).join('、')
    + (lost.length > 5 ? ' ほか' + (lost.length - 5) + '件' : '') + '）があります。新しい版で保存されたデータです。'
    + 'ページを再読み込みしてから' + action + 'してください。データは変更していません。');
}
// The cloud content this PC's data was based on (kept in the pre-overwrite backups).
async function basePayload(revision) {
  try {
    const q = store.query(store.collection(db, 'users', currentUser.uid, 'backups'), store.where('revision', '==', revision));
    const snap = await store.getDocsFromServer(q);
    const doc = snap.docs.find(d => d.data().reason === 'before-overwrite') || snap.docs[0];
    return doc ? window.PMData.validate(doc.data().payload) : null;
  } catch { return null; }
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
    refuseNewerData('保存');
    if (remoteData && canonical(window.PMData.validate(remoteData.payload)) === canonical(local)) {
      sync().writeBase(localStorage, currentUser.uid, old, local);
      showDiff('');
      status('クラウドとこのPCの内容は一致しています（リビジョン ' + old + '）。保存の必要はありません。');
      return;
    }
    const { base, rel } = relationNow();
    if (rel.kind === 'behind') {
      throw Error('クラウドは別端末で更新されています（リビジョン ' + base.revision + ' → ' + old + '）。'
        + 'このPCには未保存の変更がないため、保存すると別端末の変更を古い内容に戻してしまいます。'
        + '「クラウド → このPC」で取り込んでください。上書きは中止しました。');
    }
    if (remoteData && !local.positions.length && remoteData.payload?.positions?.length)
      throw Error('クラウドには保有株がありますが、このPCの保有株は0件です。先に「クラウド → このPC」で確認してください。');
    // (4) diff
    const cloudPayload = remoteData ? window.PMData.validate(remoteData.payload) : window.PMData.blank();
    let lost = '';
    if (rel.kind === 'conflict') {
      const before = await basePayload(base.revision);
      lost = before
        ? app.diffText(before, cloudPayload, '【別端末での変更（リビジョン ' + base.revision + ' → ' + old + '）】保存するとこれらの変更は失われます。')
        : '【別端末での変更】リビジョン ' + base.revision + ' の内容がクラウドのバックアップに見つからないため、変更点を特定できません。下の差分で「→」の左側（クラウド側）が失われます。';
      lost += '\n\n';
    } else if (rel.kind === 'unknown' && remoteData) {
      lost = '【注意】このPCがクラウドのどのリビジョンを元に編集したかの記録がありません。別端末で保存した変更がないか、下の差分の「→」左側（クラウド側）を確認してください。\n\n';
    } else if (rel.kind === 'mismatch') {
      lost = '【注意】クラウドのリビジョンがこのPCの記録より古くなっています。下の差分を確認してください。\n\n';
    }
    showDiff(lost + app.diffText(cloudPayload, local, remoteData
      ? 'クラウド（リビジョン ' + old + '）→ このPC の差分。保存するとクラウドがこの内容になります。'
      : 'クラウドは空です。このPCの内容を初回保存します。'));
    if (rel.kind === 'conflict' && !window.confirm('⚠ このPCとクラウドの両方が変更されています。\n\n'
      + 'このまま保存すると、別端末で保存された変更（画面の「別端末での変更」）が失われます。\n'
      + '通常は「キャンセル」し、このPCのJSONバックアップを取ってから「クラウド → このPC」で取り込み、このPCでの変更を入れ直してください。\n\n'
      + 'それでも別端末の変更を破棄して上書きしますか？')) {
      status('保存を中止しました。データは変更していません。別端末の変更を先に取り込んでください。', true);
      return;
    }
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
    sync().writeBase(localStorage, currentUser.uid, old + 1, local);
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
    refuseNewerData('取り込み');
    const payload = window.PMData.validate(remoteData.payload);
    if (bytes(payload) > MAX_BYTES) throw Error('クラウドデータが想定サイズを超えています。');
    const { rel } = relationNow();
    if (rel.kind === 'ahead' || rel.kind === 'conflict') {
      if (!window.confirm('このPCにはクラウド未保存の変更があります。取り込むと、このPCでの変更は失われます。\n'
        + '取り込み前に、このPCのJSONバックアップを自動でダウンロードします。続行しますか？')) {
        status('取り込みを中止しました。データは変更していません。');
        return;
      }
      window.PMApp.backupJson();
    }
    pendingImport = { uid: currentUser.uid, revision: remoteData.revision };
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
  // Local Emulator Suite (npm run dev:emulators serves Hosting on :5100): use the
  // demo project and emulated Auth/Firestore so no production data is touched.
  const emulator = ['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '5100';
  const cfg = emulator
    ? { apiKey: 'demo-key', authDomain: location.host, projectId: 'demo-finance-base', appId: 'demo-app' }
    : window.PMFirebaseWebConfig;
  const valid = cfg && ['apiKey', 'authDomain', 'projectId', 'appId']
    .every(key => typeof cfg[key] === 'string' && cfg[key].length > 3);
  const buttons = ['pm-cloud-login', 'pm-cloud-logout', 'pm-cloud-upload', 'pm-cloud-download'];
  // Pages without the sync panel (e.g. research/library.html) still get PMCloud for API calls.
  const headless = !buttons.every(id => el(id));
  const ready = value => { if (typeof window.__pmCloudResolve === 'function') window.__pmCloudResolve(value); };
  if (!valid) {
    if (!headless) {
      status('Firebase未接続です。プロジェクト設定が完了するまで、従来のJSON保存を利用できます。');
      buttons.forEach(id => { el(id).disabled = true; });
    }
    ready(null);
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
    if (emulator) {
      f.connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true });
      d.connectFirestoreEmulator(db, '127.0.0.1', 8180);
      if (!headless) status('ローカルEmulatorに接続しています（本番データには触れません）。');
    }
    // Wait until the persisted sign-in has been restored before deciding "not logged in".
    window.PMCloud = { idToken: async () => { await auth.authStateReady(); return auth.currentUser ? auth.currentUser.getIdToken() : null; } };
    ready(window.PMCloud);
    if (headless) return;
    el('pm-cloud-login').addEventListener('click', login);
    el('pm-cloud-logout').addEventListener('click', logout);
    el('pm-cloud-upload').addEventListener('click', upload);
    el('pm-cloud-download').addEventListener('click', download);
    window.addEventListener('pm:import-accepted', e => {
      if (!String(e.detail?.source || '').startsWith(CLOUD_SOURCE)) return;
      if (pendingImport && currentUser?.uid === pendingImport.uid) {
        sync().writeBase(localStorage, pendingImport.uid, pendingImport.revision, plain(window.PMData.validate(window.PMApp.state())));
      }
      pendingImport = null;
      status('クラウド（リビジョン ' + (remoteData?.revision ?? '?') + '）の内容をこのPCに取り込みました。保有ロットと現金を確認してください。');
    });
    // Keep the sync state honest: local edits and returning to the tab refresh it.
    window.addEventListener('pm:state-saved', () => { if (!busy) showStatus(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && currentUser && allowed && !busy) guarded(inspectRemote);
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
    ready(null);
    if (!headless) status('Firebase SDKを読み込めません。オフラインの場合はJSON保存を利用してください。', true);
  }
}
init();
