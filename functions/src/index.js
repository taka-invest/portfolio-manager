// Firebase 2nd generation HTTP functions; no Netlify dependency.
// Never deploy this until official EDGAR data, costs, and API responses are verified.
import { onRequest, setGlobalOptions } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { handler as analyzeLegacy } from './legacy/analyze.js';
import { handler as screenerLegacy } from './legacy/screener.js';
import { handler as chartLegacy } from './legacy/chart.js';
import { ticker, tickers } from './input.js';

initializeApp();
setGlobalOptions({
  region: 'asia-northeast1', maxInstances: 1, concurrency: 1,
  memory: '512MiB', timeoutSeconds: 180, minInstances: 0
});

const opts = { cors: false, maxInstances: 1, concurrency: 1 };
const secure = handler => onRequest(opts, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  // Firebase Hosting same-origin API; bearer token is required.
  const header = String(req.headers.authorization || '');
  if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(header)) {
    res.status(401).json({ error: 'Google login required' }); return;
  }
  try {
    const token = await getAuth().verifyIdToken(header.slice(7));
    if (token.firebase?.sign_in_provider !== 'google.com') {
      res.status(403).json({ error: 'Google sign-in required' }); return;
    }
  } catch {
    res.status(401).json({ error: 'Authentication failed' }); return;
  }
  if (!process.env.SEC_USER_AGENT || !process.env.SEC_USER_AGENT.includes('@')) {
    res.status(503).json({ error: 'SEC contact is not configured' }); return;
  }
  try {
    const event = handler.prepare(req);
    const result = await handler.run(event);
    const status = Number(result.statusCode);
    const payload = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
    if (!Number.isInteger(status) || status < 200 || status > 599)
      throw new Error('Malformed legacy response');
    // Avoid leaking upstream URL, credentials, or stack traces.
    if (status >= 500) { res.status(502).json({ error: 'Market data upstream unavailable' }); return; }
    res.status(status).json(payload);
  } catch (err) {
    if (err.message?.startsWith('invalid') || err.message?.startsWith('ticker') ||
        err.message?.startsWith('tickers') || err.message?.startsWith('duplicate')) {
      res.status(400).json({ error: err.message }); return;
    }
    res.status(502).json({ error: 'Market data unavailable' });
  }
});

const makeTicker = (req, method) => {
  if (req.method !== method) throw new Error('invalid method');
  return ticker(req.query.ticker);
};

export const analyzeApi = secure({
  prepare(req) {
    const t = makeTicker(req, 'GET');
    return { httpMethod: 'GET', queryStringParameters: { ticker: t } };
  },
  run: analyzeLegacy
});
export const chartApi = secure({
  prepare(req) {
    const t = makeTicker(req, 'GET');
    return { httpMethod: 'GET', queryStringParameters: { ticker: t } };
  },
  run: chartLegacy
});
export const screenerApi = secure({
  prepare(req) {
    if (req.method !== 'POST') throw new Error('invalid method');
    const raw = req.rawBody;
    if (raw && raw.length > 2048) throw new Error('invalid request size');
    const list = tickers(req.body?.tickers);
    return { httpMethod: 'POST', body: JSON.stringify({ tickers: list }) };
  },
  run: screenerLegacy
});
