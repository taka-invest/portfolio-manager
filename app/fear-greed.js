'use strict';

((root) => {
  const { usClosed } = typeof module === 'object' && module.exports ? require('./market.js') : root.PMMarket;
  const SOURCE = 'https://www.cnn.com/markets/fear-and-greed';
  const ENDPOINT = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
  const RATINGS = ['Extreme Fear', 'Fear', 'Neutral', 'Greed', 'Extreme Greed'];
  const ERRORS = ['access-denied', 'http', 'timeout', 'network', 'format'];
  const DAY = 86400000;
  const dateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const score = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
  const time = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
  const ms = v => Number.isSafeInteger(v) && v >= 946684800000 && v <= 4102444800000;
  const dateKey = t => new Date(t).toISOString().slice(0, 10);
  const previousDay = date => dateKey(Date.parse(date) - DAY);
  const ratingFor = v => RATINGS[v < 25 ? 0 : v < 45 ? 1 : v < 55 ? 2 : v < 75 ? 3 : 4];

  function normalize(body, attemptedAt = new Date().toISOString()) {
    const index = body?.fear_and_greed;
    const data = body?.fear_and_greed_historical?.data;
    if (!index || !score(index.score) || !time(index.timestamp) || !Array.isArray(data) || data.length < 1 || data.length > 2000) {
      throw new TypeError('Invalid CNN response');
    }
    const asOf = new Date(index.timestamp).toISOString();
    if (Date.parse(asOf) > Date.parse(attemptedAt) + 5 * 60000) throw new TypeError('Future index timestamp');
    const history = new Map();
    const lastDay = utcEnd(asOf);
    for (const row of data) {
      if (!ms(row?.x) || !score(row?.y) || row.x > lastDay) throw new TypeError('Invalid CNN history');
      history.set(row.x, row.y);
    }
    const suppliedRating = RATINGS.find(r => r.toLowerCase() === String(index.rating ?? '').trim().toLowerCase());
    const comparisons = {};
    for (const [key, source] of Object.entries({ previous: 'previous_close', week: 'previous_1_week', month: 'previous_1_month' })) {
      comparisons[key] = score(index[source]) ? index[source] : null;
    }
    const floor = Date.parse(asOf) - 367 * DAY;
    const snapshot = { score: index.score, rating: suppliedRating ?? ratingFor(index.score), asOf, comparisons,
      history: [...history].filter(([t]) => t >= floor).sort(([a], [b]) => a - b) };
    return validate({ version: 1, source: SOURCE, attemptedAt, status: 'ok', snapshot });
  }

  function utcEnd(iso) {
    return Date.parse(dateKey(Date.parse(iso))) + DAY - 1;
  }

  function validate(v) {
    if (v?.version !== 1 || v.source !== SOURCE || !time(v.attemptedAt) ||
        !['ok', 'error'].includes(v.status) || (v.status === 'error' && !ERRORS.includes(v.error))) {
      throw new TypeError('Invalid published index');
    }
    const s = v.snapshot;
    if (v.status === 'error' && s === null) return v;
    if (!s || !score(s.score) || !RATINGS.includes(s.rating) || !time(s.asOf) ||
        Date.parse(s.asOf) > Date.parse(v.attemptedAt) + 5 * 60000 ||
        !s.comparisons || !['previous', 'week', 'month'].every(k => s.comparisons[k] === null || score(s.comparisons[k])) ||
        !Array.isArray(s.history) || s.history.length < 1 || s.history.length > 500) throw new TypeError('Invalid published snapshot');
    const end = utcEnd(s.asOf);
    let last = 0;
    for (const row of s.history) {
      if (!Array.isArray(row) || row.length !== 2 || !ms(row[0]) || !score(row[1]) || row[0] <= last || row[0] > end) {
        throw new TypeError('Invalid published history');
      }
      last = row[0];
    }
    return v;
  }

  function ny(t) {
    const parts = Object.fromEntries(dateFormat.formatToParts(t).map(({ type, value }) => [type, value]));
    return { day: parts.year + '-' + parts.month + '-' + parts.day, hour: +parts.hour };
  }

  function stale(snapshot, now = Date.now()) {
    if (!snapshot || Date.parse(snapshot.asOf) > now + 5 * 60000) return true;
    const current = ny(now);
    let expected = current.hour >= 18 ? current.day : previousDay(current.day);
    while (usClosed(expected)) expected = previousDay(expected);
    return ny(Date.parse(snapshot.asOf)).day < expected;
  }

  function series(snapshot, days) {
    const end = utcEnd(snapshot.asOf);
    const start = end - days * DAY + 1;
    return { start, end, rows: snapshot.history.filter(([t]) => t >= start && t <= end) };
  }

  const api = { SOURCE, ENDPOINT, RATINGS, normalize, validate, stale, series };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PMFearGreed = api;
})(globalThis);
