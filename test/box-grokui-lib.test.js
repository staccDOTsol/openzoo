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
const walker = path.join(root, 'scripts', 'assert-esm-relatives.mjs');

function walk(entry) {
  return spawnSync(process.execPath, [walker, entry], { encoding: 'utf8' });
}

test('box image is code-server + Cline, not grokui on :4173', () => {
  assert.match(dockerfile, /code-server\.dev\/install\.sh/);
  assert.match(dockerfile, /saoudrizwan\.claude-dev/);
  assert.match(dockerfile, /test -f \/opt\/openzoo\/bin\/openzoo\.js/);
  assert.doesNotMatch(dockerfile, /cp \/opt\/openzoo\/lib\/grokui\.mjs \/opt\/openzoo\/lib\/podagent\.mjs/);
  assert.doesNotMatch(dockerfile, /curl[^\n]*4173/);
  assert.doesNotMatch(dockerfile, /wget[^\n]*4173/);
  assert.doesNotMatch(dockerfile, /^FROM alpine/im);
  assert.doesNotMatch(dockerfile, /alpine:[0-9]/);
});

test('box-boot starts code-server, not grokui.mjs', () => {
  assert.match(boot, /code-server/);
  assert.match(boot, /unset ANTHROPIC_API_KEY/);
  assert.doesNotMatch(boot, /UI_ENTRY=\/opt\/openzoo\/lib\/grokui\.mjs/);
  assert.doesNotMatch(boot, /cp \/opt\/grokui\/grokui\.mjs \/opt\/grokui\/podagent\.mjs/);
  assert.doesNotMatch(boot, /^\s+--auth none\b/m);
});

test('docker-box smoke waits on code-server :8080 /health', () => {
  assert.match(workflow, /8080\/health/);
  assert.match(workflow, /saoudrizwan\.claude-dev/);
  assert.match(workflow, /command -v code-server/);
  assert.doesNotMatch(workflow, /FAIL: grokui MODULE_NOT_FOUND/);
  assert.doesNotMatch(workflow, /FAIL: grokui never served on :4173/);
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
