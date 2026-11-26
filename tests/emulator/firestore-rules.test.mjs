// Firestore Security Rules tests. Run with the Firestore Emulator:
//   npm run test:rules
// Uses a demo-* project id, so no real Firebase project or login is touched.
import { test, before, after, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment, assertFails, assertSucceeds
} from '@firebase/rules-unit-testing';
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs,
  serverTimestamp, runTransaction, Timestamp, query, where
} from 'firebase/firestore';

const OWNER = 'owner-uid';
const OTHER = 'other-uid';
const STRANGER = 'stranger-uid';
let env;

const google = { firebase: { sign_in_provider: 'google.com' } };
const anon = { firebase: { sign_in_provider: 'anonymous' } };
const payload = (positions = [{ id: 'p1', ticker: 'NVDA', shares: 10 }]) => ({
  version: 3, positions, targets: [], cashTarget: 10,
  cash: { jpy: 100000, usd: 0, extraJpy: 0, extraIncluded: true }
});
const workspace = uid => env.authenticatedContext(uid, google).firestore();
const wsRef = (db, uid = OWNER) => doc(db, 'users', uid, 'workspaces', 'portfolio');

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-finance-base',
    firestore: {
      rules: readFileSync(resolve(import.meta.dirname, '../../firestore.rules'), 'utf8'),
      host: '127.0.0.1', port: 8180
    }
  });
});
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'allowlist', OWNER), { enabled: true, note: 'test owner' });
    await setDoc(doc(db, 'allowlist', OTHER), { enabled: true, note: 'second allowed account' });
    await setDoc(doc(db, 'allowlist', 'disabled-uid'), { enabled: false });
  });
});

test('unauthenticated users cannot read or write anything', async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(wsRef(db)));
  await assertFails(setDoc(wsRef(db), { payload: payload(), revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(getDoc(doc(db, 'allowlist', OWNER)));
  await assertFails(getDoc(doc(db, 'anything', 'x')));
});

test('allowed owner can create revision 1 and read it back', async () => {
  const db = workspace(OWNER);
  await assertSucceeds(setDoc(wsRef(db), { payload: payload(), revision: 1, updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(wsRef(db)));
});

test('Google user whose UID is not allowlisted is denied', async () => {
  const db = workspace(STRANGER);
  await assertFails(setDoc(wsRef(db, STRANGER), { payload: payload(), revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(getDoc(wsRef(db, STRANGER)));
  // ...but may see that their own allowlist entry does not exist.
  await assertSucceeds(getDoc(doc(db, 'allowlist', STRANGER)));
});

test('disabled allowlist entry is denied', async () => {
  const db = workspace('disabled-uid');
  await assertFails(getDoc(wsRef(db, 'disabled-uid')));
});

test('non-Google sign-in provider is denied even with an allowlisted UID', async () => {
  const db = env.authenticatedContext(OWNER, anon).firestore();
  await assertFails(getDoc(wsRef(db)));
});

test('an allowed user cannot read or write another allowed user data', async () => {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(wsRef(ctx.firestore()), { payload: payload(), revision: 1, updatedAt: Timestamp.now() });
  });
  const db = workspace(OTHER);
  await assertFails(getDoc(wsRef(db, OWNER)));
  await assertFails(updateDoc(wsRef(db, OWNER), { payload: payload([]), revision: 2, updatedAt: serverTimestamp() }));
  await assertFails(getDocs(collection(db, 'users', OWNER, 'backups')));
});

test('clients can never write or list the allowlist', async () => {
  const db = workspace(STRANGER);
  await assertFails(setDoc(doc(db, 'allowlist', STRANGER), { enabled: true }));
  await assertFails(getDocs(collection(db, 'allowlist')));
  const owner = workspace(OWNER);
  await assertFails(updateDoc(doc(owner, 'allowlist', OWNER), { enabled: true }));
});

test('revision must increase by exactly one (no stale overwrite)', async () => {
  const db = workspace(OWNER);
  await assertSucceeds(setDoc(wsRef(db), { payload: payload(), revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(wsRef(db), { payload: payload(), revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(wsRef(db), { payload: payload(), revision: 3, updatedAt: serverTimestamp() }));
  await assertSucceeds(setDoc(wsRef(db), { payload: payload(), revision: 2, updatedAt: serverTimestamp() }));
});

test('first write must be revision 1 and use the server timestamp', async () => {
  const db = workspace(OWNER);
  await assertFails(setDoc(wsRef(db), { payload: payload(), revision: 5, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(wsRef(db), { payload: payload(), revision: 1, updatedAt: Timestamp.fromMillis(0) }));
});

test('schema guard rejects wrong version, extra fields and other doc ids', async () => {
  const db = workspace(OWNER);
  await assertFails(setDoc(wsRef(db), { payload: { ...payload(), version: 2 }, revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(wsRef(db), { payload: payload(), revision: 1, updatedAt: serverTimestamp(), admin: true }));
  await assertFails(setDoc(doc(db, 'users', OWNER, 'workspaces', 'other'),
    { payload: payload(), revision: 1, updatedAt: serverTimestamp() }));
  await assertFails(setDoc(doc(db, 'users', OWNER, 'secrets', 'x'), { a: 1 }));
});

test('workspace and backups can never be deleted by a client', async () => {
  const db = workspace(OWNER);
  await setDoc(wsRef(db), { payload: payload(), revision: 1, updatedAt: serverTimestamp() });
  await assertFails(deleteDoc(wsRef(db)));
  const b = doc(db, 'users', OWNER, 'backups', 'b1');
  await assertSucceeds(setDoc(b, { payload: payload(), revision: 1, createdAt: serverTimestamp(), reason: 'before-overwrite' }));
  await assertFails(deleteDoc(b));
  await assertFails(updateDoc(b, { reason: 'tampered' }));
});

test('transactional overwrite with backup snapshot succeeds; concurrent writer is detected', async () => {
  const a = workspace(OWNER);
  await setDoc(wsRef(a), { payload: payload(), revision: 1, updatedAt: serverTimestamp() });
  // Device A read revision 1, device B overwrites first.
  const b = workspace(OWNER);
  await setDoc(wsRef(b), { payload: payload([]), revision: 2, updatedAt: serverTimestamp() });
  // Device A's write based on revision 1 must be refused by the rules.
  await assertFails(setDoc(wsRef(a), { payload: payload(), revision: 2, updatedAt: serverTimestamp() }));
  // A correct transaction reads the latest revision and writes backup + new revision atomically.
  await assertSucceeds(runTransaction(a, async tx => {
    const snap = await tx.get(wsRef(a));
    const rev = snap.data().revision;
    tx.set(doc(a, 'users', OWNER, 'backups', 'rev-' + rev),
      { payload: snap.data().payload, revision: rev, createdAt: serverTimestamp(), reason: 'before-overwrite' });
    tx.set(wsRef(a), { payload: payload(), revision: rev + 1, updatedAt: serverTimestamp() });
  }));
});

test('owner can look up the backup of a given revision (lost-update diff); others cannot', async () => {
  const a = workspace(OWNER);
  await setDoc(doc(a, 'users', OWNER, 'backups', 'rev-1-1'),
    { payload: payload(), revision: 1, createdAt: serverTimestamp(), reason: 'before-overwrite' });
  const q = db => query(collection(db, 'users', OWNER, 'backups'), where('revision', '==', 1));
  const snap = await assertSucceeds(getDocs(q(a)));
  if (snap.size !== 1) throw new Error('expected one backup, got ' + snap.size);
  await assertFails(getDocs(q(workspace(OTHER))));
});
