'use strict';
// P0-A research data: raw market data must never enter this PUBLIC repository
// (FRED pre-approval series / Cboe / ICE may not be redistributed), and the Python
// fetcher's own tests pass when Python is available.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');

test('raw research data is git-ignored and nothing under data/ is tracked', () => {
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\/data\/$/m);
  const ignored = spawnSync('git', ['check-ignore', '-q', 'data/raw/fred/VIXCLS.csv'], { cwd: root });
  assert.equal(ignored.status, 0, 'data/raw/fred/VIXCLS.csv must be ignored');
  const tracked = execFileSync('git', ['ls-files', 'data'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(tracked, '');
  for (const f of execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n'))
    assert.doesNotMatch(f, /(VIXCLS|NASDAQ100|NASDAQCOM|DEXJPUS)\.csv$/, f);
});

test('the fetcher sends no personal contact and only reaches FRED', () => {
  const src = readFileSync(join(root, 'research-engine/fetch_fred.py'), 'utf8');
  assert.doesNotMatch(src, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
  const hosts = [...src.matchAll(/https?:\/\/([^/"'\s]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(hosts)], ['fred.stlouisfed.org']);
});

test('Python unit tests for the fetcher (skipped when Python/pandas is not installed)', t => {
  const py = ['python3', 'python'].find(p => spawnSync(p, ['-c', 'import pandas'], { cwd: root }).status === 0);
  if (!py) return t.skip('python with pandas not available');
  const r = spawnSync(py, ['-m', 'unittest', 'discover', '-s', 'research-engine/tests'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
