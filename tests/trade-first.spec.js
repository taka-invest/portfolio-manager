'use strict';
const {test,expect} = require('@playwright/test');
const D = require('../app/data.js');

const close=Date.parse('2026-11-20T21:00:00Z')/1000;
const t=(ticker,pct,extra={})=>({ticker,pct,group:'core',sellCap:null,wait:false,...extra});
const lot=(ticker,shares)=>({
  id:ticker,ticker,shares,kind:'stock',broker:'マネックス証券',
  account:'',accountType:'specific',layer:1,currency:'USD',
  unitCost:10,costJpy:shares*100,referenceJpy:null,note:''
});
async function setUp(page,confirmed=false){
  await page.clock.setFixedTime(new Date('2026-11-22T12:00:00Z'));
  const state={...D.blank(),confirmed,
    positions:[lot('PLTR',20),lot('APP',5),lot('GOOGL',2)],
    targets:[t('PLTR',30,{sellCap:0}),t('APP',20),t('NVDA',40)],cashTarget:10,
    cash:{jpy:10000,usd:0,extraJpy:0,extraIncluded:true}};
  await page.addInitScript(({key,state})=>{
    localStorage.setItem(key,JSON.stringify(state));
    localStorage.setItem('pm_api_key','fixture-key');
  },{key:D.KEY,state});
  await page.route('**/*',route=>{
    const u=new URL(route.request().url());
    if(u.hostname==='127.0.0.1')return route.continue();
    if(u.hostname==='api.frankfurter.dev')return route.fulfill({json:{
      base:'USD',quote:'JPY',date:'2026-11-20',rate:100}});
    if(u.hostname==='finnhub.io'){
      if(u.pathname.endsWith('/quote')){
        const prices={PLTR:100,APP:50,GOOGL:200,NVDA:10};
        return route.fulfill({json:{c:prices[u.searchParams.get('symbol')]??0,t:close}});
      }
      if(u.pathname.endsWith('/profile2'))return route.fulfill({json:{}});
      if(u.pathname.endsWith('/calendar/earnings'))return route.fulfill({json:{earningsCalendar:[]}});
    }
    return route.fulfill({status:503,json:{}});
  });
}

test('PC: rebalance shortcut opens the buy/sell deltas with USD/JPY and optional advanced settings',async({page},info)=>{
  test.skip(info.project.name!=='PC','PC only');
  await setUp(page,false);
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/portfolio_manager.html#overview');
  await page.getByRole('navigation',{name:'主要機能'}).getByRole('link',{name:'リバランス'}).click();
  await expect(page).toHaveURL(/#rebalance$/);
  const table=page.locator('#ideal-table');
  await expect(table).toContainText('現在株数');
  await expect(table).toContainText('理想株数（整数）');
  await expect(table).toContainText('売買差分（税引前）');
  await expect(table).toContainText('PLTR');
  await expect(table).toContainText('売却上限0株：③では売却されません');
  await expect(table).toContainText('GOOGL');
  await expect(table).toContainText('配分未登録');
  await expect(table).toContainText('買（理論）');
  await expect(table).toContainText('売（理論）');
  await expect(page.locator('#ideal-totals')).toContainText('¥160,000');
  await expect(page.locator('#ideal-totals')).toContainText('¥140,000');
  await expect(page.locator('#ideal-totals')).toContainText('¥30,000');
  await expect(page.locator('#ideal-totals')).toContainText('¥27,500');
  await expect(page.locator('#ideal-background')).not.toHaveAttribute('open','');
  await expect(page.locator('#execution-breakdown')).not.toHaveAttribute('open','');
  await expect(page.locator('#rebalance-audit-details')).not.toHaveAttribute('open','');
  await expect(page.locator('#rebalance-audit-summary')).toContainText('計算保留');
  await expect(page.locator('#trade-board')).toBeEmpty();

  const cap=page.locator('#target-rows [data-field="cap"]').first();
  await expect(cap).toBeHidden();
  await page.locator('#target-detail-toggle').click();
  await expect(cap).toBeVisible();
  await expect(page.locator('#target-detail-toggle')).toHaveAttribute('aria-expanded','true');
  await page.locator('#target-detail-toggle').click();
  await expect(cap).toBeHidden();
  expect(errors).toEqual([]);
});
test('PC: the verified execution orders remain separate from reference table',async({page},info)=>{
  test.skip(info.project.name!=='PC','PC only');
  await setUp(page,true);
  await page.goto('/portfolio_manager.html#after');
  await expect(page.locator('#ideal-table')).toContainText('売（理論）');
  await expect(page.locator('#trade-board')).toContainText('BUY');
  await expect(page.locator('#rebalance-audit-summary')).toContainText('現設定では達成不可');
  await expect(page.locator('#rebalance-audit-details')).not.toHaveAttribute('open','');
  await expect(page.locator('#allocation-charts svg')).toHaveCount(2);
});
