// Corrected company financials from SEC EDGAR companyfacts (no Yahoo dependency).
import { getJson } from '../sec-gateway.js';
import { analyzeFacts } from './financials.js';

export async function resolveCik(ticker, fetchJson = getJson) {
  const map = await fetchJson('https://www.sec.gov/files/company_tickers.json');
  for (const v of Object.values(map)) {
    if (String(v.ticker).toUpperCase() === ticker) return { cik: String(v.cik_str).padStart(10, '0'), name: v.title };
  }
  const err = new Error('ticker not found in SEC company list');
  err.status = 404;
  throw err;
}

export async function companyFinancials(ticker, { fetchJson = getJson, now = () => new Date() } = {}) {
  const { cik, name } = await resolveCik(ticker, fetchJson);
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const facts = await fetchJson(url);
  const out = analyzeFacts(facts);
  return {
    ticker, cik, name: facts.entityName ?? name,
    source: { provider: 'SEC EDGAR XBRL companyfacts', url, retrievedAt: now().toISOString(),
      currency: 'USD', note: 'US-GAAP（USD）提出企業のみ。IFRS/20-F・USD以外は対象外' },
    quarters: out.quarters.slice(-16),
    annual: out.annual.slice(-6),
    latest: out.latest,
    definitions: out.definitions,
    status: 'verification-pending' // 公式値との照合が完了するまで売買判断に使わない
  };
}
