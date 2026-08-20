#!/usr/bin/env node
// Walk static ESM relative specifiers (from './…' / import './…') and fail
// if any target is missing. node --check is syntax-only and would not have
// caught a two-file /opt/grokui copy that omitted livestatus.js.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const entry = process.argv[2];
if (!entry) {
  console.error('usage: assert-esm-relatives.mjs <entry-file>');
  process.exit(2);
}

const REL = /(?:from|import)\s+['"](\.[^'"]+)['"]/g;
const seen = new Set();
const missing = [];

function walk(file) {
  const abs = isAbsolute(file) ? file : resolve(file);
  if (seen.has(abs)) return;
  seen.add(abs);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    missing.push(abs);
    return;
  }
  let src;
  try { src = readFileSync(abs, 'utf8'); }
  catch { missing.push(abs); return; }
  const dir = dirname(abs);
  for (const m of src.matchAll(REL)) {
    walk(resolve(dir, m[1]));
  }
}

walk(entry);
if (missing.length) {
  console.error(`missing relative imports from ${entry}:`);
  for (const f of missing) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`ok: ${seen.size} files reachable from ${entry}`);
