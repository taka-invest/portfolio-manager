'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const base = join(__dirname, '..');
async function importSource(path) {
  return import('file://' + join(base, path));
}
test('financial API rejects arbitrary paths and excessive or duplicate tickers', async () => {
  const { ticker, tickers } = await importSource('functions/src/input.js');
  assert.equal(ticker(' pltr '), 'PLTR');
  assert.equal(ticker('BRK.B'), 'BRK.B');
  for (const value of ['PLTR/../SEC', 'A?x', 'INJECTION!', '', null, 3]) {
    assert.throws(() => ticker(value));
  }
  assert.deepEqual(tickers(['pltr', 'NVDA']), ['PLTR', 'NVDA']);
  assert.throws(() => tickers([]));
  assert.throws(() => tickers(Array(11).fill('NVDA')));
  assert.throws(() => tickers(['NVDA', 'nvda']));
  assert.throws(() => tickers('PLTR'));
});
test('SEC gateway requires declared operational contact and caches repeated requests', async () => {
  const { getJson, clearForTest } = await importSource('functions/src/sec-gateway.js');
  clearForTest();
  const old = process.env.SEC_USER_AGENT;
  delete process.env.SEC_USER_AGENT;
  try {
    await assert.rejects(getJson('https://data.sec.gov/api/xbrl/companyfacts/CIK0000000000.json',
      {}, async () => ({ ok: true, json: async () => ({ value: 1 }) })), /SEC_USER_AGENT/);
    process.env.SEC_USER_AGENT = 'IntegrationTest contact@real-example.invalid';
    let called = 0;
    const fetcher = async () => { called++; return {ok:true,json:async()=>({ value: 123 })}; };
    const url='https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json';
    const one=await getJson(url,{},fetcher);
    const two=await getJson(url,{},fetcher);
    assert.deepEqual(one,two);
    assert.equal(called,1);
  } finally {
    if(old===undefined) delete process.env.SEC_USER_AGENT;
    else process.env.SEC_USER_AGENT=old;
    clearForTest();
  }
});
test('Firebase analysis functions are reached only via same-origin rewrites to Tokyo functions', () => {
  const config = JSON.parse(readFileSync(join(base,'firebase.json'),'utf8'));
  assert.equal(config.functions[0].source, 'functions');
  assert.ok(config.hosting.rewrites.filter(r => r.source.startsWith('/api/')).every(r => r.function && r.function.region === 'asia-northeast1'));
  const src=readFileSync(join(base,'functions/src/index.js'),'utf8');
  const gate=readFileSync(join(base,'functions/src/auth.js'),'utf8');
  assert.match(src,/verifyIdToken\(t, revoked\)/);
  assert.match(src,/allowlist\//);
  assert.match(gate,/sign_in_provider !== 'google.com'/);
  assert.match(src,/maxInstances: 1/);
  assert.match(src,/timeoutSeconds: 180/);
  assert.match(src,/SEC_USER_AGENT/);
  assert.match(src,/cors: false/);
  assert.ok(!src.includes('Access-Control-Allow-Origin'));
});

test('Migrated legacy engine modules and Firebase adapter have valid Node ESM syntax', () => {
  const { execFileSync } = require('node:child_process');
  for (const file of [
    'functions/src/index.js', 'functions/src/sec-gateway.js', 'functions/src/input.js', 'functions/src/auth.js',
    'functions/src/legacy/analyze.js', 'functions/src/legacy/screener.js',
    'functions/src/legacy/chart.js', 'functions/src/legacy/sec-8k-guidance.js',
    'functions/src/legacy/eps-revisions.js', 'functions/src/sec/financials.js'
  ]) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(base, file)]),
      {message:'Invalid JavaScript syntax: ' + file});
  }
});

test('API access gate: valid Google token AND enabled allowlist UID are both required', async () => {
  const { authorize, clearAuthCacheForTest } = await importSource('functions/src/auth.js');
  clearAuthCacheForTest();
  const jwt = 'Bearer aaa.bbb.ccc';
  const google = uid => async (_t, revoked) => { assert.equal(revoked, true); return { uid, firebase: { sign_in_provider: 'google.com' } }; };
  const allow = new Set(['owner']);
  const isAllowed = async uid => allow.has(uid);
  assert.equal(await authorize(jwt, { verifyIdToken: google('owner'), isAllowed }), 'owner');
  await assert.rejects(authorize(jwt, { verifyIdToken: google('stranger'), isAllowed }), e => e.status === 403);
  await assert.rejects(authorize('', { verifyIdToken: google('owner'), isAllowed }), e => e.status === 401);
  await assert.rejects(authorize('Bearer not-a-jwt', { verifyIdToken: google('owner'), isAllowed }), e => e.status === 401);
  await assert.rejects(authorize(jwt, { verifyIdToken: async () => { throw new Error('revoked'); }, isAllowed }), e => e.status === 401);
  await assert.rejects(authorize(jwt, {
    verifyIdToken: async () => ({ uid: 'owner', firebase: { sign_in_provider: 'password' } }), isAllowed
  }), e => e.status === 403);
  clearAuthCacheForTest();
});

