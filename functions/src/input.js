// Pure API input validation. No dynamic upstream URL is accepted.
const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,9}$/;
export function ticker(value) {
  if (typeof value !== 'string') throw new Error('ticker must be a string');
  const normalized = value.toUpperCase().trim();
  if (!TICKER.test(normalized)) throw new Error('invalid ticker');
  return normalized;
}
export function tickers(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10)
    throw new Error('tickers requires 1-10 symbols');
  const all = value.map(ticker);
  if (new Set(all).size !== all.length) throw new Error('duplicate ticker');
  return all;
}
