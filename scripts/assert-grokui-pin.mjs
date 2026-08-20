#!/usr/bin/env node
// Fail the build if grokui-app does not depend on the npm dist-tag "latest".
// A caret on 0.x (and an exact leftover 0.48.x lock) is how every dmg/exe
// after 1.5.78 shipped last week's sidecar.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(root, rel), 'utf8'));
}

function fail(msg) {
  console.error(`[assert-grokui-pin] ${msg}`);
  process.exit(1);
}

const appPkg = readJson('grokui-app/package.json');
const appLock = readJson('grokui-app/package-lock.json');

const pin = appPkg.dependencies?.openzoo;
if (pin !== 'latest') {
  fail(`grokui-app dependencies.openzoo must be "latest", got ${JSON.stringify(pin)}`);
}
const lockPin = appLock.packages?.['']?.dependencies?.openzoo;
if (lockPin !== 'latest') {
  fail(`grokui-app lockfile openzoo dep ${JSON.stringify(lockPin)} !== "latest"`);
}

console.log('grokui-app openzoo dep is latest');
