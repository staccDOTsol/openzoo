#!/usr/bin/env node
// Extract the served APP_HTML <script> and node --check it.
// A sitrep word-boundary regex inside the template literal interpolates to
// /^/sitrep<BS>/i → SyntaxError: Invalid regular expression flags, and the
// whole client dies (empty sidebar, send is a no-op).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const src = process.argv[2]
  ? (isAbsolute(process.argv[2]) ? process.argv[2] : resolve(process.argv[2]))
  : join(root, 'lib', 'grokui.mjs');
// Windows checkout with core.autocrlf=true turns grokui.mjs into CRLF.
// The end marker used to be LF-only (`;\n\nconst server`), so indexOf was
// -1 and 1.5.88 Windows CI printed "APP_HTML template bounds missing".
const grokui = readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
const start = grokui.indexOf('const APP_HTML = `');
const end = grokui.indexOf('`;\n\nconst server = http.createServer', start);
if (start < 0 || end < start) {
  console.error('APP_HTML template bounds missing');
  process.exit(1);
}
const literal = grokui.slice(start + 'const APP_HTML = '.length, end + 1);
let html;
try {
  html = Function('SUBSCRIPTIONS_PAGE', 'return ' + literal)('https://example.test/subscriptions');
} catch (e) {
  console.error('APP_HTML template failed to evaluate:', e.message);
  process.exit(1);
}
const open = html.indexOf('<script>');
const close = html.indexOf('</script>', open);
if (open < 0 || close < open) {
  console.error('served HTML has no <script>');
  process.exit(1);
}
const script = html.slice(open + '<script>'.length, close);
if (/\/\^\/sitrep/.test(script)) {
  console.error('FAIL: served script still has a sitrep regex (eaten backslashes)');
  process.exit(1);
}
const dir = mkdtempSync(join(tmpdir(), 'oz-apphtml-'));
const file = join(dir, 'apphtml.js');
writeFileSync(file, script);
const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
rmSync(dir, { recursive: true, force: true });
if (r.status !== 0) {
  process.stderr.write(r.stderr || r.stdout || 'node --check failed\n');
  process.exit(r.status || 1);
}
console.log('ok: served APP_HTML <script> parses');
