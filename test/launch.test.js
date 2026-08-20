import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claudeZooEnv, resolveClaudeCli, resolveOpenzooClaude, claudeSpawnSpec,
  isAnthropicBunClaude, isOpenzooClaudeBin, OPENZOO_CLAUDE_PACKAGE,
  nvmNodeBinDirs, claudeCodeBinDirs,
} from '../lib/launch.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'oz-launch-'));
}

function writeBin(dir, name, body) {
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  writeFileSync(f, body);
  chmodSync(f, 0o755);
  return f;
}

function isolated(PATH) {
  return { PATH, OPENZOO_CLAUDE_PATH_ONLY: '1', HOME: tmp() };
}

test('resolveClaudeCli prefers openzoo-claude and skips Anthropic bun claude', () => {
  const dir = tmp();
  const bunDir = path.join(dir, 'local');
  const pkgDir = path.join(dir, 'pkg');
  const bun = writeBin(bunDir, 'claude', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x00]));
  const oz = writeBin(pkgDir, 'openzoo-claude', '#!/usr/bin/env node\nconsole.log("openzoo-claude")\n');
  assert.equal(isAnthropicBunClaude(bun), true);
  assert.equal(isOpenzooClaudeBin(bun), false);
  assert.equal(isOpenzooClaudeBin(oz), true);

  const env = isolated(`${bunDir}${path.delimiter}${pkgDir}`);
  assert.equal(resolveClaudeCli(env), oz);

  const bunOnly = isolated(bunDir);
  assert.equal(resolveClaudeCli(bunOnly), null);

  const specHelp = claudeSpawnSpec(['--help'], bunOnly);
  assert.equal(specHelp, null, 'no npx on isolated PATH → cannot spawn bun');
});

test('resolveClaudeCli accepts package occ / claude bin, not a random occ or official node claude', () => {
  const dir = tmp();
  const occPkg = writeBin(path.join(dir, 'occ-pkg'), 'occ',
    '#!/usr/bin/env node\nrequire("openzoo-claude/cli.js")\n');
  const occOther = writeBin(path.join(dir, 'occ-other'), 'occ',
    '#!/usr/bin/env node\nconsole.log("oracle")\n');
  const official = writeBin(path.join(dir, 'official'), 'claude',
    '#!/usr/bin/env node\nrequire("@anthropic-ai/claude-code/cli.js")\n');
  const pkgClaude = writeBin(path.join(dir, 'pkg-claude'), 'claude',
    '#!/usr/bin/env node\nrequire("openzoo-claude/cli.js")\n');
  const bunShebang = writeBin(path.join(dir, 'bunsh'), 'claude',
    '#!/usr/bin/env bun\nconsole.log("anthropic")\n');

  assert.equal(isAnthropicBunClaude(bunShebang), true);
  assert.equal(resolveClaudeCli(isolated(path.join(dir, 'occ-other'))), null);
  assert.equal(resolveClaudeCli(isolated(path.join(dir, 'official'))), null);
  assert.equal(resolveClaudeCli(isolated(path.join(dir, 'bunsh'))), null);
  assert.equal(resolveClaudeCli(isolated(path.join(dir, 'occ-pkg'))), occPkg);
  assert.equal(resolveClaudeCli(isolated(path.join(dir, 'pkg-claude'))), pkgClaude);
});

test('claudeSpawnSpec --help execs openzoo-claude, never ~/.local/bin bun, via npx if needed', () => {
  const dir = tmp();
  const local = path.join(dir, '.local', 'bin');
  const bun = writeBin(local, 'claude', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]));
  const npx = writeBin(path.join(dir, 'npxbin'), 'npx', '#!/bin/sh\nexit 0\n');
  const oz = writeBin(path.join(dir, 'pkg'), 'openzoo-claude',
    '#!/usr/bin/env node\nconsole.log("openzoo-claude --help")\n');

  const withOz = isolated(`${local}${path.delimiter}${path.dirname(oz)}`);
  const spec = claudeSpawnSpec(['--help'], withOz);
  assert.ok(spec);
  assert.equal(spec.command, oz);
  assert.deepEqual(spec.args, ['--help']);
  assert.notEqual(spec.command, bun);
  assert.ok(!spec.command.endsWith(`${path.sep}.local${path.sep}bin${path.sep}claude`));

  const npxOnly = isolated(`${local}${path.delimiter}${path.dirname(npx)}`);
  const viaNpx = claudeSpawnSpec(['--help'], npxOnly);
  assert.ok(viaNpx);
  assert.equal(viaNpx.command, npx);
  assert.deepEqual(viaNpx.args, ['-y', OPENZOO_CLAUDE_PACKAGE, '--help']);
  assert.equal(viaNpx.via, 'npx');
  assert.notEqual(viaNpx.command, bun);

  const resolved = resolveOpenzooClaude(npxOnly);
  assert.equal(resolved.via, 'npx');
  assert.deepEqual(resolved.prefixArgs, ['-y', 'openzoo-claude']);
});

