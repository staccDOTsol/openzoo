#!/usr/bin/env node
// Copy the live UI into the Electron package so a packaged .app never
// ships the stale grokui-app/lib snapshot. lib/grokui.mjs is the source.
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', '..', 'lib');
const destDir = path.join(__dirname, '..', 'lib');
fs.mkdirSync(destDir, { recursive: true });
for (const f of ['grokui.mjs', 'podagent.mjs', 'livestatus.js', 'worktree.mjs']) {
  const from = path.join(srcDir, f);
  const to = path.join(destDir, f);
  if (!fs.existsSync(from)) {
    console.error(`[bundle-grokui] missing ${from}`);
    process.exit(1);
  }
  fs.copyFileSync(from, to);
  console.log(`[bundle-grokui] ${f} -> ${to}`);
}
