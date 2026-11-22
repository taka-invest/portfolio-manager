'use strict';

((root) => {
  const day = 86400000;
  const quoteEndpoint = 'https://finnhub.io/api/v1';
  const fxEndpoint = 'https://api.frankfurter.dev/v2/providers/ecb/rate/usd/jpy';
  const formatters = new Map();
  const utcDate = t => new Date(t).toISOString().slice(0, 10);
  const shift = (date, days) => utcDate(Date.parse(date) + days * day);
  const weekday = date => new Date(date).getUTCDay();
  const weekend = date => [0, 6].includes(weekday(date));
  const pad = n => String(n).padStart(2, '0');

  function zoned(timestamp, timeZone) {
    if (!formatters.has(timeZone)) {
      formatters.set(timeZone, new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }));
    }
    const p = Object.fromEntries(formatters.get(timeZone).formatToParts(timestamp).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
  }

  function observed(date) {
    if (weekday(date) === 6) return shift(date, -1);
    if (weekday(date) === 0) return shift(date, 1);
    return date;
  }

  function nthWeekday(year, month, wday, n) {
    const first = `${year}-${pad(month)}-01`;
    return shift(first, (wday - weekday(first) + 7) % 7 + (n - 1) * 7);
  }

  // Gregorian computus, used by both the US equity and TARGET calendars.
  function easter(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const g = Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - c % 4) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const t = h + l - 7 * m + 114;
    return `${year}-${pad(Math.floor(t / 31))}-${pad(t % 31 + 1)}`;
  }

  const usCalendars = new Map();
  function usClosed(date) {
    if (weekend(date)) return true;
    const y = Number(date.slice(0, 4));
    if (!usCalendars.has(y)) {
      const newYear = `${y}-01-01`;
      usCalendars.set(y, new Set([
        weekday(newYear) === 0 ? shift(newYear, 1) : newYear,
        nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), shift(easter(y), -2),
        shift(nthWeekday(y, 6, 1, 1), -7), ...(y >= 2022 ? [observed(`${y}-06-19`)] : []),
        observed(`${y}-07-04`), nthWeekday(y, 9, 1, 1), nthWeekday(y, 11, 4, 4), observed(`${y}-12-25`)
      ]));
    }
    return date === '2025-01-09' || usCalendars.get(y).has(date);
  }

  function earlyClose(date) {
    const y = date.slice(0, 4);
    return date.endsWith('-07-03') || date.endsWith('-12-24') ||
      date === shift(nthWeekday(y, 11, 4, 4), 1);
  }

  function ecbClosed(date) {
    const y = Number(date.slice(0, 4));
    return weekend(date) || ['01-01', '05-01', '12-25', '12-26'].includes(date.slice(5)) ||
      [shift(easter(y), -2), shift(easter(y), 1)].includes(date);
  }

  function priorOpen(date, closed) {
    while (closed(date)) date = shift(date, -1);
    return date;
  }

  function quoteStatus(quote, now = Date.now()) {
    if (quote?.error) return quote.error;
    if (!(quote?.usd > 0) || !Number.isFinite(quote.usd) || !Number.isFinite(quote.at) ||
      quote.at <= 0 || quote.at < now - 14 * day || quote.at > now + 60000) return 'missing';

    const ny = zoned(now, 'America/New_York');
    const time = zoned(quote.at, 'America/New_York');
    const previous = priorOpen(shift(ny.date, -1), usClosed);
    const close = earlyClose(ny.date) ? 780 : 960;
    const priorClose = time.date === previous && time.minutes >= (earlyClose(previous) ? 765 : 945);
    if (usClosed(ny.date) || ny.minutes < 570) return priorClose ? 'ready' : 'stale';
    if (ny.minutes < 585 && priorClose) return 'ready';
    if (time.date !== ny.date || time.minutes < 570) return 'stale';
    if (ny.minutes <= close + 15) return now - quote.at <= 90 * 60000 ? 'ready' : 'stale';
    return time.minutes >= close - 15 ? 'ready' : 'stale';
  }

  function fxStatus(fx, now = Date.now()) {
    if (fx?.error) return fx.error;
    if (!(fx?.rate > 0) || !Number.isFinite(fx.rate) || !/^\d{4}-\d{2}-\d{2}$/.test(fx.date) ||
      !Number.isFinite(Date.parse(fx.date))) return 'missing';
    const berlin = zoned(now, 'Europe/Berlin');
    // Allow API publication latency after the ECB's usual ~16:00 CET update.
    const expected = priorOpen(berlin.minutes < 1080 ? shift(berlin.date, -1) : berlin.date, ecbClosed);
    return fx.date >= expected && fx.date <= berlin.date && !ecbClosed(fx.date) ? 'ready' : 'stale';
  }

  async function json(url, fetcher = fetch) {
    const response = await fetcher(url, {
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      const error = new Error('HTTP ' + response.status);
      error.status = response.status;
      const retry = response.headers?.get('Retry-After');
      error.retryMs = !retry ? 60000 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      throw error;
    }
    return response.json();
  }

  function finnhub(path, query, key, fetcher) {
    // Finnhub's browser preflight does not allow the custom token header.
    const params = new URLSearchParams({ ...query, token: key });
    return json(`${quoteEndpoint}/${path}?${params}`, fetcher);
  }

  const errCode = e => e.status === 429 ? 'limited' : [401, 403].includes(e.status) ? 'denied' : 'failed';

  async function fetchFx(fetcher) {
    try {
      const v = await json(fxEndpoint, fetcher);
      if (v.base !== 'USD' || v.quote !== 'JPY' || !Number.isFinite(v.rate) || v.rate <= 0 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return { error: 'missing' };
      return { rate: v.rate, date: v.date };
    } catch (e) {
      return { error: errCode(e) };
    }
  }

  async function fetchQuotes(tickers, key, fetcher, knownSpaceX = false) {
    const quotes = {};
    let spaceX = knownSpaceX;
    let limited = false;
    let retryMs = 0;
    for (const ticker of tickers) {
      if (!key || limited) {
        quotes[ticker] = { error: limited ? 'limited' : 'no-key' };
        continue;
      }
      try {
        if (ticker === 'SPCX' && !spaceX) {
          const profile = await finnhub('stock/profile2', { symbol: ticker }, key, fetcher);
          spaceX = profile.ticker === 'SPCX' && /space exploration|spacex/i.test(profile.name) &&
            /nasdaq/i.test(profile.exchange) && profile.currency === 'USD';
          if (!spaceX) {
            quotes[ticker] = { error: 'unverified' };
            continue;
          }
        }
        const quote = await finnhub('quote', { symbol: ticker }, key, fetcher);
        quotes[ticker] = Number.isFinite(quote.c) && quote.c > 0 && Number.isFinite(quote.t) && quote.t > 0
          ? { usd: quote.c, at: quote.t * 1000 } : { error: 'missing' };
      } catch (e) {
        quotes[ticker] = { error: errCode(e) };
        limited = e.status === 429;
        if (limited) retryMs = Math.max(60000, e.retryMs || 0);
      }
    }
    return { quotes, spaceX, limited, retryMs };
  }

  const api = { quoteStatus, fxStatus, fetchFx, fetchQuotes, finnhub, usClosed, ecbClosed };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMMarket = api;
})(globalThis);
