// End-to-end access control for the finance APIs on the Firebase Emulator Suite
// (auth + firestore + functions, demo project — no real Firebase resources).
//   npm run test:api
// SEC network access is only needed for the final "allowed user" case; without
// SEC_USER_AGENT (CI) the function must answer 503, never 200 with invented data.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PROJECT = 'demo-finance-base';
const AUTH = 'http://127.0.0.1:9099';
const FS = 'http://127.0.0.1:8080';
const FN = `http://127.0.0.1:5001/${PROJECT}/asia-northeast1`;

async function googleUser(sub) {
  // Auth emulator accepts an unsigned JSON id_token for federated sign-in.
  const idToken = JSON.stringify({ sub, email: sub + '@example.test', email_verified: true });
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestUri: 'http://localhost', returnSecureToken: true,
      postBody: 'id_token=' + encodeURIComponent(idToken) + '&providerId=google.com' })
  });
  const body = await res.json();
  assert.ok(body.idToken, 'emulator sign-in failed: ' + JSON.stringify(body));
  return { uid: body.localId, token: body.idToken };
}
async function anonymousUser() {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true })
  });
  const body = await res.json();
  return { uid: body.localId, token: body.idToken };
}
async function allow(uid) {
  const res = await fetch(`${FS}/v1/projects/${PROJECT}/databases/(default)/documents/allowlist/${uid}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ fields: { enabled: { booleanValue: true } } })
  });
  assert.equal(res.status, 200);
}
const call = (path, token) => fetch(`${FN}/${path}`, { headers: token ? { Authorization: 'Bearer ' + token } : {} });

test('no token -> 401, malformed token -> 401', async () => {
  assert.equal((await call('financialsApi?ticker=PLTR')).status, 401);
  assert.equal((await call('financialsApi?ticker=PLTR', 'not.a.jwt')).status, 401);
});

test('Google user NOT on the allowlist -> 403 on every API', async () => {
  const u = await googleUser('stranger-' + Date.now());
  for (const p of ['financialsApi?ticker=PLTR', 'analyzeApi?ticker=PLTR', 'chartApi?ticker=PLTR']) {
    assert.equal((await call(p, u.token)).status, 403, p);
  }
});

test('non-Google sign-in is refused even if allowlisted', async () => {
  const u = await anonymousUser();
  await allow(u.uid);
  assert.equal((await call('financialsApi?ticker=PLTR', u.token)).status, 403);
});

test('allowlisted Google user: bad input -> 400; valid ticker -> 200 with sourced data (or 503 without SEC contact)', async () => {
  const u = await googleUser('owner-' + Date.now());
  await allow(u.uid);
  const bad = await call('financialsApi?ticker=' + encodeURIComponent('PLTR/../x'), u.token);
  assert.equal(bad.status, 400);
  const res = await call('financialsApi?ticker=PLTR', u.token);
  if (process.env.SEC_USER_AGENT || res.status === 200) {
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ticker, 'PLTR');
    assert.match(body.source.url, /^https:\/\/data\.sec\.gov\/api\/xbrl\/companyfacts\/CIK0001321655\.json$/);
    assert.equal(body.status, 'verification-pending');
    assert.ok(body.quarters.length >= 8);
    assert.ok(body.evaluation && body.evaluation.masyaScore);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
  } else {
    assert.equal(res.status, 503);
  }
});
