// Corrected company financials from SEC EDGAR companyfacts, plus the "マシャ式"
// evaluation. Price is optional and always labelled with its source and time.
import { getJson } from '../sec-gateway.js';
import { analyzeFacts } from './financials.js';
import { evaluate } from './scoring.js';

export async function resolveCik(ticker, fetchJson = getJson) {
  const map = await fetchJson('https://www.sec.gov/files/company_tickers.json');
  for (const v of Object.values(map)) {
    if (String(v.ticker).toUpperCase() === ticker) return { cik: String(v.cik_str).padStart(10, '0'), name: v.title };
  }
  const err = new Error('ticker not found in SEC company list');
  err.status = 404;
  throw err;
}

/** Latest price from Yahoo Finance chart (unofficial; same source as the legacy app). */
export async function latestPrice(ticker, fetchJson = getJson) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`;
    const meta = (await fetchJson(url))?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (!(typeof price === 'number' && price > 0) || meta.currency !== 'USD') return null;
    return { price, currency: 'USD', asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      source: 'Yahoo Finance chart API（非公式・旧アプリと同じ取得元）' };
  } catch {
    return null; // price is optional; the model then reports "株価未取得"
  }
}

export async function companyFinancials(ticker, { fetchJson = getJson, now = () => new Date(), withPrice = true } = {}) {
  const { cik, name } = await resolveCik(ticker, fetchJson);
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const facts = await fetchJson(url);
  const out = analyzeFacts(facts);
  const quote = withPrice ? await latestPrice(ticker, fetchJson) : null;
  return {
    ticker, cik, name: facts.entityName ?? name,
    source: { provider: 'SEC EDGAR XBRL companyfacts', url, retrievedAt: now().toISOString(),
      currency: 'USD', note: 'US-GAAP（USD）提出企業のみ。IFRS/20-F・USD以外は対象外' },
    quote,
    quarters: out.quarters.slice(-16),
    annual: out.annual.slice(-6).map(({ accn, filed, ...a }) => a),
    latest: out.latest,
    balance: out.balance,
    evaluation: evaluate(out, { ticker, price: quote?.price ?? null }),
    definitions: out.definitions,
    status: 'verification-pending' // 売買判断用の正式機能としてはまだ公開しない
  };
}
