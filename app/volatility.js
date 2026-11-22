'use strict';

/* Volatility reference data: a licensed feed can be published on this origin.
   No third-party reverse proxy, scraping, or redistribution is activated by default. */
((root) => {
  const VALID_AGE_MS = 96 * 60 * 60 * 1000;
  const isFiniteValue = n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= 200;
  function validate(value) {
    const asOf = Date.parse(value?.asOf);
    if (value?.version !== 1 || value?.status !== 'ok' ||
        !isFiniteValue(value?.VIX) || !isFiniteValue(value?.VXN) ||
        !Number.isFinite(asOf) || asOf > Date.now() + 300000 ||
        typeof value?.source !== 'string' || !value.source.trim() || value.source.length > 120) {
      throw new TypeError('Invalid volatility feed');
    }
    return { version: 1, status: 'ok', VIX: value.VIX, VXN: value.VXN,
      asOf: new Date(asOf).toISOString(), source: value.source.trim() };
  }
  function isFresh(snapshot, now = Date.now()) {
    if (!snapshot) return false;
    const asOf = Date.parse(snapshot.asOf);
    if (!Number.isFinite(asOf) || asOf > now + 300000 || now - asOf > VALID_AGE_MS) return false;
    // Treat previous close as current only during exchange closure and premarket.
    const status = root.PMMarket?.quoteStatus?.({ usd: snapshot.VIX, at: asOf }, now);
    return status === 'ready';
  }
  function localFeedUrl(raw, base) {
    if (!raw?.trim()) return null;
    const u = new URL(raw.trim(), base);
    if (u.origin !== new URL(base).origin || !['https:', 'http:'].includes(u.protocol) ||
        u.username || u.password) throw new TypeError('Feed must be on the same origin');
    return u.href;
  }
  const api = { validate, isFresh, localFeedUrl };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMVolatility = api;
})(globalThis);
