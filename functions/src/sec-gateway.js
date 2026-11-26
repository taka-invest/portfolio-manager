// Shared upstream gateway for every finance API (per Cloud Functions instance).
// - SEC: declared User-Agent (SEC_USER_AGENT, a real operational contact),
//   <= 2 requests/second per instance (SEC fair-access limit is 10/s),
//   429/503 handling with Retry-After and exponential backoff.
// - Bounded LRU cache so multi-MB companyfacts payloads cannot exhaust memory.
// - Never logs URLs with personal data, tokens or holdings.
// Use maxInstances:1 on SEC-facing functions; this governor is per instance.
'use strict';

const MAX_ENTRIES = 40;          // parsed JSON objects kept in memory
// companyfacts can be several MB of JSON (several times that once parsed). A full
// screener scan touches ~120 of them, so the cache is also capped by response size
// to keep the 512MiB instance well clear of its memory limit.
const MAX_CACHE_BYTES = 40 * 1024 * 1024;
const SEC_TTL_MS = 10 * 60_000;
const OTHER_TTL_MS = 2 * 60_000;
const SEC_GAP_MS = 550;
const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
// The legacy Netlify app called Yahoo with a desktop browser User-Agent; kept for
// response parity until a licensed market-data source replaces it (see docs).
const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const cache = new Map(); // url -> { expires, promise }  (Map keeps insertion order => LRU)
let nextSecAt = 0;

export const isSec = url => /^https:\/\/(?:data|www)\.sec\.gov\//.test(url);
const isYahoo = url => /^https:\/\/query[12]\.finance\.yahoo\.com\//.test(url);
// CNN's Fear & Greed endpoint rejects non-browser clients; same parity rationale as Yahoo.
const isCnn = url => /^https:\/\/production\.dataviz\.cnn\.io\//.test(url);
const sleepReal = ms => new Promise(r => setTimeout(r, ms));

export async function secPace(now = () => Date.now(), sleep = sleepReal) {
  const start = Math.max(now(), nextSecAt);
  nextSecAt = start + SEC_GAP_MS;
  if (start > now()) await sleep(start - now());
}

export function retryDelay(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  return Math.min(1000 * 2 ** attempt, 8000);
}

const cachedBytes = () => { let n = 0; for (const e of cache.values()) n += e.size || 0; return n; };
function evict() {
  while (cache.size > MAX_ENTRIES || (cache.size > 1 && cachedBytes() > MAX_CACHE_BYTES)) cache.delete(cache.keys().next().value);
}
function remember(url, entry) {
  cache.delete(url);
  cache.set(url, entry);
  evict();
}

function contactConfigured() {
  return Boolean(process.env.SEC_USER_AGENT && /@/.test(process.env.SEC_USER_AGENT));
}

async function request(url, kind, options, fetcher, sleep) {
  const sec = isSec(url);
  if (sec && !contactConfigured()) throw new Error('SEC_USER_AGENT is not configured.');
  for (let attempt = 0; ; attempt++) {
    if (sec) await secPace(undefined, sleep);
    let response;
    try {
      response = await fetcher(url, {
      ...options,
      headers: {
        Accept: kind === 'json' ? 'application/json' : 'text/html,application/xhtml+xml',
        ...(sec ? { 'User-Agent': process.env.SEC_USER_AGENT } : {}),
        ...(isYahoo(url) || isCnn(url) ? { 'User-Agent': YAHOO_UA } : {}),
        ...options.headers
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      // Transient network failure (DNS EAI_AGAIN, reset, timeout): retry with backoff.
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(retryDelay(null, attempt));
      continue;
    }
    if (response.ok) {
      if (kind !== 'json') { const text = await response.text(); return { value: text, size: text.length }; }
      if (typeof response.text !== 'function') return { value: await response.json(), size: 0 };
      const text = await response.text();
      return { value: JSON.parse(text), size: text.length };
    }
    const retryable = response.status === 429 || response.status === 503 || response.status === 502;
    if (!retryable || attempt >= MAX_RETRIES) {
      const err = new Error('Upstream HTTP ' + response.status);
      err.status = response.status;
      throw err;
    }
    await sleep(retryDelay(response, attempt));
  }
}

function cached(url, kind, options, fetcher, sleep) {
  const key = kind + ':' + url;
  const old = cache.get(key);
  if (old && old.expires > Date.now()) { remember(key, old); return old.promise; }
  const entry = { expires: Date.now() + (isSec(url) ? SEC_TTL_MS : OTHER_TTL_MS), size: 0 };
  entry.promise = request(url, kind, options, fetcher, sleep).then(r => {
    entry.size = r.size;
    if (cache.get(key) === entry) evict();
    return r.value;
  });
  remember(key, entry);
  entry.promise.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return entry.promise;
}

export function getJson(url, options = {}, fetcher = fetch, sleep = sleepReal) {
  return cached(url, 'json', options, fetcher, sleep);
}
export function getText(url, options = {}, fetcher = fetch, sleep = sleepReal) {
  return cached(url, 'text', options, fetcher, sleep);
}

export function cacheSizeForTest() { return cache.size; }
export function cacheBytesForTest() { return cachedBytes(); }
export const CACHE_LIMITS = { MAX_ENTRIES, MAX_CACHE_BYTES };
export function clearForTest() { cache.clear(); nextSecAt = 0; }