test('gateway: 429 honours Retry-After then succeeds; non-retryable errors fail fast; cache is bounded', async () => {
  const g = await importSource('functions/src/sec-gateway.js');
  g.clearForTest();
  const old = process.env.SEC_USER_AGENT;
  process.env.SEC_USER_AGENT = 'IntegrationTest contact@real-example.invalid';
  try {
    const sleeps = [];
    const sleep = async ms => { sleeps.push(ms); };
    let n = 0; const seen = [];
    const flaky = async (url, opts) => {
      seen.push(opts.headers['User-Agent']);
      n++;
      if (n === 1) return { ok: false, status: 429, headers: { get: k => k === 'retry-after' ? '2' : null } };
      return { ok: true, json: async () => ({ ok: n }) };
    };
    const out = await g.getJson('https://data.sec.gov/api/xbrl/companyfacts/CIK0000000002.json', {}, flaky, sleep);
    assert.deepEqual(out, { ok: 2 });
    assert.ok(sleeps.includes(2000), 'Retry-After seconds respected');
    assert.ok(seen.every(ua => ua === process.env.SEC_USER_AGENT), 'SEC UA on every attempt');

    let calls = 0;
    const notFound = async () => { calls++; return { ok: false, status: 404, headers: { get: () => null } }; };
    await assert.rejects(g.getJson('https://data.sec.gov/submissions/CIK0000000003.json', {}, notFound, sleep), e => e.status === 404);
    assert.equal(calls, 1, '404 is not retried');

    let yahooUa;
    await g.getJson('https://query1.finance.yahoo.com/v8/finance/chart/NVDA', {},
      async (u, o) => { yahooUa = o.headers['User-Agent']; return { ok: true, json: async () => ({}) }; }, sleep);
    assert.match(yahooUa, /^Mozilla\//);

    let html;
    html = await g.getText('https://www.sec.gov/cgi-bin/viewer?x=1', {},
      async (u, o) => { assert.equal(o.headers['User-Agent'], process.env.SEC_USER_AGENT); return { ok: true, text: async () => '<div>x</div>' }; }, sleep);
    assert.equal(html, '<div>x</div>');

    const okFetch = async () => ({ ok: true, json: async () => ({}) });
    for (let i = 0; i < 100; i++) await g.getJson('https://query1.finance.yahoo.com/v8/finance/chart/T' + i, {}, okFetch, sleep);
    assert.ok(g.cacheSizeForTest() <= 40, 'LRU cap');
  } finally {
    if (old === undefined) delete process.env.SEC_USER_AGENT; else process.env.SEC_USER_AGENT = old;
    g.clearForTest();
  }
});

test('ported legacy sources never call upstreams directly or use the placeholder SEC contact', () => {
  for (const f of ['analyze', 'screener', 'chart', 'sec-8k-guidance']) {
    const src = readFileSync(join(base, 'functions/src/legacy', f + '.js'), 'utf8');
    assert.doesNotMatch(src, /\bfetch\(|https\.get\(|contact@example\.com/, f);
    assert.match(src, /from '\.\.\/sec-gateway\.js'/, f);
  }
  const index = readFileSync(join(base, 'functions/src/index.js'), 'utf8');
  assert.doesNotMatch(index, /eps-revisions/, 'Finviz scraper must not be deployed');
});

test('unsigned (emulator-style) tokens are rejected outside the Functions Emulator', async () => {
  const { bearer } = await importSource('functions/src/auth.js');
  assert.throws(() => bearer('Bearer aaa.bbb.', false), e => e.status === 401);
  assert.equal(bearer('Bearer aaa.bbb.', true), 'aaa.bbb.');
  assert.equal(bearer('Bearer aaa.bbb.ccc', false), 'aaa.bbb.ccc');
});

test('gateway retries transient network failures (e.g. DNS EAI_AGAIN) then succeeds', async () => {
  const g = await importSource('functions/src/sec-gateway.js');
  g.clearForTest();
  let n = 0;
  const flaky = async () => { if (n++ === 0) throw new TypeError('fetch failed'); return { ok: true, json: async () => ({ ok: true }) }; };
  assert.deepEqual(await g.getJson('https://query1.finance.yahoo.com/v8/finance/chart/RETRY', {}, flaky, async () => {}), { ok: true });
  assert.equal(n, 2);
  g.clearForTest();
});
