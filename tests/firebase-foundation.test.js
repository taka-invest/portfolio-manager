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
  assert.deepEqual(config.hosting.rewrites, [{ source: '/', destination: '/portfolio_manager.html' }]);
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
