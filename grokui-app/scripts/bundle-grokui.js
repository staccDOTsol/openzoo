#!/usr/bin/env node
// Copy the live UI into the Electron package so a packaged .app never
// ships a stale grokui-app/lib snapshot. lib/ is the source — the ENTIRE
// directory. A filename whitelist omitted info.js / hrr.js / spill.js /
// subscription.js and left 1.5.86 on "starting…" forever
// (ERR_MODULE_NOT_FOUND for lib/info.js). Same class of bug as the
// docker-box two-file copy.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', '..', 'lib');
const destDir = path.join(__dirname, '..', 'lib');
if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
  console.error(`[bundle-grokui] missing ${srcDir}`);
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
// Replace dest with a full copy so leftover files from an older whitelist
// cannot mask a missing new import, and so we never ship a partial tree.
for (const name of fs.readdirSync(destDir)) {
  fs.rmSync(path.join(destDir, name), { recursive: true, force: true });
}
fs.cpSync(srcDir, destDir, { recursive: true });
const copied = fs.readdirSync(destDir);
if (!copied.includes('grokui.mjs')) {
  console.error('[bundle-grokui] dest is missing grokui.mjs after copy');
  process.exit(1);
}
console.log(`[bundle-grokui] ${srcDir} -> ${destDir} (${copied.length} files)`);

const walker = path.join(__dirname, '..', '..', 'scripts', 'assert-esm-relatives.mjs');
const entry = path.join(destDir, 'grokui.mjs');
const r = spawnSync(process.execPath, [walker, entry], { encoding: 'utf8' });
if (r.stdout) process.stdout.write(r.stdout);
if (r.status !== 0) {
  process.stderr.write(r.stderr || '[bundle-grokui] assert-esm-relatives failed\n');
  process.exit(r.status || 1);
}
