// Firebase 2nd generation HTTP functions; no Netlify dependency.
// Never deploy this until official EDGAR data, costs, and API responses are verified.
import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { authorize, AccessError } from './auth.js';
import { handler as analyzeLegacy } from './legacy/analyze.js';
import { handler as screenerLegacy } from './legacy/screener.js';
import { handler as chartLegacy } from './legacy/chart.js';
import { ticker, tickers } from './input.js';
import { companyFinancials } from './sec/company.js';

initializeApp();
setGlobalOptions({
  region: 'asia-northeast1', maxInstances: 1, concurrency: 1,
  memory: '512MiB', timeoutSeconds: 180, minInstances: 0
});

const opts = { cors: false, maxInstances: 1, concurrency: 1 };
const isAllowed = async uid => {
  const snap = await getFirestore().doc('allowlist/' + uid).get();
  return snap.exists && snap.get('enabled') === true;
};
// Operational log: never include tokens, UIDs, holdings, amounts or request bodies.
const log = (api, started, status, errorClass) => logger.info('finance_api', {
  api, status, durationMs: Date.now() - started, ...(errorClass ? { errorClass } : {})
});

const secure = (name, handler, { needsSec = true } = {}) => onRequest(opts, async (req, res) => {
  const started = Date.now();
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  try {
    await authorize(req.headers.authorization, {
      verifyIdToken: (t, revoked) => getAuth().verifyIdToken(t, revoked), isAllowed
    });
  } catch (err) {
    const status = err instanceof AccessError ? err.status : 401;
    log(name, started, status, 'auth');
    res.status(status).json({ error: err instanceof AccessError ? err.message : 'Authentication failed' });
    return;
  }
  // Validate client input first: a malformed request is 400 regardless of server config.
  let event;
  try { event = handler.prepare(req); }
  catch (err) {
    log(name, started, 400, 'input');
    res.status(400).json({ error: String(err.message || 'invalid request').slice(0, 80) }); return;
  }
  if (needsSec && (!process.env.SEC_USER_AGENT || !process.env.SEC_USER_AGENT.includes('@'))) {
    log(name, started, 503, 'config');
    res.status(503).json({ error: 'SEC contact is not configured' }); return;
  }
  try {
    const result = await handler.run(event);
    const status = Number(result.statusCode);
    const payload = typeof result.body === 'string' ? JSON.parse(result.body) : result.body;
    if (!Number.isInteger(status) || status < 200 || status > 599)
      throw new Error('Malformed legacy response');
    // Avoid leaking upstream URL, credentials, or stack traces.
    if (status >= 500) {
      log(name, started, 502, 'upstream');
      res.status(502).json({ error: 'Market data upstream unavailable' }); return;
    }
    log(name, started, status);
    res.status(status).json(payload);
  } catch (err) {
    if (err.message?.startsWith('invalid') || err.message?.startsWith('ticker') ||
        err.message?.startsWith('tickers') || err.message?.startsWith('duplicate')) {
      log(name, started, 400, 'input');
      res.status(400).json({ error: err.message }); return;
    }
    log(name, started, 502, 'exception');
    // Upstream failure classification only (no URL, token, UID or payload).
    logger.warn('finance_api_upstream_error', {
      api: name, errorName: err?.name, errorCode: err?.code ?? err?.cause?.code ?? null,
      upstreamStatus: Number.isInteger(err?.status) ? err.status : null
    });
    res.status(502).json({ error: 'Market data unavailable' });
  }
});

const makeTicker = (req, method) => {
  if (req.method !== method) throw new Error('invalid method');
  return ticker(req.query.ticker);
};

export const analyzeApi = secure('analyze', {
  prepare(req) {
    const t = makeTicker(req, 'GET');
    return { httpMethod: 'GET', queryStringParameters: { ticker: t } };
  },
  run: analyzeLegacy
});
export const chartApi = secure('chart', {
  prepare(req) {
    const t = makeTicker(req, 'GET');
    return { httpMethod: 'GET', queryStringParameters: { ticker: t } };
  },
  run: chartLegacy
}, { needsSec: false });
export const screenerApi = secure('screener', {
  prepare(req) {
    if (req.method !== 'POST') throw new Error('invalid method');
    const raw = req.rawBody;
    if (raw && raw.length > 2048) throw new Error('invalid request size');
    const list = tickers(req.body?.tickers);
    return { httpMethod: 'POST', body: JSON.stringify({ tickers: list }) };
  },
  run: screenerLegacy
});

// Corrected SEC financial statements (Q4 synthesis, YTD differencing, date-matched YoY/TTM, FCF).
export const financialsApi = secure('financials', {
  prepare(req) {
    const t = makeTicker(req, 'GET');
    return { ticker: t };
  },
  async run(event) {
    try {
      return { statusCode: 200, body: await companyFinancials(event.ticker) };
    } catch (err) {
      if (err.status === 404) return { statusCode: 404, body: { error: 'Ticker not found in SEC company list' } };
      throw err;
    }
  }
});
