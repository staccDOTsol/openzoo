#!/usr/bin/env node
// Fail if a packed grokui lib/ is missing package.json {"type":"module"}
// or if a dry named-import of grokui.mjs's .js relatives throws
// ERR_MODULE_NOT_FOUND / "is a CommonJS module".
//
// Repo root package.json is already "type":"module", so lib/*.js is ESM in
// a checkout. The packaged tree lives under grokui-app (CJS — main.js is
// require()), so without a package.json INSIDE lib/, Node treats
// livestatus.js as CommonJS and podagent.mjs dies with:
//   Named export 'RACE_MIN_SCORE' not found. The requested module
//   './livestatus.js' is a CommonJS module
// That is 1.5.86 / 1.5.87. Do not set type:module on grokui-app/package.json.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const start = process.argv[2];
if (!start) {
  console.error('usage: assert-packed-grokui-esm.mjs <lib-dir-or-dist-or-grokui.mjs>');
  process.exit(2);
}

function walkGrokui(dir, found) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walkGrokui(full, found);
    } else if (e.name === 'grokui.mjs' && /(?:^|[/\\])lib[/\\]grokui\.mjs$/.test(full)) {
      found.push(full);
    }
  }
}

function libDirsFrom(startPath) {
  if (!existsSync(startPath)) {
    console.error(`packed tree missing: ${startPath}`);
    process.exit(1);
  }
  if (statSync(startPath).isFile()) {
    return [dirname(startPath)];
  }
  const found = [];
  walkGrokui(startPath, found);
  if (found.length) return [...new Set(found.map((f) => dirname(f)))];
  // A bare lib/ dir (cut / bundle dest) has grokui.mjs at the root.
  if (existsSync(join(startPath, 'grokui.mjs'))) return [startPath];
  console.error(`no packed lib/grokui.mjs under ${startPath}`);
  process.exit(1);
}

const NAMED_FROM_JS = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+\.js)['"]/g;
const BARE_PKG = /from\s+['"](?!\.|node:|file:)[^'"]+['"]/;

function namedJsImports(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(NAMED_FROM_JS)) {
    const names = m[1].split(',').map((s) => {
      const part = s.trim();
      if (!part) return '';
      // Keep the exported name (`filesForCorpus as collectFilesForCorpus`).
      return part.split(/\s+as\s+/)[0].trim();
    }).filter(Boolean);
    out.push({ spec: m[2], names });
  }
  return out;
}

function hasBarePackageImport(file, seen = new Set()) {
  const abs = resolve(file);
  if (seen.has(abs)) return false;
  seen.add(abs);
  if (!existsSync(abs) || !statSync(abs).isFile()) return true;
  const src = readFileSync(abs, 'utf8');
  if (BARE_PKG.test(src)) return true;
  for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    if (hasBarePackageImport(resolve(dirname(abs), m[1]), seen)) return true;
  }
  return false;
}

function collectNamedJsImports(libDir) {
  // Named-import the same .js bindings grokui.mjs / podagent.mjs use, but skip
  // files that import npm packages (info.js → @solana/web3.js). Evaluating
  // those needs the packed node_modules tree; the 1.5.87 crash is the linker
  // rejecting named exports from CJS livestatus.js, which has no package deps.
  const files = [join(libDir, 'grokui.mjs'), join(libDir, 'podagent.mjs')];
  const bySpec = new Map();
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const { spec, names } of namedJsImports(file)) {
      const abs = resolve(libDir, spec);
      if (hasBarePackageImport(abs)) continue;
      const cur = bySpec.get(abs) || new Set();
      for (const n of names) cur.add(n);
      bySpec.set(abs, cur);
    }
  }
  return bySpec;
}

function assertLibPackage(libDir) {
  const pkgPath = join(libDir, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error(`FAIL: packed lib/package.json missing at ${pkgPath} — .js would be CJS`);
    return 1;
  }
  let pkg;
  try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); }
  catch (e) {
    console.error(`FAIL: packed lib/package.json is not JSON: ${e.message}`);
    return 1;
  }
  if (pkg.type !== 'module') {
    console.error(`FAIL: packed lib/package.json type is ${JSON.stringify(pkg.type)}, need "module"`);
    return 1;
  }
  console.log(`ok lib/package.json type=module: ${pkgPath}`);
  return 0;
}

function assertDryImport(libDir) {
  const entry = join(libDir, 'grokui.mjs');
  if (!existsSync(entry)) {
    console.error(`FAIL: packed grokui.mjs missing at ${entry}`);
    return 1;
  }
  const bySpec = collectNamedJsImports(libDir);
  if (!bySpec.size) {
    console.error(`FAIL: no named .js imports found next to ${entry}`);
    return 1;
  }
  const allNames = new Set();
  for (const names of bySpec.values()) for (const n of names) allNames.add(n);
  if (!allNames.has('RACE_MIN_SCORE')) {
    console.error(`FAIL: dry import did not include RACE_MIN_SCORE from livestatus.js`);
    return 1;
  }
  const lines = [];
  for (const [abs, names] of bySpec) {
    const href = pathToFileURL(abs).href;
    lines.push(`import { ${[...names].join(', ')} } from ${JSON.stringify(href)};`);
  }
  lines.push('console.log("ok dry import named bindings");');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', lines.join('\n')], {
    cwd: libDir,
    encoding: 'utf8',
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim() || `exit ${r.status}`;
    if (/ERR_MODULE_NOT_FOUND|is a CommonJS module/.test(err)) {
      console.error(`FAIL: dry import of packed grokui.mjs:\n${err}`);
    } else {
      console.error(`FAIL: dry import of packed grokui.mjs:\n${err}`);
    }
    return 1;
  }
  console.log(`ok dry import: ${entry}`);
  return 0;
}

let failed = 0;
for (const libDir of libDirsFrom(isAbsolute(start) ? start : resolve(start))) {
  failed |= assertLibPackage(libDir);
  failed |= assertDryImport(libDir);
}
process.exit(failed ? 1 : 0);
