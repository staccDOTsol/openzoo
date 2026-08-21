import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(path.join(root, 'box.Dockerfile'), 'utf8');
const boot = readFileSync(path.join(root, 'box-boot.sh'), 'utf8');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'docker-box.yml'), 'utf8');
const boxes = readFileSync(path.join(root, 'lib', 'boxes.js'), 'utf8');
const walker = path.join(root, 'scripts', 'assert-esm-relatives.mjs');

function walk(entry) {
  return spawnSync(process.execPath, [walker, entry], { encoding: 'utf8' });
}

test('box image copies the whole grokui lib tree, not two files', () => {
  assert.match(dockerfile, /cp -a \/opt\/openzoo\/lib\/\. \/opt\/grokui\//);
  assert.doesNotMatch(dockerfile, /cp \/opt\/openzoo\/lib\/grokui\.mjs \/opt\/openzoo\/lib\/podagent\.mjs/);
  assert.match(dockerfile, /test -f \/opt\/grokui\/livestatus\.js/);
  assert.match(dockerfile, /test -f \/opt\/grokui\/package\.json/);
  assert.match(dockerfile, /assert-esm-relatives\.mjs \/opt\/grokui\/grokui\.mjs/);
  assert.match(dockerfile, /assert-packed-grokui-esm\.mjs \/opt\/grokui/);
  // Bake must not curl :4173. window-before-sidecar is desktop; here grokui
  // must actually load, which the smoke test (and the resolve gate) prove.
  assert.doesNotMatch(dockerfile, /curl[^\n]*4173/);
  assert.doesNotMatch(dockerfile, /wget[^\n]*4173/);
});

test('box-boot runs grokui from the complete clone, not a stripped .grokui', () => {
  assert.match(boot, /UI_ENTRY=\/opt\/openzoo\/lib\/grokui\.mjs/);
  assert.match(boot, /UI_ENTRY="\$OZ_DIR\/lib\/grokui\.mjs"/);
  assert.doesNotMatch(boot, /cp \/opt\/grokui\/grokui\.mjs \/opt\/grokui\/podagent\.mjs/);
  assert.match(boot, /cp -a \/opt\/grokui\/\. \/workspace\/\.grokui\//);
  assert.match(boxes, /node \/opt\/openzoo\/lib\/grokui\.mjs/);
  assert.doesNotMatch(boxes, /node \/opt\/grokui\/grokui\.mjs/);
});

test('box image bakes code-server and Cline, never ANTHROPIC_API_KEY', () => {
  assert.match(dockerfile, /code-server\.dev\/install\.sh/);
  assert.match(dockerfile, /--method=standalone/);
  assert.match(dockerfile, /saoudrizwan\.claude-dev/);
  assert.match(dockerfile, /node:22-bookworm-slim/);
  assert.match(dockerfile, /OPENZOO_NO_TUNNEL=1/);
  assert.match(dockerfile, /box-cline-settings\.mjs/);
  assert.match(dockerfile, /box-8080-door\.mjs/);
  assert.doesNotMatch(dockerfile, /ENV\s+ANTHROPIC_API_KEY=/);
  assert.doesNotMatch(dockerfile, /FROM\s+alpine/i);
  assert.doesNotMatch(dockerfile, /sk-ant-/);
});

test('box-boot publishes passworded code-server on :8080 with Cline from sub env', () => {
  assert.match(boot, /unset ANTHROPIC_API_KEY/);
  assert.match(boot, /OPENZOO_NO_TUNNEL/);
  assert.match(boot, /box-cline-settings\.mjs/);
  assert.match(boot, /box-8080-door\.mjs/);
  assert.match(boot, /code-server/);
  assert.match(boot, /--auth password/);
  assert.match(boot, /0\.0\.0\.0:8080/);
  assert.match(boot, /\/health/);
  assert.match(boot, /CODE_SERVER_PASSWORD|sub-key-hash|box-cline-settings/);
  assert.doesNotMatch(boot, /--auth\s+none/);
  assert.doesNotMatch(boot, /ANTHROPIC_API_KEY=/);
  assert.doesNotMatch(boot, /sk-ant-/);
  assert.match(boot, /supervise "box-8080-door" 8080/);
  assert.doesNotMatch(boot, /supervise "box-server" 8080/);
  assert.match(boot, /UI_ENTRY=\/opt\/openzoo\/lib\/grokui\.mjs/);
});

test('docker-box smoke fails fast on MODULE_NOT_FOUND', () => {
  assert.match(workflow, /ERR_MODULE_NOT_FOUND/);
  assert.match(workflow, /is a CommonJS module/);
  assert.match(workflow, /FAIL: grokui MODULE_NOT_FOUND/);
  assert.match(workflow, /test -f \/opt\/grokui\/livestatus\.js/);
  assert.match(workflow, /saoudrizwan\.claude-dev/);
  assert.match(workflow, /8080\/health/);
  assert.match(workflow, /CODE_SERVER_PASSWORD/);
  assert.match(workflow, /ANTHROPIC_API_KEY/);
});

test('esm relative walker accepts the real grokui.mjs graph', () => {
  const r = walk(path.join(root, 'lib', 'grokui.mjs'));
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ok: \d+ files reachable/);
});

test('esm relative walker fails the two-file copy that broke :4173', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-box-lib-'));
  try {
    cpSync(path.join(root, 'lib', 'grokui.mjs'), path.join(dir, 'grokui.mjs'));
    cpSync(path.join(root, 'lib', 'podagent.mjs'), path.join(dir, 'podagent.mjs'));
    const r = walk(path.join(dir, 'grokui.mjs'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /livestatus\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('esm relative walker fails if a recursive relative is deleted after a full copy', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-box-lib-'));
  try {
    const src = path.join(root, 'lib');
    cpSync(src, dir, { recursive: true });
    rmSync(path.join(dir, 'livestatus.js'));
    const r = walk(path.join(dir, 'grokui.mjs'));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /livestatus\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
