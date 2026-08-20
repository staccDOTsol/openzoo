#!/usr/bin/env node
// Fail if a packed grokui-app tree is missing grokui.mjs's relative imports.
// Walks every …/lib/grokui.mjs under the given dist/app dir (mac .app,
// linux-unpacked, win-unpacked). A filename check for livestatus.js alone
// would have shipped 1.5.86 — that dmg had livestatus.js and still died
// on info.js.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const walker = join(root, 'scripts', 'assert-esm-relatives.mjs');
const start = process.argv[2];
if (!start) {
  console.error('usage: assert-packed-grokui-lib.mjs <dist-or-app-dir>');
  process.exit(2);
}

function walk(dir, found) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(full, found);
    } else if (e.name === 'grokui.mjs' && /(?:^|[/\\])lib[/\\]grokui\.mjs$/.test(full)) {
      found.push(full);
    }
  }
}

if (!existsSync(start)) {
  console.error(`packed tree missing: ${start}`);
  process.exit(1);
}
const found = [];
if (statSync(start).isFile()) found.push(start);
else walk(start, found);
if (!found.length) {
  console.error(`no packed lib/grokui.mjs under ${start}`);
  process.exit(1);
}
let failed = 0;
for (const entry of found) {
  const r = spawnSync(process.execPath, [walker, entry], { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) {
    process.stderr.write(r.stderr || '');
    console.error(`FAIL: packed relatives missing next to ${entry}`);
    failed = 1;
  } else {
    console.log(`ok packed: ${entry}`);
  }
}
process.exit(failed);
