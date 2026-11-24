// Fetch SEC companyfacts for verification tickers and save a trimmed fixture
// (only the us-gaap concepts the financial layer uses). Public SEC data.
//   node --env-file=functions/.env scripts/fetch-sec-fixtures.mjs PLTR APP NVDA
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { getJson } from '../functions/src/sec-gateway.js';
import { resolveCik } from '../functions/src/sec/company.js';
import { CONCEPTS, INSTANT_CONCEPTS } from '../functions/src/sec/financials.js';

const out = resolve(import.meta.dirname, '../tests/fixtures/sec');
mkdirSync(out, { recursive: true });
const tags = new Set([...Object.values(CONCEPTS), ...Object.values(INSTANT_CONCEPTS)].flat());
for (const t of process.argv.slice(2).map(s => s.toUpperCase())) {
  const { cik } = await resolveCik(t);
  const facts = await getJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
  const gaap = Object.fromEntries(Object.entries(facts.facts['us-gaap'] ?? {}).filter(([k]) => tags.has(k)));
  const trimmed = { cik: facts.cik, entityName: facts.entityName, retrievedAt: new Date().toISOString(),
    source: `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, facts: { 'us-gaap': gaap,
    dei: { EntityCommonStockSharesOutstanding: facts.facts.dei?.EntityCommonStockSharesOutstanding } } };
  writeFileSync(resolve(out, t + '.json'), JSON.stringify(trimmed));
  console.log(t, cik, facts.entityName, Object.keys(gaap).length + ' concepts');
}
