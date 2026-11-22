'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const model = require('../app/fear-greed.js');
const { collect } = require('../scripts/update-fear-greed.cjs');

const attempted = '2026-11-20T23:23:00.000Z';
const asOf = '2026-11-20T21:00:00.000Z';
const t = value => Date.parse(value);
function sample(overrides = {}) {
  return {
    fear_and_greed: { score: 0, rating: 'extreme fear', timestamp: asOf,
      previous_close: 15, previous_1_week: 21, previous_1_month: 37, ...overrides },
    fear_and_greed_historical: { data: [
      { x: t('2026-11-20'), y: 0 }, { x: t('2026-08-28'), y: 65 },
      { x: t('2026-11-19'), y: 15 }, { x: t('2026-01-05'), y: 35 }
    ] }
  };
}
const good = fetchBody => async () => ({ ok: true, json: async () => fetchBody });

test('normalizes the score including zero, CNN rating, dates, comparisons and ordered chart windows', () => {
  const published = model.normalize(sample(), attempted);
  assert.equal(published.snapshot.score, 0);
  assert.equal(published.snapshot.rating, 'Extreme Fear');
  assert.equal(published.snapshot.asOf, asOf);
  assert.deepEqual(published.snapshot.comparisons, { previous: 15, week: 21, month: 37 });
  assert.deepEqual([30, 90, 365].map(d => model.series(published.snapshot, d).rows.length), [2, 3, 4]);
  assert.equal(model.normalize(sample({ score: 100, rating: '' }), attempted).snapshot.rating, 'Extreme Greed');
});

test('rejects changed CNN schema, bad timestamp and malformed values', () => {
  for (const raw of [
    { index: { score: 50 } },
    sample({ score: '50' }),
    sample({ score: 101 }),
    sample({ timestamp: 'invalid' }),
    sample({ timestamp: '2026-11-21T21:00:00Z' }),
    { ...sample(), fear_and_greed_historical: { data: [{ x: 100, y: 50 }] } }
  ]) assert.throws(() => model.normalize(raw, attempted));
  assert.throws(() => model.validate({ ...model.normalize(sample(), attempted), version: 2 }));
});

test('Friday stays fresh through weekend and until Monday evening New York time', () => {
  const { snapshot } = model.normalize(sample(), attempted);
  for (const now of ['2026-11-21T22:00:00Z', '2026-11-22T12:00:00Z', '2026-11-23T22:59:00Z']) {
    assert.equal(model.stale(snapshot, t(now)), false);
  }
  assert.equal(model.stale(snapshot, t('2026-11-23T23:00:00Z')), true);
});

test('US holiday and short session use the exchange calendar', () => {
  const thanksgiving = { asOf: '2026-11-25T21:00:00.000Z' };
  assert.equal(model.stale(thanksgiving, t('2026-11-26T23:10:00Z')), false);
  assert.equal(model.stale(thanksgiving, t('2026-11-27T22:10:00Z')), false);
  assert.equal(model.stale(thanksgiving, t('2026-11-27T23:10:00Z')), true);
  assert.equal(model.stale({ asOf: '2026-11-27T18:00:00.000Z' }, t('2026-11-29T12:00:00Z')), false);
});

test('collector keeps the last valid sample after denial, network outage, timeout and schema changes', async () => {
  const previous = await collect(null, good(sample()), attempted);
  const attempts = [
    ['access-denied', async () => ({ ok: false, status: 418 })],
    ['network', async () => { throw new TypeError(); }],
    ['timeout', async () => { throw new DOMException('expired', 'TimeoutError'); }],
    ['format', good({ unexpected: true })],
    ['format', good(sample({ timestamp: '2026-11-19T21:00:00Z' }))]
  ];
  for (const [error, fetcher] of attempts) {
    const result = model.validate(await collect(previous, fetcher, '2026-11-23T23:23:00Z'));
    assert.equal(result.status, 'error');
    assert.equal(result.error, error);
    assert.equal(result.snapshot, previous.snapshot);
  }
  const failed = await collect(null, attempts[0][1], attempted);
  assert.equal(model.validate(failed).snapshot, null);
});
