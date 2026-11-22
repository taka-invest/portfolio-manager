'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/data.js');
const R = require('../app/rebalance.js');
const V = require('../app/rebalance-view.js');

const now = Date.parse('2026-11-22T12:00:00Z');
const at = Date.parse('2026-11-20T21:00:00Z');
const target = (ticker, pct, more = {}) =>
  ({ ticker, pct, group: 'core', wait: false, sellCap: null, ...more });
const lot = (ticker, shares) => ({
  id: ticker, ticker, shares, kind: 'stock', broker: '証券会社', account: '',
  accountType: 'specific', layer: 1, currency: 'USD', unitCost: 1, costJpy: shares * 100,
  referenceJpy: null, note: ''
});
function scenario(fields, prices, confirmed = false) {
  const state = D.validate({ ...D.blank(), confirmed, cashTarget: 10,
    cash: { jpy: 10000, usd: 0, extraJpy: 0, extraIncluded: true }, ...fields });
  const market = { fx: { rate: 100, date: '2026-11-20' },
    quotes: Object.fromEntries(Object.entries(prices).map(([ticker, usd]) =>
      [ticker, { usd, at }])) };
  return { state, market, preview: R.ideal(state, market, now), result: R.simulate(state, market, now) };
}
test('unconfirmed lots produce directly visible theoretical BUY/SELL quantities in JPY and USD', () => {
  const { state, preview, result } = scenario({
    positions: [lot('PLTR',20),lot('APP',5),lot('GOOGL',2)],
    targets: [target('PLTR',30,{sellCap:0}),target('APP',20),target('NVDA',40)]
  }, { PLTR:100, APP:50, GOOGL:200, NVDA:10 });
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.total, 275000);
  const rows = Object.fromEntries(preview.rows.map(row => [row.ticker,row]));
  assert.equal(rows.PLTR.idealWholeShares,8);
  assert.equal(rows.APP.idealWholeShares,11);
  assert.equal(rows.NVDA.idealWholeShares,110);
  assert.equal(rows.GOOGL.idealWholeShares,0);
  const html = V.ideal(preview);
  assert.match(html,/売買差分（税引前）/);
  assert.match(html,/現在株数/);
  assert.match(html,/理想株数（整数）/);
  assert.match(html,/売却上限0株：③では売却されません/);
  assert.match(html,/配分未登録：③での売却には目標0%登録が必要/);
  assert.match(html,/12株/);
  assert.match(html,/6株/);
  assert.match(html,/110株/);
  assert.match(html,/\$1,200\.00/);
  assert.match(html,/¥120,000/);
  const totals = V.idealTotals(preview,state);
  assert.match(totals,/理論売却総額/);
  assert.match(totals,/¥160,000/);
  assert.match(totals,/理論購入総額/);
  assert.match(totals,/¥140,000/);
  assert.match(totals,/全差分実行後の現金/);
  assert.match(totals,/¥30,000/);
  assert.match(totals,/目標現金/);
  assert.match(totals,/¥27,500/);
  assert.ok(result.errors.length, '③ requires confirmation, ② must remain reference-only');
  assert.equal(V.trades(result),'');
});
test('buy on hold shows WAIT and its theoretical cost but does not assume execution', () => {
  const { state, preview } = scenario({
    targets:[target('NVDA',80),target('CRDO',10,{group:'satellite',wait:true})],
    cash: { jpy:100000,usd:0,extraJpy:0,extraIncluded:true }
  },{NVDA:10,CRDO:5});
  const view=V.ideal(preview), totals=V.idealTotals(preview,state);
  assert.match(view,/購入待機中：③では買いません/);
  assert.match(view,/購入待機/);
  assert.match(totals,/うち購入待機/);
  assert.match(totals,/¥10,000/);
});
test('unknown target quote never invents executable shares or cash balance', () => {
  const { state, preview }=scenario({
    targets: [target('NVDA',50),target('SPCX',40,{group:'satellite',wait:true})],
    cash: { jpy:100000,usd:0,extraJpy:0,extraIncluded:true }
  },{NVDA:10});
  assert.deepEqual(preview.errors,[]);
  assert.match(V.ideal(preview),/価格待ち/);
  assert.match(V.ideal(preview),/価格未確認・待機/);
  const sums=V.idealTotals(preview,state);
  assert.match(sums,/合計購入額・売買後現金は未確定/);
  assert.match(sums,/—/);
});
test('confirmed execution model remains distinct from reference deltas and audit', () => {
  const {state,preview,result}=scenario({
    positions:[lot('PLTR',20)],
    targets:[target('PLTR',30,{sellCap:0}),target('NVDA',60)]
  },{PLTR:100,NVDA:10},true);
  assert.deepEqual(result.errors,[]);
  const pltr=preview.rows.find(r=>r.ticker==='PLTR');
  const soldByModel=result.rows.find(r=>r.ticker==='PLTR');
  assert.ok(pltr.shares-pltr.idealWholeShares>0,'reference suggests sale');
  assert.equal(soldByModel.order,0,'execution respects sellCap=0');
});
