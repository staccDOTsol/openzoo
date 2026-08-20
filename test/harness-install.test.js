import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectHarness, ensureHarness, ensureLocalNodeNpx, electronAsNodeSpec,
  HARNESS_STATUS, localBinDir, npmInstallArgs, OPENZOO_CLAUDE_SPEC,
  setHarnessInstallRunnerForTest, setHarnessStateForTest, shouldSkipHarnessAutostart,
  writeUnixShim,
} from '../lib/harness-install.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'oz-harness-'));
}

test('shouldSkipHarnessAutostart on agent ports / explicit skip', () => {
  assert.equal(shouldSkipHarnessAutostart({ OZ_AGENT_PORTS: '0' }), true);
  assert.equal(shouldSkipHarnessAutostart({ OZ_SKIP_HARNESS: '1' }), true);
  assert.equal(shouldSkipHarnessAutostart({}), false);
});

test('detectHarness finds openzoo-claude + node + npx on ~/.local/bin', () => {
  const home = tmp();
  try {
    const bin = localBinDir(home);
    mkdirSync(bin, { recursive: true });
    for (const name of ['openzoo-claude', 'node', 'npx']) {
      const f = path.join(bin, name);
      writeFileSync(f, '#!/usr/bin/env node\n// openzoo-claude\n');
      chmodSync(f, 0o755);
    }
    const d = detectHarness({
      home,
      env: { PATH: '/no/such', HOME: home, OPENZOO_CLAUDE_PATH_ONLY: '1' },
      resolveClaude: () => path.join(bin, 'openzoo-claude'),
    });
    assert.equal(d.claude, true);
    assert.equal(d.node, true);
    assert.equal(d.npx, true);
    assert.equal(d.ready, true);
    assert.equal(d.localClaude, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('npm install args pin openzoo-claude@latest into ~/.local — never official Claude', () => {
  const home = tmp();
  const args = npmInstallArgs(path.join(home, '.local'));
  assert.deepEqual(args, ['install', '-g', OPENZOO_CLAUDE_SPEC, '--prefix', path.join(home, '.local')]);
  assert.match(OPENZOO_CLAUDE_SPEC, /^openzoo-claude@latest$/);
  const src = readFileSync(path.join(root, 'lib', 'harness-install.js'), 'utf8');
  assert.doesNotMatch(src, /claude\.ai\/install/);
  assert.doesNotMatch(src, /install\.sh/);
  assert.doesNotMatch(src, /install\.ps1/);
  assert.doesNotMatch(src, /process\.env\.ANTHROPIC_API_KEY|env\.ANTHROPIC_API_KEY/);
  assert.match(src, /ELECTRON_RUN_AS_NODE/);
  assert.match(src, /~\/\.local\/bin|localBinDir/);
  assert.match(HARNESS_STATUS.claude, /openzoo-claude/);
  assert.doesNotMatch(HARNESS_STATUS.claude, /Installing Claude/);
});

test('ensureLocalNodeNpx writes Electron-as-node shims when no host node', () => {
  const home = tmp();
  try {
    const electron = '/Applications/openzoo.app/Contents/MacOS/openzoo';
    const r = ensureLocalNodeNpx({ home, platform: 'linux', electronPath: electron });
    assert.ok(r.wrote.length >= 2);
    const nodeShim = readFileSync(path.join(localBinDir(home), 'node'), 'utf8');
    assert.match(nodeShim, /ELECTRON_RUN_AS_NODE/);
    assert.match(nodeShim, /openzoo\.app/);
    const npxShim = readFileSync(path.join(localBinDir(home), 'npx'), 'utf8');
    assert.match(npxShim, /ELECTRON_RUN_AS_NODE/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('electronAsNodeSpec sets ELECTRON_RUN_AS_NODE', () => {
  const spec = electronAsNodeSpec('/fake/electron', { PATH: '/usr/bin' });
  assert.equal(spec.command, '/fake/electron');
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spec.via, 'electron-as-node');
});

test('writeUnixShim is executable and execs the target', () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'node');
    writeUnixShim(f, '/opt/homebrew/bin/node', { ELECTRON_RUN_AS_NODE: '1' });
    const body = readFileSync(f, 'utf8');
    assert.match(body, /^#!\/bin\/sh/);
    assert.match(body, /ELECTRON_RUN_AS_NODE/);
    assert.match(body, /\/opt\/homebrew\/bin\/node/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureHarness skip + injected runner never dumps npx recipe', async () => {
  setHarnessStateForTest({});
  const skipped = await ensureHarness({ env: { OZ_SKIP_HARNESS: '1' }, home: tmp() });
  assert.equal(skipped.skipped, true);

  const home = tmp();
  try {
    let ran = 0;
    setHarnessInstallRunnerForTest(async () => {
      ran += 1;
      const bin = localBinDir(home);
      mkdirSync(bin, { recursive: true });
      for (const name of ['openzoo-claude', 'node', 'npx']) {
        writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n');
        chmodSync(path.join(bin, name), 0o755);
      }
      return { ok: true, via: 'electron-as-node' };
    });
    const r = await ensureHarness({
      force: true,
      home,
      env: { PATH: binPath(home), HOME: home },
      resolveClaude: () => path.join(localBinDir(home), 'openzoo-claude'),
    });
    assert.equal(ran, 1);
    assert.equal(r.ok, true);
    assert.doesNotMatch(JSON.stringify(r), /npx -y openzoo-claude/);
  } finally {
    setHarnessInstallRunnerForTest(null);
    rmSync(home, { recursive: true, force: true });
  }
});

function binPath(home) {
  return localBinDir(home);
}
