import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  HARNESS_STATUS, NVM_SH_URL, CLAUDE_UNIX_INSTALL, CLAUDE_WIN_PS1, NVM_WINDOWS_SETUP,
  UNIX_PATH_SNIPPET,
  detectHarness, persistUnixPath, prependHarnessPath, applyOpenzooClaudeSetup,
  unixInstallPlan, windowsInstallPlan, installPlan, assertPlanSafe,
  ensureHarness, getHarnessState, setHarnessStateForTest, setHarnessInstallRunnerForTest,
  shouldSkipHarnessAutostart, kickHarnessAutostart, unixPathSnippet,
} from '../lib/harness-install.js';

function fakeSpawnOk() {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  return { spawn, calls };
}

test('status lines are short and never a curl homework recipe', () => {
  assert.equal(HARNESS_STATUS.claude, 'Installing Claude…');
  assert.equal(HARNESS_STATUS.node, 'Installing Node 24…');
  assert.equal(HARNESS_STATUS.openzoo, 'Installing openzoo…');
  for (const msg of Object.values(HARNESS_STATUS)) {
    assert.doesNotMatch(msg, /curl -fsSL/);
    assert.doesNotMatch(msg, /nvm-sh\/nvm/);
    assert.doesNotMatch(msg, /source ~\/\.zshrc/);
  }
  assert.equal(unixPathSnippet(), UNIX_PATH_SNIPPET);
  assert.match(UNIX_PATH_SNIPPET, /\$HOME\/\.local\/bin/);
});

test('unix plan uses official claude install.sh + nvm-sh Node 24 + global openzoo', () => {
  const plan = unixInstallPlan({ claude: true, nvm: true, node24: true, openzoo: true });
  const blob = plan.map((s) => s.command).join('\n');
  assert.match(blob, new RegExp(CLAUDE_UNIX_INSTALL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(blob, /nvm-sh\/nvm/);
  assert.match(blob, new RegExp(NVM_SH_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(blob, /nvm install 24/);
  assert.match(blob, /npm i -g openzoo/);
  assert.match(blob, /openzoo claude --setup/);
  assert.doesNotMatch(blob, /nvm-setup\.exe/);
  assert.doesNotMatch(blob, /install\.ps1/);
  assertPlanSafe('darwin', plan);
  assertPlanSafe('linux', plan);
});

test('windows plan uses official ps1 + nvm-windows, never unix nvm or zshrc', () => {
  const plan = windowsInstallPlan({ claude: true, nvm: true, node24: true, openzoo: true });
  const blob = plan.map((s) => s.command).join('\n');
  assert.match(blob, new RegExp(CLAUDE_WIN_PS1.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(blob, /irm /);
  assert.match(blob, /nvm-windows/);
  assert.match(blob, new RegExp(NVM_WINDOWS_SETUP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(blob, /nvm install 24/);
  assert.match(blob, /nvm use 24/);
  assert.match(blob, /npm i -g openzoo/);
  assert.match(blob, /openzoo claude --setup/);
  assert.doesNotMatch(blob, /nvm-sh\/nvm/);
  assert.doesNotMatch(blob, /claude\.ai\/install\.sh/);
  assert.doesNotMatch(blob, /source ~\/\.zshrc/);
  assert.doesNotMatch(blob, /\.zshrc/);
  assertPlanSafe('win32', plan);
  assert.throws(() => assertPlanSafe('win32', [{ command: 'curl nvm-sh/nvm | bash' }]));
  assert.throws(() => assertPlanSafe('win32', [{ command: 'source ~/.zshrc' }]));
});

test('installPlan dispatches by platform', () => {
  const win = installPlan('win32', { claude: true });
  const mac = installPlan('darwin', { claude: true });
  assert.ok(win.some((s) => /install\.ps1/.test(s.command)));
  assert.ok(mac.some((s) => /install\.sh/.test(s.command)));
});

test('detectHarness is ready only when claude + node 24 + global openzoo exist', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'oz-harness-det-'));
  mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n');
  writeFileSync(path.join(home, '.local', 'bin', 'openzoo'), '#!/bin/sh\n');
  const missing = detectHarness({
    platform: 'linux',
    env: { PATH: '/nope', HOME: home },
    home,
    resolveClaude: () => null,
    execFileSync: () => { throw new Error('no node'); },
  });
  assert.equal(missing.ready, false);
  assert.equal(missing.claude, false);

  const ready = detectHarness({
    platform: 'linux',
    env: { PATH: path.join(home, '.local', 'bin'), HOME: home },
    home,
    resolveClaude: () => path.join(home, '.local', 'bin', 'claude'),
    execFileSync: () => 'v24.4.0\n',
    exists: existsSync,
  });
  assert.equal(ready.claude, true);
  assert.equal(ready.node24, true);
});

test('persistUnixPath writes ~/.local/bin on Mac/Linux and never on Windows', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'oz-harness-path-'));
  const win = persistUnixPath({ platform: 'win32', home });
  assert.equal(win.wrote, false);
  assert.equal(win.reason, 'windows');
  assert.equal(existsSync(path.join(home, '.zshrc')), false);

  const unix = persistUnixPath({ platform: 'darwin', home });
  assert.equal(unix.wrote, true);
  const zsh = readFileSync(path.join(home, '.zshrc'), 'utf8');
  assert.match(zsh, /\$HOME\/\.local\/bin/);
  const again = persistUnixPath({ platform: 'darwin', home });
  assert.equal(again.wrote, false, 'idempotent — do not append twice');
});

test('prependHarnessPath puts ~/.local/bin first; Windows uses nvm-windows home', () => {
  const home = '/Users/x';
  const unix = { PATH: '/usr/bin' };
  prependHarnessPath(unix, { platform: 'darwin', home, exists: () => false });
  assert.match(unix.PATH, /^\s*\/Users\/x\/\.local\/bin/);

  const win = { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\x\\AppData\\Roaming' };
  prependHarnessPath(win, { platform: 'win32', home: 'C:\\Users\\x', exists: () => false });
  assert.match(win.PATH, /nvm/i);
  assert.doesNotMatch(win.PATH, /\.zshrc/);
});

test('applyOpenzooClaudeSetup writes harness.json and unsets Anthropic API key', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'oz-harness-setup-'));
  const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant', HOME: home };
  const zoo = applyOpenzooClaudeSetup({ env, home, port: 8402 });
  assert.equal(zoo.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:8402/v1');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-openzoo');
  const mark = JSON.parse(readFileSync(path.join(home, '.openzoo', 'harness.json'), 'utf8'));
  assert.equal(mark.claudeZoo, true);
  assert.equal(mark.baseUrl, 'http://localhost:8402/v1');
});

