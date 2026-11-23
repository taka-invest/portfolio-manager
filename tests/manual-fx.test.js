'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/market.js');
const Stage = require('../app/staged-funding.js');
const Data = require('../app/data.js');

const NOW = Date.parse('2026-11-22T12:00:00Z');
const CLOSE = Date.parse('2026-11-20T21:00:00Z');
const PRICES = { PLTR:143.49, NVDA:125.53, AVGO:304.41, CRDO:99.86,
  APP:348.29, SOFI:12.48, RKLB:45.42 };
const lot = (ticker, shares, basis = 12000) => ({
  id:ticker, ticker, kind:'stock', accountType:'specific', broker:'Monex',
  account:'', shares, currency:'JPY', unitCost:basis, costJpy:shares*basis,
  referenceJpy:null, layer:1, note:''
});
function setup() {
  const state = { ...Data.blank(), confirmed:true,
    positions:[lot('PLTR',1100,12357),lot('APP',120,50000),
      lot('SOFI',600,1700),lot('RKLB',100,9000),lot('NVDA',25,22000)],
    cash:{jpy:250000,usd:0,extraJpy:0,extraIncluded:true} };
  state.stagedFunding=Stage.snapshot(state,NOW);
  const quotes=Object.fromEntries(Object.entries(PRICES).map(([ticker,usd])=>[ticker,{usd,at:CLOSE}]));
  return {state,quotes};
}
test('user verified USDJPY is a distinct manual source and expires after ten minutes', () => {
  const fx=M.manualFx('158.9035',NOW);
  assert.equal(fx.kind,'manual');
  assert.equal(fx.rate,158.9035);
  assert.match(fx.source,/手入力/);
  assert.equal(M.fxStatus(fx,NOW),'ready');
  assert.equal(M.fxStatus(fx,NOW+9*60*1000),'ready');
  assert.equal(M.fxStatus(fx,NOW+11*60*1000),'stale');
  assert.equal(M.fxStatus({...fx,at:NOW+300000},NOW),'missing');
});
test('manual FX rejects malformed inputs rather than permitting unsafe prices', () => {
  for(const input of ['', '0', '-100', 'Infinity', 'abc', '1e9', '49.99', '300.01', null, NaN, {}])
    assert.ok(M.manualFx(input,NOW).error, String(input));
});
test('A day uses recent manual broker FX, still respects PLTR hard 30% sell floor', () => {
  const {state,quotes}=setup();
  const fx=M.manualFx('158.9035',NOW);
  const out=Stage.calc(state,{fx,quotes},1,NOW);
  assert.deepEqual(out.errors,[]);
  assert.equal(out.stagePct,50);
  assert.ok(out.idealBudget>0);
  assert.ok(out.buyTotal<=out.sale.net+0.001);
  assert.ok(out.sale.shares===0 || out.afterPltrPct>=30-1e-8);
  const expired=Stage.calc(state,{fx,quotes},1,NOW+11*60*1000);
  assert.ok(expired.errors.some(e=>e.includes('USD/JPY')));
});
test('untimestamped daily ECB reference is still rejected for broker-funded orders', () => {
  const {state,quotes}=setup();
  const out=Stage.calc(state,{fx:{kind:'reference',rate:158.9,date:'2026-11-20'},quotes},1,NOW);
  assert.ok(out.errors.some(e=>e.includes('USD/JPY')));
});
