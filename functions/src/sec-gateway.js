// Shared SEC request governor (per Cloud Functions instance).
// Use maxInstances:1 on every SEC-facing Cloud Function; this governor applies
// to requests in one instance and does not replace an account-wide quota.
'use strict';
const cache = new Map();
let nextSecAt = 0;
const SEC_GAP_MS = 550; // <= 2 SEC requests/second per active instance
export const isSec = url => /^https:\/\/(?:data|www)\.sec\.gov\//.test(url);
export async function secPace(now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms))) {
  const start = Math.max(now(), nextSecAt);
  nextSecAt = start + SEC_GAP_MS;
  if (start > now()) await sleep(start - now());
}
export async function getJson(url, options = {}, fetcher = fetch) {
  const sec = isSec(url);
  const ttl = sec ? 10 * 60_000 : 2 * 60_000;
  if (sec && (!process.env.SEC_USER_AGENT || !/@/.test(process.env.SEC_USER_AGENT)))
    throw new Error('SEC_USER_AGENT is not configured.');
  const old = cache.get(url);
  if (old && old.expires > Date.now()) return old.promise;
  const promise = (async () => {
    if (sec) await secPace();
    const response = await fetcher(url, {
      ...options,
      headers: {
        'Accept': 'application/json',
        ...(sec ? { 'User-Agent': process.env.SEC_USER_AGENT } : {}),
        ...options.headers
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error('Upstream HTTP ' + response.status);
    return response.json();
  })();
  cache.set(url, { expires: Date.now() + ttl, promise });
  try { return await promise; }
  catch (err) { cache.delete(url); throw err; }
}
export function clearForTest() { cache.clear(); nextSecAt = 0; }