test('ensureHarness skips spawn when already installed', async () => {
  setHarnessInstallRunnerForTest(null);
  const home = mkdtempSync(path.join(tmpdir(), 'oz-harness-skip-'));
  const { spawn, calls } = fakeSpawnOk();
  const env = { PATH: path.join(home, '.local', 'bin'), HOME: home };
  const r = await ensureHarness({
    platform: 'linux',
    env,
    home,
    spawn,
    resolveClaude: () => path.join(home, '.local', 'bin', 'claude'),
    execFileSync: () => 'v24.1.0',
    exists: () => true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.equal(calls.length, 0);
  assert.equal(getHarnessState().ready, true);
  assert.match(getHarnessState().message, /already installed|ready/i);
});

test('ensureHarness runs unix steps with status and is a singleton', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'oz-harness-run-'));
  const { spawn, calls } = fakeSpawnOk();
  const statuses = [];
  const env = { PATH: '/usr/bin', HOME: home };
  const opts = {
    platform: 'linux',
    env,
    home,
    spawn,
    resolveClaude: () => null,
    execFileSync: () => { throw new Error('no node'); },
    exists: () => false,
    write: writeFileSync,
    mkdir: mkdirSync,
    onStatus: (s) => statuses.push(s.message),
  };
  const a = ensureHarness(opts);
  const b = ensureHarness(opts);
  assert.equal(a, b, 'concurrent callers share one run');
  const r = await a;
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.ok(calls.some((c) => c.cmd === 'bash'));
  const joined = statuses.join('\n');
  assert.match(joined, /Installing Claude/);
  assert.match(joined, /Node 24/);
  assert.match(joined, /openzoo/);
  const blob = calls.map((c) => (c.args || []).join(' ')).join('\n');
  assert.match(blob, /install\.sh/);
  assert.doesNotMatch(blob, /nvm-setup\.exe/);
});

test('ensureHarness windows steps never curl unix nvm or source zshrc', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'oz-harness-win-'));
  const { spawn, calls } = fakeSpawnOk();
  await ensureHarness({
    platform: 'win32',
    env: { PATH: 'C:\\Windows', HOME: home },
    home,
    spawn,
    resolveClaude: () => null,
    execFileSync: () => { throw new Error('no node'); },
    exists: () => false,
    write: writeFileSync,
    mkdir: mkdirSync,
  });
  const blob = calls.map((c) => [c.cmd, ...(c.args || [])].join(' ')).join('\n');
  assert.match(blob, /powershell/i);
  assert.match(blob, /install\.ps1|nvm-setup|nvm install 24/);
  assert.doesNotMatch(blob, /nvm-sh\/nvm/);
  assert.doesNotMatch(blob, /source ~\/\.zshrc/);
  assert.doesNotMatch(blob, /claude\.ai\/install\.sh/);
});

test('shouldSkipHarnessAutostart honors test flags; kick is a no-op then', () => {
  assert.equal(shouldSkipHarnessAutostart({ OZ_SKIP_HARNESS: '1' }), true);
  assert.equal(shouldSkipHarnessAutostart({ OZ_AGENT_PORTS: '0' }), true);
  assert.equal(shouldSkipHarnessAutostart({}), false);
  setHarnessInstallRunnerForTest(() => { throw new Error('must not run'); });
  assert.equal(kickHarnessAutostart({ env: { OZ_SKIP_HARNESS: '1' } }), null);
  setHarnessInstallRunnerForTest(null);
  setHarnessStateForTest({ ready: false });
});
