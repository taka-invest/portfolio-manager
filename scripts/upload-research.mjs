// Upload an aggregated research result (research-engine output) to the owner's
// private Firestore document users/{uid}/research/{id}. Clients can only read it
// (firestore.rules); this script uses the Firebase CLI login of a project Owner/Editor.
//
//   node scripts/upload-research.mjs data/results/vix_event_study_p0b-1.json [--uid <uid>] [--dry-run]
//
// The UID is never guessed: without --uid it is taken only when exactly ONE enabled
// allowlist entry exists. Only the result file is sent (aggregates and per-event
// index returns), never the raw downloaded series.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const PROJECT = 'finance-base-edcc7';
// Result version prefix -> document id and the fields such a result must have.
const TYPES = {
  p0b: { id: 'vix-event-study', keys: ['summary', 'perEvent'] },
  p0c: { id: 'market-regime', keys: ['groups', 'current'] }
};
const MAX_BYTES = 900_000;
const root = resolve(import.meta.dirname, '..');

export function docId(result) {
  const m = /^(p0[bc])-\d+$/.exec(String(result?.version));
  if (!m) throw new Error('unexpected version ' + result?.version);
  return TYPES[m[1]].id;
}

export function prepare(result) {
  const m = /^(p0[bc])-\d+$/.exec(String(result?.version));
  if (!m) throw new Error('unexpected version ' + result?.version);
  for (const k of ['version', 'params', 'dates', 'computedAt', ...TYPES[m[1]].keys])
    if (result[k] == null) throw new Error('not a research result: missing ' + k);
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > MAX_BYTES) throw new Error('result too large for one document');
  return {
    fields: {
      version: { stringValue: result.version },
      computedAt: { timestampValue: result.computedAt },
      dataThrough: { stringValue: result.dates[1] },
      json: { stringValue: json }
    }
  };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const uidIdx = args.indexOf('--uid');
  const dry = args.includes('--dry-run');
  if (!file) { console.error('Usage: node scripts/upload-research.mjs <result.json> [--uid <uid>] [--dry-run]'); process.exit(2); }
  const result = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const body = prepare(result);
  const ID = docId(result);

  const auth = require('firebase-tools/lib/auth.js');
  const { requireAuth } = require('firebase-tools/lib/requireAuth.js');
  const { Client } = require('firebase-tools/lib/apiv2.js');
  const account = auth.selectAccount(undefined, root);
  if (!account) { console.error('Firebase CLI is not logged in for this directory.'); process.exit(1); }
  await requireAuth({ user: account.user, tokens: account.tokens, projectDir: root });
  const fs = new Client({ urlPrefix: 'https://firestore.googleapis.com', auth: true, apiVersion: 'v1' });
  const base = `/projects/${PROJECT}/databases/(default)/documents`;

  let uid = uidIdx >= 0 ? args[uidIdx + 1] : null;
  if (!uid) {
    const list = await fs.get(`${base}/allowlist?pageSize=50`);
    const enabled = (list.body.documents || []).filter(d => d.fields?.enabled?.booleanValue === true);
    if (enabled.length !== 1) { console.error(`${enabled.length} enabled allowlist entries; pass --uid explicitly.`); process.exit(1); }
    uid = enabled[0].name.split('/').pop();
  }
  if (!/^[A-Za-z0-9]{20,128}$/.test(uid)) { console.error('invalid uid'); process.exit(2); }
  const path = `${base}/users/${uid}/research/${ID}`;
  console.log(`${dry ? '[dry-run] ' : ''}users/<owner>/research/${ID}: version ${body.fields.version.stringValue}, data through ${body.fields.dataThrough.stringValue}, ${Buffer.byteLength(body.fields.json.stringValue)} bytes`);
  if (dry) return;
  await fs.patch(path, body);
  const check = await fs.get(path);
  console.log('stored version', check.body.fields.version.stringValue, '(project ' + PROJECT + ')');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
