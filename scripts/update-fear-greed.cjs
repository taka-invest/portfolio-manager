'use strict';

const { readFile, writeFile, mkdir, rename } = require('node:fs/promises');
const path = require('node:path');
const model = require('../app/fear-greed.js');

async function collect(previous, fetcher, now = new Date().toISOString()) {
  let code = 'network';
  try {
    const response = await fetcher();
    if (!response.ok) {
      code = [401, 403, 418, 429].includes(response.status) ? 'access-denied' : 'http';
      throw new Error();
    }
    code = 'format';
    const next = model.normalize(await response.json(), now);
    if (previous?.snapshot && Date.parse(next.snapshot.asOf) < Date.parse(previous.snapshot.asOf)) throw new Error();
    return next;
  } catch (error) {
    if (['AbortError', 'TimeoutError'].includes(error.name)) code = 'timeout';
    return { version: 1, source: model.SOURCE, attemptedAt: now, status: 'error', error: code, snapshot: previous?.snapshot ?? null };
  }
}

async function main() {
  if (process.env.CNN_FG_DATA_AUTHORIZED !== 'true' || !process.env.CNN_FG_APPROVED_URL) {
    throw new Error('CNN-approved automated access and publication must be configured.');
  }
  const endpoint = new URL(process.env.CNN_FG_APPROVED_URL);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('An approved HTTPS endpoint is required.');
  }
  const out = process.argv[2];
  if (!out) throw new Error('Provide the output JSON path.');
  let previous;
  try { previous = model.validate(JSON.parse(await readFile(out, 'utf8'))); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Existing snapshot could not be validated.'); }
  const data = await collect(previous, () => fetch(endpoint, { signal: AbortSignal.timeout(15000), redirect: 'error',
    headers: { Accept: 'application/json' } }));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out + '.tmp', JSON.stringify(model.validate(data), null, 2) + '\n');
  await rename(out + '.tmp', out);
  if (data.status === 'error') {
    console.error('Fear & Greed collection failed (' + data.error + '). Last valid snapshot retained when available.');
    return 2;
  }
  return 0;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
module.exports = { collect };
