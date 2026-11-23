'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Data = require('../app/data.js');
const Legacy = require('../app/research-import.js');

test('legacy masyaWatchlist JSON parses a string array, normalizes and deduplicates', () => {
  assert.deepEqual(Legacy.parse('["pltr","NVDA","pltr","BRK.B"]'), ['PLTR','NVDA','BRK.B']);
  for (const text of [
    '', '[]x', '{"tickers":["PLTR"]}', '[{}, "NVDA"]', '["<script>"]',
    '[null]', '"PLTR"', JSON.stringify(new Array(501).fill('PLTR')),
    'x'.repeat(20001)
  ]) assert.throws(() => Legacy.parse(text), text.slice(0,30));
});

test('review reports only new tickers, then adds without altering portfolio state', () => {
  const base = Data.blank();
  base.positions = [{ id:'stock1',ticker:'PLTR',kind:'stock',broker:'Monex',
    account:'',accountType:'specific',shares:3,currency:'JPY',unitCost:12000,
    costJpy:36000,referenceJpy:null,layer:1,note:'' }];
  base.watchlist = [{ id:'watch1',ticker:'NVDA',layer:1, targetPriceJpy:17000,
    curPriceJpy:null, condition:'買付機会', note:'既存',
    addedAt:'2026-11-10T00:00:00Z' }];
  const previous = JSON.stringify(base);
  const report = Legacy.preview('["pltr","NVDA","PLTR","AVGO"]',base);
  assert.deepEqual(report,{parsed:3,newTickers:['PLTR','AVGO'],skipped:1});
  let counter=0;
  const next = Legacy.apply(base,report,()=>'imported'+(++counter),'2026-11-23T10:00:00+09:00');
  assert.equal(JSON.stringify(base),previous);
  assert.equal(next.watchlist.length,3);
  assert.deepEqual(next.watchlist.map(w=>w.ticker),['NVDA','PLTR','AVGO']);
  assert.deepEqual(next.watchlist[0],base.watchlist[0]);
  assert.deepEqual(next.positions,base.positions);
  assert.deepEqual(next.targets,base.targets);
  assert.deepEqual(next.cash,base.cash);
  assert.deepEqual(next.stagedFunding,base.stagedFunding);
  assert.deepEqual(Data.validate(next).watchlist,next.watchlist);
});
test('all duplicates yield an empty change set', () => {
  const state=Data.blank();
  state.watchlist=[{id:'w1',ticker:'PLTR',layer:2,condition:'',note:''}];
  const report=Legacy.preview('["PLTR","PLTR"]',state);
  assert.equal(report.newTickers.length,0);
  assert.equal(report.skipped,1);
});
