#!/usr/bin/env node
// Cut grokui + openzoo version strings. grokui-app's openzoo dep stays
// "latest" so the next pack resolves whatever npm currently publishes.
//
//   node scripts/cut-grokui.mjs --openzoo 0.49.6 --grokui 1.5.84
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXACT = /^\d+\.\d+\.\d+$/;

function die(msg) {
  console.error(`[cut-grokui] ${msg}`);
  process.exit(1);
}

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

function writeJson(rel, obj) {
  writeFileSync(path.join(root, rel), JSON.stringify(obj, null, 2) + '\n');
}

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--openzoo' || args[i] === '--grokui') {
    opts[args[i].slice(2)] = args[++i];
  } else {
    die(`unknown arg ${args[i]} — need --openzoo <ver> AND --grokui <ver>`);
  }
}

if (!opts.openzoo || !opts.grokui) {
  die('refuse to cut: pass both --openzoo <ver> and --grokui <ver>');
}
if (!EXACT.test(opts.openzoo) || !EXACT.test(opts.grokui)) {
  die(`refuse to cut: versions must be exact x.y.z, got openzoo=${opts.openzoo} grokui=${opts.grokui}`);
}

const rootPkg = readJson('package.json');
const appPkg = readJson('grokui-app/package.json');
const rootLock = readJson('package-lock.json');
const appLock = readJson('grokui-app/package-lock.json');

rootPkg.version = opts.openzoo;
appPkg.version = opts.grokui;
appPkg.dependencies.openzoo = 'latest';
rootLock.version = opts.openzoo;
if (rootLock.packages?.['']) rootLock.packages[''].version = opts.openzoo;
appLock.version = opts.grokui;
if (appLock.packages?.['']) {
  appLock.packages[''].version = opts.grokui;
  appLock.packages[''].dependencies.openzoo = 'latest';
}

writeJson('package.json', rootPkg);
writeJson('grokui-app/package.json', appPkg);
writeJson('package-lock.json', rootLock);
writeJson('grokui-app/package-lock.json', appLock);

if (appPkg.dependencies.openzoo !== 'latest') {
  die('refuse to cut: grokui-app openzoo dep must stay "latest"');
}

const pin = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-grokui-pin.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (pin.status !== 0) {
  die('refuse to cut: grokui-app openzoo dep is not "latest"');
}

const bundle = spawnSync(process.execPath, [path.join(root, 'grokui-app', 'scripts', 'bundle-grokui.js')], {
  cwd: root,
  stdio: 'inherit',
});
if (bundle.status !== 0) {
  die('refuse to cut: bundle-grokui failed');
}

const packedLib = path.join(root, 'grokui-app', 'lib');
const esm = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-grokui-esm.mjs'), packedLib], {
  cwd: root,
  encoding: 'utf8',
});
if (esm.stdout) process.stdout.write(esm.stdout);
if (esm.status !== 0) {
  process.stderr.write(esm.stderr || '');
  die('refuse to cut: packed lib/package.json missing or not type module, or dry import failed');
}

const overlay = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-overlaid-openzoo.mjs')], {
  cwd: root,
  encoding: 'utf8',
});
if (overlay.stdout) process.stdout.write(overlay.stdout);
if (overlay.status !== 0) {
  process.stderr.write(overlay.stderr || '');
  die('refuse to cut: afterPack overlay list is missing sidecar files');
}

const packedOz = spawnSync(process.execPath, [path.join(root, 'scripts', 'assert-packed-openzoo-lib.mjs')], {
  cwd: root,
  encoding: 'utf8',
});
if (packedOz.stdout) process.stdout.write(packedOz.stdout);
if (packedOz.status !== 0) {
  process.stderr.write(packedOz.stderr || '');
  die('refuse to cut: afterPack packed openzoo lib assert is missing think.js');
}

console.log(`cut grokui ${opts.grokui} / openzoo ${opts.openzoo} (app dep stays latest)`);
