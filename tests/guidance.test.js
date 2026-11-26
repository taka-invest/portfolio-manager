'use strict';
// 8-K guidance extraction: one excerpt per format seen in real releases (sentence range,
// "$x - $y billion", single "approximately", Low/High table), with the traps next to
// them (full-year figures, segment revenue, results tables, decimals in sentences).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const F = require('../research/forecast.js');

const load = () => import('../functions/src/sec/guidance.js');
const pick = (g, period) => g.revenue.filter(c => c.period === period && !c.segment).map(c => [c.low, c.high]);

test('sentence ranges and "$x - $y billion", quarter vs full year', async () => {
  const { extractGuidance } = await load();
  const pltr = extractGuidance('Revenue $ 2,313,411 96 % Outlook For Q4 2026, we expect: • Revenue of between $2.649 - $2.653 billion. • Adjusted income from operations of between $1.640 - $1.644 billion. For full year 2026: • We are raising our revenue guidance to between $8.530 - $8.534 billion. • We are raising our U.S. commercial revenue guidance to between $3.559 - $3.565 billion.');
  assert.deepEqual(pick(pltr, 'quarter'), [[2649, 2653]]);
  assert.deepEqual(pick(pltr, 'year'), [[8530, 8534]]);
  assert.ok(pltr.revenue.some(c => c.segment && c.low === 3559), 'U.S. commercial revenue is a segment');
  assert.ok(pltr.other.some(s => s.includes('$1.640 - $1.644 billion')), 'decimals do not cut the sentence');
  const crdo = extractGuidance('Second Quarter of Fiscal 2027 Financial Outlook • Revenue is expected to be between $525 million and $535 million • GAAP gross margin is expected to be between 62.9% and 64.9%');
  assert.deepEqual(pick(crdo, 'quarter'), [[525, 535]]);
  assert.match(crdo.revenue[0].periodText, /Second Quarter of Fiscal 2027/);
  const rklb = extractGuidance('Fourth Quarter 2026 Guidance For the fourth quarter of 2026, Rocket Lab expects: • Revenue between $270 million and $290 million');
  assert.deepEqual(pick(rklb, 'quarter'), [[270, 290]]);
});

test('single "approximately" figure; "fourth quarter fiscal year" is a quarter; segment growth is ignored', async () => {
  const { extractGuidance } = await load();
  const avgo = extractGuidance('"In Q4 the momentum continues, and we expect AI semiconductor revenue to accelerate to $21.7 billion." Fourth Quarter Fiscal Year 2026 Business Outlook: • Fourth quarter revenue guidance of approximately $34.8 billion; • Fourth quarter non-GAAP operating income guidance of approximately 66 percent of projected revenue.');
  assert.deepEqual(avgo.revenue.map(c => [c.period, c.low, c.high, c.approx]), [['quarter', 34800, 34800, true]]);
});

test('Low/High guidance table in millions; a results table without guidance context is ignored', async () => {
  const { extractGuidance } = await load();
  const app = extractGuidance('Fourth Quarter 2026 Financial Guidance Summary 4Q26 (In millions, except percentages) Low High Revenue $2,365 $2,395 Adjusted EBITDA $1,995 $2,025');
  assert.deepEqual(pick(app, 'quarter'), [[2365, 2395]]);
  const results = extractGuidance('Three Months Ended (In millions) Low High Revenue $1,405 $1,890 Net income $835');
  assert.deepEqual(results.revenue, []);
});

test('implausible or unit-less figures are not guessed', async () => {
  const { extractGuidance } = await load();
  assert.deepEqual(extractGuidance('We expect revenue of between $5 and $9 next quarter.').revenue, []);           // no unit
  assert.deepEqual(extractGuidance('Outlook: revenue between $100 million and $400 million.').revenue, []);      // range too wide
});