test('claudeZooEnv does not require ANTHROPIC_API_KEY; token from subscription or sk-openzoo', () => {
  const home = tmp();
  const noKey = claudeZooEnv({
    ANTHROPIC_API_KEY: 'sk-ant-real',
    PATH: '/usr/bin',
    HOME: home,
  }, { port: 8402 });
  assert.equal(noKey.ANTHROPIC_API_KEY, undefined);
  assert.equal(noKey.ANTHROPIC_BASE_URL, 'http://localhost:8402/v1');
  assert.equal(noKey.ANTHROPIC_AUTH_TOKEN, 'sk-openzoo');

  const subFile = path.join(home, 'subscription.json');
  writeFileSync(subFile, JSON.stringify({ key: 'oz_from_disk' }));
  const fromFile = claudeZooEnv({
    ANTHROPIC_API_KEY: 'sk-ant-real',
    OPENZOO_SUBSCRIPTION_PATH: subFile,
    PATH: '/usr/bin',
    HOME: home,
  }, { port: 8402 });
  assert.equal(fromFile.ANTHROPIC_API_KEY, undefined);
  assert.equal(fromFile.ANTHROPIC_AUTH_TOKEN, 'oz_from_disk');

  const fromEnv = claudeZooEnv({
    OPENZOO_SUBSCRIPTION_KEY: 'oz_from_env',
    OPENZOO_SUBSCRIPTION_PATH: subFile,
    PATH: '/usr/bin',
    HOME: home,
  }, { port: 8402 });
  assert.equal(fromEnv.ANTHROPIC_AUTH_TOKEN, 'oz_from_env');
});

test('claudeZooEnv PATH is ~/.local/bin + nvm 24; zoo :8402; no ANTHROPIC_API_KEY', () => {
  const home = tmp();
  const local = path.join(home, '.local', 'bin');
  const nvm24 = path.join(home, '.nvm', 'versions', 'node', 'v24.4.0', 'bin');
  const nvm20 = path.join(home, '.nvm', 'versions', 'node', 'v20.19.0', 'bin');
  mkdirSync(local, { recursive: true });
  mkdirSync(nvm24, { recursive: true });
  mkdirSync(nvm20, { recursive: true });
  const env = claudeZooEnv({
    ANTHROPIC_API_KEY: 'sk-ant-real',
    PATH: '/usr/bin',
    HOME: home,
    NVM_DIR: path.join(home, '.nvm'),
  }, { port: 8402 });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:8402/v1');
  const parts = env.PATH.split(path.delimiter);
  assert.equal(parts[0], local);
  assert.ok(parts.includes(nvm24), env.PATH);
  assert.ok(parts.indexOf(nvm24) < parts.indexOf(nvm20), 'nvm 24 before other nvm');
  const dirs = claudeCodeBinDirs(home, { NVM_DIR: path.join(home, '.nvm') });
  assert.ok(dirs[0].endsWith(`${path.sep}.local${path.sep}bin`));
  assert.deepEqual(nvmNodeBinDirs(home, { NVM_DIR: path.join(home, '.nvm') })[0], nvm24);
});

test('openzoo claude --help path mentions/execs openzoo-claude; no official install.sh', () => {
  const launch = readFileSync(path.join(root, 'lib', 'launch.js'), 'utf8');
  const help = readFileSync(path.join(root, 'bin', 'openzoo.js'), 'utf8');
  const claude = readFileSync(path.join(root, 'lib', 'claudecode.js'), 'utf8');
  assert.match(help, /openzoo-claude/);
  assert.match(help, /npx -y openzoo-claude/);
  assert.match(launch, /claudeSpawnSpec\(argv, env\)/);
  assert.match(launch, /spawn\(spec\.command, spec\.args/);
  assert.doesNotMatch(launch, /spawn\(cli, rest/);
  assert.doesNotMatch(launch, /claude\.ai\/install\.sh/);
  assert.doesNotMatch(launch, /install Claude Code/);
  assert.doesNotMatch(claude, /claude\.ai\/install\.sh/);
  assert.doesNotMatch(claude, /curl -fsSL/);
});
