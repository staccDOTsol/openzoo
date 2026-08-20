#!/usr/bin/env node
// Fail if packed node_modules/openzoo/lib is a cut that ships livestatus.js
// without think.js. `node -e "import('./lib/livestatus.js')"` must resolve.
//
//   node scripts/assert-packed-openzoo-lib.mjs
//     source check: afterPack required list includes think.js / whole lib
//   node scripts/assert-packed-openzoo-lib.mjs <dist-or-openzoo-dir>
//     walk for node_modules/openzoo and run assertPackedOpenzooLib
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);
const afterPack = require(join(root, 'grokui-app', 'build', 'afterPack.js'));

function fail(msg) {
  console.error(`[assert-packed-openzoo-lib] ${msg}`);
  process.exit(1);
}

const required = afterPack.OPENZOO_SIDECAR_REQUIRED;
if (!Array.isArray(required) || !required.includes('lib/think.js')) {
  fail('afterPack.OPENZOO_SIDECAR_REQUIRED must include lib/think.js');
}
for (const rel of ['lib/livestatus.js', 'lib/relay.js', 'lib/claudecode.js', 'bin/openzoo.js']) {
  if (!required.includes(rel)) fail(`required list missing ${rel}`);
}
const overlay = afterPack.OPENZOO_SIDECAR_OVERLAY;
if (!Array.isArray(overlay) || !overlay.includes('lib/think.js')) {
  fail('OPENZOO_SIDECAR_OVERLAY must include the whole lib (think.js missing)');
}
if (typeof afterPack.overlayRepoOpenzooSidecar !== 'function') {
  fail('overlayRepoOpenzooSidecar missing');
}
if (typeof afterPack.assertPackedOpenzooLib !== 'function') {
  fail('assertPackedOpenzooLib missing');
}
console.log('overlay / required list includes think.js and the sidecar entry');

const start = process.argv[2];
if (!start) process.exit(0);
if (!existsSync(start)) fail(`packed tree missing: ${start}`);

function walk(dir, found) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const isNM = /(?:^|[\\/])node_modules$/.test(dir);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === '.git' || e.name === 'Frameworks' || e.name === 'System') continue;
    const full = join(dir, e.name);
    if (isNM) {
      if (e.name === 'openzoo') found.push(full);
      continue;
    }
    walk(full, found);
  }
}

const found = [];
if (statSync(start).isDirectory()) {
  const pkg = join(start, 'package.json');
  if (existsSync(pkg)) {
    try {
      const name = JSON.parse(readFileSync(pkg, 'utf8')).name;
      if (name === 'openzoo') found.push(start);
    } catch { /* walk instead */ }
  }
  if (!found.length) walk(start, found);
}

if (!found.length) fail(`no packed node_modules/openzoo under ${start}`);

let failed = 0;
for (const dest of found) {
  try {
    afterPack.assertPackedOpenzooLib(dest);
    console.log(`ok packed openzoo lib: ${dest}`);
  } catch (e) {
    console.error(e.message || e);
    console.error(`FAIL: packed openzoo lib is incomplete: ${dest}`);
    failed = 1;
  }
}
process.exit(failed);
