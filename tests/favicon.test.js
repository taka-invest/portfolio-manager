'use strict';
// Favicon set: SVG (sharp at any size), /favicon.ico (16/32/48 for browsers that ask for it),
// Apple touch icon and a web manifest; every page links them and the build publishes them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const read = p => readFileSync(join(root, p));

test('icon files are valid and sized as declared', () => {
  const ico = read('favicon.ico');
  assert.equal(ico.readUInt16LE(2), 1);                 // icon resource
  const sizes = [...Array(ico.readUInt16LE(4))].map((_, i) => ico.readUInt8(6 + 16 * i) || 256);
  assert.deepEqual(sizes, [16, 32, 48]);
  const pngSize = p => { const b = read(p); assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a', p); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
  assert.deepEqual(pngSize('app/icons/apple-touch-icon.png'), [180, 180]);
  assert.deepEqual(pngSize('app/icons/icon-192.png'), [192, 192]);
  assert.deepEqual(pngSize('app/icons/icon-512.png'), [512, 512]);
  assert.match(read('app/icons/favicon.svg').toString(), /^<svg [^>]*viewBox="0 0 64 64"/);
  const m = JSON.parse(read('app/icons/site.webmanifest'));
  for (const i of m.icons) assert.ok(existsSync(join(root, i.src.slice(1))), i.src);
});

test('every page links the icons; the build publishes /favicon.ico', () => {
  for (const p of ['portfolio_manager.html', 'research/index.html', 'research/library.html', 'research/screener.html']) {
    const s = read(p).toString();
    for (const href of ['/favicon.ico', '/app/icons/favicon.svg', '/app/icons/apple-touch-icon.png', '/app/icons/site.webmanifest'])
      assert.ok(s.includes(`href="${href}"`), p + ' ' + href);
  }
  assert.match(read('scripts/build-firebase.mjs').toString(), /'favicon\.ico'/);
});
