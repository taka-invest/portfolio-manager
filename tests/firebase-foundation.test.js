'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');

test('Firebase Hosting bundle publishes only vetted static pages and assets', () => {
  execFileSync(process.execPath, [path.join(root, 'scripts/build-firebase.mjs')], { cwd: root });
  const out = path.join(root, 'dist', 'firebase');
  for (const p of ['portfolio_manager.html', 'app/data.js', 'app/storage.js',
    'app/firebase-cloud.mjs', 'app/firebase-config.js', 'research/library.html']) {
    assert.ok(fs.existsSync(path.join(out, p)), 'not published: ' + p);
  }
  for (const p of ['package.json', 'firebase.json', 'firestore.rules',
    '.github', 'tests', 'docs', 'node_modules', 'functions']) {
    assert.equal(fs.existsSync(path.join(out, p)), false, 'secret/source leaked: ' + p);
  }
});
test('Firebase Hosting serves root app and only public static assets', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  assert.equal(config.hosting.public, 'dist/firebase');
  assert.deepEqual(config.hosting.rewrites.at(-1), { source: '/', destination: '/portfolio_manager.html' });
  // Cloud Functions are deployed (2026-11-24): /api routes go only to our own functions in Tokyo.
  for (const r of config.hosting.rewrites.slice(0, -1)) {
    assert.match(r.source, /^\/api\/(financials|analyze|screener|chart|market)$/);
    assert.equal(r.function.region, 'asia-northeast1');
  }
  assert.equal(config.firestore.rules, 'firestore.rules');
});
test('Firebase integration targets finance-base-edcc7, holds no secrets, and is opt-in and cloud data can only enter via reviewed importer', () => {
  const html = fs.readFileSync(path.join(root, 'portfolio_manager.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'app/firebase-cloud.mjs'), 'utf8');
  const cfg = fs.readFileSync(path.join(root, 'app/firebase-config.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'app/ui.js'), 'utf8');
  assert.ok(html.includes('id="pm-cloud-login"'));
  assert.ok(html.includes('id="pm-cloud-download"'));
  assert.ok(html.includes('src="app/firebase-cloud.mjs"'));
  assert.match(cfg, /projectId: 'finance-base-edcc7'/);
  assert.match(cfg, /authDomain: 'finance-base-edcc7\.firebaseapp\.com'/);
  assert.doesNotMatch(cfg, /private_key|client_secret|BEGIN PRIVATE|service_account/i);
  assert.match(client, /PMData\.validate\(remoteData\.payload\)/);
  assert.match(client, /PMApp\.previewImport\(payload/);
  assert.match(client, /getDocFromServer\(ref\(\)\)/);
  assert.match(client, /runTransaction/);
  assert.match(client, /actual !== old/);
  assert.match(client, /backupJson\(\)/);
  assert.match(client, /'backups'/);
  assert.match(client, /storageError\(\)/);
  assert.match(client, /canonical\(window\.PMData\.validate\(remoteData\.payload\)\) === canonical\(local\)/);
  assert.match(ui, /previewImport: preview/);
});
test('Security rules restrict portfolio to authenticated owner and disable deletes', () => {
  const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  assert.match(rules, /request\.auth\.uid == userId/);
  assert.match(rules, /allowlist\/\$\(request\.auth\.uid\)/);
  assert.match(rules, /allow list, write: if false/);
  assert.match(rules, /sign_in_provider == 'google\.com'/);
  assert.match(rules, /allow delete: if false/);
  assert.match(rules, /docId == 'portfolio'/);
  assert.doesNotMatch(rules, /allow (read|write): if true/);
});

test('allowlist registration script is valid and refuses non-Google or malformed UIDs', () => {
  const src = fs.readFileSync(path.join(root, 'scripts/allowlist-uid.mjs'), 'utf8');
  execFileSync(process.execPath, ['--check', path.join(root, 'scripts/allowlist-uid.mjs')]);
  assert.match(src, /providerId === 'google\.com'/);
  assert.match(src, /\^\[A-Za-z0-9\]\{20,128\}\$/);
  assert.doesNotMatch(src, /@gmail\.com|@maruyasu/);
});

test('deploy workflows: PRs reach only the preview channel; production is manual + approval-gated', () => {
  const verify = fs.readFileSync(path.join(root, '.github/workflows/verify.yml'), 'utf8');
  const prod = fs.readFileSync(path.join(root, '.github/workflows/firebase-production.yml'), 'utf8');
  assert.match(verify, /needs: verify/);
  assert.match(verify, /channelId: preview/);
  assert.doesNotMatch(verify, /channelId: live/);
  assert.match(verify, /head\.repo\.full_name == github\.repository/);
  const triggers = prod.slice(prod.indexOf('\non:'), prod.indexOf('\npermissions:'));
  assert.match(triggers, /workflow_dispatch/);
  assert.doesNotMatch(triggers, /\bpush\b|pull_request|schedule/);
  assert.match(prod, /github\.ref == 'refs\/heads\/main' && inputs\.confirm == 'DEPLOY'/);
  assert.match(prod, /needs: test/);
  assert.match(prod, /name: production/);
  assert.match(prod, /channelId: live/);
});

test('emulator config mirrors production; /api routes go only to Tokyo functions', () => {
  const prod = JSON.parse(fs.readFileSync(path.join(root, 'firebase.json'), 'utf8'));
  const emu = JSON.parse(fs.readFileSync(path.join(root, 'firebase.emulator.json'), 'utf8'));
  assert.deepEqual(prod.hosting.rewrites, emu.hosting.rewrites);
  const api = emu.hosting.rewrites.filter(r => r.source.startsWith('/api/'));
  assert.deepEqual(api.map(r => r.function.region), Array(5).fill('asia-northeast1'));
  assert.deepEqual(emu.hosting.rewrites.at(-1), { source: '/', destination: '/portfolio_manager.html' });
  const strip = c => ({ ...c, hosting: { ...c.hosting, rewrites: [] }, emulators: { ...c.emulators, hosting: undefined } });
  assert.deepEqual(JSON.parse(JSON.stringify(strip(emu))), JSON.parse(JSON.stringify(strip(prod))));
  const client = fs.readFileSync(path.join(root, 'app/firebase-cloud.mjs'), 'utf8');
  assert.match(client, /location\.port === '5000'/);
  assert.match(client, /projectId: 'demo-finance-base'/);
});
