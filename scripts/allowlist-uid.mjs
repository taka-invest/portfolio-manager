// Register (or disable) a Firebase Auth UID in Firestore /allowlist/{uid}.
// Clients can never write the allowlist (see firestore.rules); this script uses
// the Firebase CLI login of a project Owner/Editor, which bypasses rules.
//
//   node scripts/allowlist-uid.mjs <uid> [--disable] [--note "text"]
//
// The UID is verified to exist in Firebase Authentication and to have signed in
// with Google before it is enabled. Never pass emails or other PII as the note.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const auth = require('firebase-tools/lib/auth.js');
const { requireAuth } = require('firebase-tools/lib/requireAuth.js');
const { Client } = require('firebase-tools/lib/apiv2.js');

const PROJECT = 'finance-base-edcc7';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const uid = args.find(a => !a.startsWith('--'));
const disable = args.includes('--disable');
const noteIdx = args.indexOf('--note');
const note = noteIdx >= 0 ? String(args[noteIdx + 1] || '').slice(0, 80) : 'owner';
if (!uid || !/^[A-Za-z0-9]{20,128}$/.test(uid)) {
  console.error('Usage: node scripts/allowlist-uid.mjs <uid> [--disable] [--note "text"]');
  process.exit(2);
}

const account = auth.selectAccount(undefined, root);
if (!account) { console.error('Firebase CLI is not logged in for this directory.'); process.exit(1); }
await requireAuth({ user: account.user, tokens: account.tokens, projectDir: root });

// 1. Confirm the UID is a real Google-sign-in user of this project.
const idt = new Client({ urlPrefix: 'https://identitytoolkit.googleapis.com', auth: true, apiVersion: 'v1' });
const lookup = await idt.post(`/projects/${PROJECT}/accounts:lookup`, { localId: [uid] });
const user = lookup.body.users?.[0];
if (!user) { console.error('UID not found in Firebase Authentication: ' + uid); process.exit(1); }
const google = (user.providerUserInfo || []).some(p => p.providerId === 'google.com');
if (!google && !disable) { console.error('UID has not signed in with Google; refusing.'); process.exit(1); }

// 2. Write /allowlist/{uid}.
const fs = new Client({ urlPrefix: 'https://firestore.googleapis.com', auth: true, apiVersion: 'v1' });
const path = `/projects/${PROJECT}/databases/(default)/documents/allowlist/${uid}`;
await fs.patch(path, {
  fields: {
    enabled: { booleanValue: !disable },
    note: { stringValue: note },
    updatedAt: { timestampValue: new Date().toISOString() }
  }
});
const check = await fs.get(path);
console.log(`allowlist/${uid}: enabled=${check.body.fields.enabled.booleanValue} (project ${PROJECT})`);
