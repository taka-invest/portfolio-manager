// Ported verbatim from the Netlify production source (masya_app, 2026-09-17) except
// that every upstream request goes through ../sec-gateway.js (SEC UA, pacing, cache,
// retry). Do not fix financial logic here: corrected logic lives in ../sec/.
import { getJson } from '../sec-gateway.js';
const fetchJson = url => getJson(url);

export const handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  if (!ticker) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'ticker required' }) };
  }

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1wk&range=5y`;
    const json = await fetchJson(url);
    return { statusCode: 200, headers, body: JSON.stringify(json) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
