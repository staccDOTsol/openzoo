#!/usr/bin/env node
// Patch code-server workbench HTML so the viewport + mobile CSS/JS load even
// before box-front rewrites a response (login, first paint).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { injectMobileHtml } from './box-front.mjs';

const ROOTS = (process.env.OZ_CODE_SERVER_HTML_ROOTS || '/usr/local/lib/code-server,/usr/lib/code-server,/opt/code-server')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function walk(dir, out, depth = 0) {
  if (depth > 8 || !existsSync(dir)) return;
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out, depth + 1);
    } else if (/\.(html?)$/i.test(e.name)) {
      out.push(p);
    }
  }
}

export function injectIntoFiles(roots = ROOTS) {
  const files = [];
  for (const root of roots) walk(root, files);
  let n = 0;
  for (const file of files) {
    let html;
    try { html = readFileSync(file, 'utf8'); } catch { continue; }
    if (!/<html/i.test(html)) continue;
    const next = injectMobileHtml(html);
    if (next === html) continue;
    writeFileSync(file, next);
    n += 1;
    process.stdout.write(`[box-mobile-inject] ${file}\n`);
  }
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = injectIntoFiles();
  process.stdout.write(`[box-mobile-inject] patched ${n} html files\n`);
}