test('latestGuidance picks the newest Item 2.02 8-K and its Exhibit 99.1', async () => {
  const { latestGuidance } = await load();
  const urls = [];
  const fetchJson = async u => {
    urls.push(u);
    if (u.includes('submissions')) return { filings: { recent: { form: ['10-Q', '8-K', '8-K'], items: ['', '5.07', '2.02,9.01'],
      accessionNumber: ['a', '0000000000-26-000001', '0001751008-26-000123'], filingDate: ['2026-11-05', '2026-11-04', '2026-11-04'] } } };
    throw new Error('unexpected ' + u);
  };
  // Exhibits are found by their TYPE in the filing index (file names vary: q3fy27pr.htm, …).
  const index = `<tr><td scope="row">1</td><td scope="row">8-K</td><td scope="row"><a href="/ix?doc=/Archives/edgar/data/1751008/000175100826000123/app-20261104.htm">app-20261104.htm</a> &nbsp;<span>iXBRL</span></td><td scope="row">8-K</td><td>1</td></tr>
    <tr><td scope="row">3</td><td scope="row">EX-99.2</td><td scope="row"><a href="/Archives/edgar/data/1751008/000175100826000123/cfocommentary.htm">cfocommentary.htm</a></td><td scope="row">EX-99.2</td><td>2</td></tr>
    <tr><td scope="row">2</td><td scope="row">EX-99.1</td><td scope="row"><a href="/Archives/edgar/data/1751008/000175100826000123/q3pr.htm">q3pr.htm</a></td><td scope="row">EX-99.1</td><td>3</td></tr>`;
  const fetchText = async u => {
    urls.push(u);
    if (u.endsWith('-index.html')) return index;
    if (u.endsWith('q3pr.htm')) return '<p>Third quarter results.</p>';
    return '<p>Fourth Quarter 2026 Guidance</p><p>Revenue is expected to be between $2,365 million and $2,395 million</p>';
  };
  const g = await latestGuidance(1751008, { fetchJson, fetchText });
  assert.equal(g.accession, '0001751008-26-000123');
  assert.equal(g.url, 'https://www.sec.gov/Archives/edgar/data/1751008/000175100826000123/q3pr.htm');   // EX-99.1 first
  assert.deepEqual(g.docs, ['EX-99.1', 'EX-99.2']);
  assert.deepEqual(g.revenue.map(c => [c.low, c.high]), [[2365, 2395]]);                                // found in EX-99.2
  assert.ok(urls.every(u => /^https:\/\/(data|www)\.sec\.gov\//.test(u)));
});

test('guidance maps to the forecast quarter only for the release that reported the latest actual; adoption must match', () => {
  const trend = [{ end: '2026-09-30' }];
  assert.equal(F.guidanceQuarter(trend, '2026-11-04'), '2026-12-31');
  assert.equal(F.guidanceQuarter(trend, '2026-09-20'), null);         // before the quarter closed
  assert.equal(F.guidanceQuarter(trend, '2027-02-10'), null);         // a later release (10-Q not filed yet)
  const g = { accession: 'A1', revenue: [{ low: 2365, high: 2395, mid: 2380, period: 'quarter', segment: false },
    { low: 8530, high: 8534, mid: 8532, period: 'year', segment: false }] };
  assert.equal(F.adoptedGuidance(g, { accession: 'A1', low: 2365, high: 2395 }).mid, 2380);
  assert.equal(F.adoptedGuidance(g, { accession: 'OLD', low: 2365, high: 2395 }), null);   // a newer release replaces it
  assert.equal(F.adoptedGuidance(g, { accession: 'A1', low: 8530, high: 8534 }), null);     // full year is never a quarter row
});

test('"$X billion, plus or minus N%" becomes a range; annual-only guidance never becomes a quarter', async () => {
  const { extractGuidance } = await load();
  const nvda = extractGuidance("Outlook NVIDIA's outlook for the fourth quarter of fiscal 2027, which includes an additional week, is as follows: • Revenue is expected to be $130.0 billion, plus or minus 3%. • For the full year fiscal 2027, NVIDIA expects GAAP and non-GAAP tax rates to be between 16.0% and 18.0%.");
  assert.deepEqual(nvda.revenue.map(c => [c.period, c.low, c.high]), [['quarter', 126100, 133900]]);
  const sofi = extractGuidance('SoFi raised its 2026 guidance. SoFi now expects $5.04 billion of adjusted net revenue for the full year. The company also introduced 2027 guidance of approximately $6.4 billion adjusted net revenue.');
  assert.ok(sofi.revenue.every(c => c.period !== 'quarter'));
});
