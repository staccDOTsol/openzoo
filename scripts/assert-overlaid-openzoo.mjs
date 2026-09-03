#!/usr/bin/env node
// Fail if packed node_modules/openzoo is not the afterPack overlay tree.
// copyRepoLib → app/lib is the grokui UI; the sidecar is
// node_modules/openzoo/lib/*.js. A version pin on "latest" still ships
// npm's 16k spill unless those files are bit-identical to the repo.
//
//   node scripts/assert-overlaid-openzoo.mjs
//     source check: afterPack overlay list includes the required sidecar files
//   node scripts/assert-overlaid-openzoo.mjs <dist-or-app-dir>
//     walk for node_modules/openzoo and bit-compare the overlay list
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);
const afterPack = require(join(root, 'grokui-app', 'build', 'afterPack.js'));

const REQUIRED = [
  'lib/spill.js',
  'lib/runguard.js',
  'lib/racesettle.js',
  'lib/hrr.js',
  'lib/livestatus.js',
  'lib/grokcli.js',
  'lib/grokbotFetch.js',
  'lib/openzooPathShim.js',
  'lib/cursorbackend.js',
  'lib/cursorapi.js',
  'lib/grokbotAccount.js',
];

function fail(msg) {
  console.error(`[assert-overlaid-openzoo] ${msg}`);
  process.exit(1);
}

const list = afterPack.OPENZOO_SIDECAR_OVERLAY;
if (!Array.isArray(list) || !list.length) {
  fail('afterPack.OPENZOO_SIDECAR_OVERLAY is empty');
}
const missing = REQUIRED.filter((rel) => !list.includes(rel));
if (missing.length) {
  fail(`overlay list missing sidecar files: ${missing.join(', ')}`);
}
console.log('overlay list includes required sidecar files');

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

if (!found.length) {
  fail(`no packed node_modules/openzoo under ${start}`);
}

let failed = 0;
for (const dest of found) {
  try {
    afterPack.assertOverlaidOpenzoo(dest, root);
    console.log(`ok overlaid: ${dest}`);
  } catch (e) {
    console.error(e.message || e);
    console.error(`FAIL: packed openzoo is not the overlaid tree: ${dest}`);
    failed = 1;
  }
}
process.exit(failed);
