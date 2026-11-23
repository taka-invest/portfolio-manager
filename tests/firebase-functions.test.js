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
test('Firebase analysis functions are not exposed as a public Hosting rewrite yet', () => {
  const config = JSON.parse(readFileSync(join(base,'firebase.json'),'utf8'));
  assert.equal(config.functions[0].source, 'functions');
  assert.ok(!config.hosting.rewrites.some(r => r.source.startsWith('/api/')));
  const src=readFileSync(join(base,'functions/src/index.js'),'utf8');
  assert.match(src,/verifyIdToken/);
  assert.match(src,/sign_in_provider !== 'google.com'/);
  assert.match(src,/maxInstances: 1/);
  assert.match(src,/timeoutSeconds: 180/);
  assert.match(src,/SEC_USER_AGENT/);
  assert.match(src,/cors: false/);
  assert.ok(!src.includes('Access-Control-Allow-Origin'));
});

test('Migrated legacy engine modules and Firebase adapter have valid Node ESM syntax', () => {
  const { execFileSync } = require('node:child_process');
  for (const file of [
    'functions/src/index.js', 'functions/src/sec-gateway.js', 'functions/src/input.js',
    'functions/src/legacy/analyze.js', 'functions/src/legacy/screener.js',
    'functions/src/legacy/chart.js'
  ]) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(base, file)]),
      {message:'Invalid JavaScript syntax: ' + file});
  }
});
