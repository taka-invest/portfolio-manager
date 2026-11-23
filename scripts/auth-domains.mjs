// List or add Firebase Authentication authorized domains (needed for Google
// sign-in on Hosting preview channels, which are not authorized by default).
//   node scripts/auth-domains.mjs                 # list
//   node scripts/auth-domains.mjs --add <domain>  # add one exact domain
// Uses the Firebase CLI login of a project Owner/Editor for this directory.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const auth = require('firebase-tools/lib/auth.js');
const { requireAuth } = require('firebase-tools/lib/requireAuth.js');
const { Client } = require('firebase-tools/lib/apiv2.js');

const PROJECT = 'finance-base-edcc7';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const add = args[0] === '--add' ? String(args[1] || '').toLowerCase() : null;
// Only this project's Hosting domains may be added by this script.
const ALLOWED = new RegExp('^' + PROJECT + '(--[a-z0-9-]+)?\\.web\\.app$');
if (args[0] === '--add' && !ALLOWED.test(add)) {
  console.error('Refusing: only ' + PROJECT + '[--channel].web.app domains can be added.');
  process.exit(2);
}

const account = auth.selectAccount(undefined, root);
if (!account) { console.error('Firebase CLI is not logged in for this directory.'); process.exit(1); }
await requireAuth({ user: account.user, tokens: account.tokens, projectDir: root });
const api = new Client({ urlPrefix: 'https://identitytoolkit.googleapis.com', auth: true, apiVersion: 'v2' });
const path = `/projects/${PROJECT}/config`;
const config = (await api.get(path)).body;
let domains = config.authorizedDomains || [];
if (add && !domains.includes(add)) {
  domains = [...domains, add];
  await api.patch(path, { authorizedDomains: domains }, { queryParams: { updateMask: 'authorizedDomains' } });
  domains = (await api.get(path)).body.authorizedDomains;
}
console.log(domains.join('\n'));
