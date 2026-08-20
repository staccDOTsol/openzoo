#!/usr/bin/env node
// Fail if a packed dmg/exe/AppImage is missing node-pty (native .node)
// or cannot load it for that artifact's arch. Source check: afterPack
// exports the gate and grokui-app depends on node-pty with npmRebuild.
//
//   node scripts/assert-packed-node-pty.mjs
//   node scripts/assert-packed-node-pty.mjs <dist-or-app-dir>
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);
const afterPack = require(join(root, 'grokui-app', 'build', 'afterPack.js'));
const appPkg = require(join(root, 'grokui-app', 'package.json'));

function fail(msg) {
  console.error(`[assert-packed-node-pty] ${msg}`);
  process.exit(1);
}

if (!appPkg.dependencies?.['node-pty']) {
  fail('grokui-app must depend on node-pty');
}
if (!appPkg.dependencies?.['openzoo-claude']) {
  fail('grokui-app must depend on openzoo-claude');
}
if (appPkg.build?.npmRebuild !== true) {
  fail('grokui-app build.npmRebuild must be true so each dmg/exe/AppImage rebuilds node-pty');
}
if (typeof afterPack.assertPackedNodePty !== 'function') {
  fail('afterPack.assertPackedNodePty missing');
}
if (typeof afterPack.assertPackedOpenzooClaude !== 'function') {
  fail('afterPack.assertPackedOpenzooClaude missing');
}
if (appPkg.build?.includeSubNodeModules !== true) {
  fail('includeSubNodeModules must stay true');
}
const extras = appPkg.build?.extraResources || [];
const extraFrom = extras.map((e) => (typeof e === 'string' ? e : e.from)).join('\n');
if (!/node-pty/.test(extraFrom) || !/openzoo-claude/.test(extraFrom)) {
  fail('extraResources must copy node-pty and openzoo-claude');
}
console.log('node-pty / openzoo-claude pack gate is wired (npmRebuild, extraResources, afterPack)');

const start = process.argv[2];
if (!start) process.exit(0);
if (!existsSync(start)) fail(`packed tree missing: ${start}`);

function walkApps(dir, found) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.name.endsWith('.app')) {
        found.push(join(full, 'Contents', 'Resources', 'app'));
        continue;
      }
      if (e.name === 'app' && /resources$/.test(dir)) {
        found.push(full);
        continue;
      }
      walkApps(full, found);
    }
  }
}

const apps = [];
if (statSync(start).isDirectory()) {
  const pkg = join(start, 'package.json');
  if (existsSync(pkg)) apps.push(start);
  if (!apps.length) walkApps(start, apps);
}
if (!apps.length) fail(`no packed app under ${start}`);

let failed = 0;
for (const appDir of [...new Set(apps)]) {
  if (!existsSync(appDir)) continue;
  try {
    afterPack.assertPackedOpenzooClaude(appDir);
    afterPack.assertPackedNodePty(appDir, {});
    console.log(`ok packed node-pty + openzoo-claude: ${appDir}`);
  } catch (e) {
    console.error(e.message || e);
    console.error(`FAIL: packed Auto runtime incomplete: ${appDir}`);
    failed = 1;
  }
}
process.exit(failed);
