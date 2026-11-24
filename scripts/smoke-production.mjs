// Production smoke test (read-only, no login, no personal data).
//   node scripts/smoke-production.mjs [https://finance-base-edcc7.web.app]
// Checks: public files served, private files hidden, security headers, every /api
// route reaches our functions and refuses unauthenticated / unsigned requests.
const base = (process.argv[2] || 'https://finance-base-edcc7.web.app').replace(/\/$/, '');
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

async function status(path, init) {
  const res = await fetch(base + path, { redirect: 'manual', ...init });
  return res;
}

for (const p of ['/', '/portfolio_manager.html', '/app/legacy-shim.js', '/research/index.html', '/research/screener.html', '/app/price-chart.js',
  '/app/market-data.js', '/app/api.js', '/app/firebase-config.js', '/research/library.html']) {
  const r = await status(p);
  check('public ' + p, r.status === 200, String(r.status));
}
for (const p of ['/firebase.json', '/firestore.rules', '/package.json', '/functions/src/index.js', '/functions/.env',
  '/tests/analysis.spec.js', '/docs/MIGRATION_PROGRESS.md', '/.firebaserc', '/.github/workflows/verify.yml']) {
  const r = await status(p);
  check('hidden ' + p, r.status === 404, String(r.status));
}
const html = await status('/portfolio_manager.html');
check('header X-Frame-Options DENY', html.headers.get('x-frame-options') === 'DENY');
check('header nosniff', html.headers.get('x-content-type-options') === 'nosniff');
check('header HTML no-store', /no-store/.test(html.headers.get('cache-control') || ''));
for (const asset of ['/app/styles.css', '/app/legacy-shim.js', '/app/firebase-cloud.mjs']) {
  const r = await status(asset);
  check('revalidated asset ' + asset, /no-cache|no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control') || 'none');
}
const page = await html.text();
check('10-item navigation present', (page.match(/data-pm-view="/g) || []).length >= 11);

for (const [path, init] of [
  ['/api/financials?ticker=PLTR'], ['/api/analyze?ticker=PLTR'], ['/api/chart?ticker=NVDA'],
  ['/api/market?kind=feargreed'], ['/api/screener', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"tickers":["PLTR"]}' }]
]) {
  const none = await status(path, init);
  const body = await none.json().catch(() => null);
  check('api no-token 401 ' + path, none.status === 401 && body?.error === 'Google login required', String(none.status));
  check('api private no-store ' + path, /private, no-store/.test(none.headers.get('cache-control') || ''));
  check('api no CORS ' + path, !none.headers.get('access-control-allow-origin'));
  const unsigned = await status(path, { ...(init || {}), headers: { ...(init?.headers || {}), Authorization: 'Bearer aaa.bbb.' } });
  check('api unsigned-token 401 ' + path, unsigned.status === 401, String(unsigned.status));
}

const failed = results.filter(r => !r.ok);
for (const r of results) console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.detail && !r.ok ? ' (' + r.detail + ')' : ''));
console.log(`\n${results.length - failed.length}/${results.length} passed — ${base}`);
process.exit(failed.length ? 1 : 0);
