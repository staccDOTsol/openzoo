import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  createSidecarHealer,
  packedSidecarEnv,
  packedSidecarSpawnOpts,
  hostNodeSidecarSpawnOpts,
  shouldAttach,
  looksLikeModuleNotFound,
  isCannotLoadOutput,
  resolveHostNode,
  resolvePathOpenzoo,
  resolvePackedNode,
  copyPackedRuntimeToHome,
  packedRuntimeHome,
  sidecarSpawnOpts,
  win32NeedsShell,
  win32DetachedPipeHang,
  isUnbootableSpawnError,
  localBinNode,
  defaultSpawnMode,
} = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grokui-app', 'sidecar-heal.js'),
);
const { sidecarIsAttachable } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grokui-app', 'sidecar-version.js'),
);

function fakeChild() {
  const c = new EventEmitter();
  c.killed = false;
  c.unrefed = false;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => {
    c.killed = true;
    c.emit('exit', 1, null);
  };
  c.unref = () => { c.unrefed = true; };
  return c;
}

function fakeTimers() {
  const pending = [];
  const setTimeoutFn = (fn, ms) => {
    const t = { fn, ms, cancelled: false, unrefed: false };
    t.unref = () => { t.unrefed = true; return t; };
    pending.push(t);
    return t;
  };
  const clearTimeoutFn = (t) => { if (t) t.cancelled = true; };
  async function flush() {
    const batch = pending.filter((t) => !t.cancelled);
    pending.length = 0;
    for (const t of batch) await t.fn();
  }
  return { setTimeoutFn, clearTimeoutFn, flush, pending };
}

function makeHealer(overrides = {}) {
  const timers = overrides.timers || fakeTimers();
  let spawned = [];
  const healer = createSidecarHealer({
    spawn: (cmd, args, opts) => {
      const c = fakeChild();
      spawned.push({ cmd, args, opts, child: c });
      return c;
    },
    execPath: '/fake/electron',
    binPath: '/fake/node_modules/openzoo/bin/openzoo.js',
    fetchSession: async () => null,
    portOccupied: async () => false,
    displaceStale: async () => true,
    sidecarIsAttachable,
    expectedVersion: '0.49.8',
    waitForSession: async () => true,
    // Isolate from the runner's /usr/bin/node so packed-path tests stay packed.
    resolveHostNode: () => null,
    log: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    backoffMs: 10,
    healthMs: 50,
    ...overrides,
  });
  return { healer, spawned, timers };
}

test('packed sidecar spawn uses Electron execPath, silent env, ignore stdio', () => {
  const env = packedSidecarEnv({ PATH: '/usr/bin' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.OPENZOO_SILENT, '1');
  assert.equal(env.OPENZOO_NO_OPEN, '1');
  const opts = packedSidecarSpawnOpts({});
  assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.detached, undefined);
});

test('host-node spawn opts are detached and never set ELECTRON_RUN_AS_NODE', () => {
  const opts = hostNodeSidecarSpawnOpts({ ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' }, { platform: 'darwin' });
  assert.equal(opts.detached, true);
  assert.equal(opts.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(opts.env.OPENZOO_SILENT, '1');
  assert.deepEqual(opts.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(opts.windowsHide, true);
});

test('shouldAttach treats 402 as live proxy, not a dead sidecar', () => {
  assert.equal(shouldAttach({ paymentRequired: true }, { sidecarIsAttachable, expectedVersion: '0.49.8' }), true);
  assert.equal(shouldAttach({ version: '0.49.8' }, { sidecarIsAttachable, expectedVersion: '0.49.8' }), true);
  assert.equal(shouldAttach({ version: '0.49.3' }, { sidecarIsAttachable, expectedVersion: '0.49.8' }), false);
  assert.equal(shouldAttach(null, { sidecarIsAttachable, expectedVersion: '0.49.8' }), false);
});

test('healthy :8402 is reused and does not spawn', async () => {
  const { healer, spawned, timers } = makeHealer({
    fetchSession: async () => ({ version: '0.49.8' }),
  });
  const result = await healer.ensure();
  assert.equal(result.reused, true);
  assert.equal(result.healthy, true);
  assert.equal(spawned.length, 0);
  healer.stop();
  assert.equal(timers.pending.every((t) => t.cancelled), true);
});

test('HTTP 402 session does not spawn or displace', async () => {
  let displaced = 0;
  const { healer, spawned } = makeHealer({
    fetchSession: async () => ({ paymentRequired: true }),
    displaceStale: async () => { displaced += 1; return true; },
  });
  const result = await healer.ensure();
  assert.equal(result.reused, true);
  assert.equal(spawned.length, 0);
  assert.equal(displaced, 0);
  healer.stop();
});

test('occupied + null session displaces then spawns (wedged leftover)', async () => {
  let occupied = true;
  let displaced = 0;
  const { healer, spawned } = makeHealer({
    fetchSession: async () => null,
    portOccupied: async () => occupied,
    displaceStale: async () => { displaced += 1; occupied = false; return true; },
  });
  const result = await healer.ensure();
  assert.equal(displaced, 1);
  assert.equal(result.spawned, true);
  assert.equal(result.wedged, false);
  assert.equal(result.healthy, true);
  assert.equal(spawned.length, 1);
  healer.stop();
});

test('occupied + null session stays wedged when displace fails', async () => {
  const { healer, spawned } = makeHealer({
    fetchSession: async () => null,
    portOccupied: async () => true,
    displaceStale: async () => false,
  });
  const result = await healer.ensure();
  assert.equal(result.wedged, true);
  assert.equal(result.healthy, false);
  assert.equal(spawned.length, 0);
  healer.stop();
});

test('free port with no host node spawns Electron execPath + packed openzoo.js', async () => {
  const { healer, spawned } = makeHealer();
  const result = await healer.ensure();
  assert.equal(result.spawned, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, '/fake/electron');
  assert.deepEqual(spawned[0].args, ['/fake/node_modules/openzoo/bin/openzoo.js']);
  assert.deepEqual(spawned[0].opts.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawned[0].opts.env.OPENZOO_SILENT, '1');
  assert.equal(spawned[0].opts.detached, undefined);
  healer.stop();
});

test('when host node exists, first spawn is host node + packed bin, not Electron', async () => {
  const { healer, spawned } = makeHealer({
    resolveHostNode: () => '/fake/nvm/versions/node/v24.4.0/bin/node',
  });
  assert.equal(healer.getSpawnMode(), 'host-node');
  const result = await healer.ensure();
  assert.equal(result.spawned, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, '/fake/nvm/versions/node/v24.4.0/bin/node');
  assert.deepEqual(spawned[0].args, ['/fake/node_modules/openzoo/bin/openzoo.js']);
  assert.equal(spawned[0].opts.detached, true);
  assert.equal(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(spawned[0].opts.env.OPENZOO_SILENT, '1');
  assert.equal(spawned[0].child.unrefed, true);
  healer.stop();
});

test('killing the sidecar child respawns without a window restart', async () => {
  const { healer, spawned, timers } = makeHealer();
  await healer.ensure();
  assert.equal(spawned.length, 1);
  spawned[0].child.emit('exit', 1, null);
  assert.equal(healer.child(), null);
  await timers.flush();
  assert.ok(spawned.length >= 2, `expected respawn, spawned ${spawned.length}`);
  healer.stop();
});

test('stop() does not kill a detached healthy child and does not respawn', async () => {
  const { healer, spawned, timers } = makeHealer({
    resolveHostNode: () => '/opt/homebrew/bin/node',
  });
  await healer.ensure();
  assert.equal(spawned[0].opts.detached, true);
  healer.stop();
  assert.equal(spawned[0].child.killed, false);
  await timers.flush();
  assert.equal(spawned.length, 1);
});

test('health timer is not unref\'d while the app is running', async () => {
  const { healer, timers } = makeHealer({
    fetchSession: async () => ({ version: '0.49.8' }),
  });
  await healer.ensure();
  const live = timers.pending.filter((t) => !t.cancelled);
  assert.ok(live.length >= 1, 'health poll should be scheduled');
  assert.equal(live.every((t) => t.unrefed === false), true);
  healer.stop();
});

test('stale listener is displaced then sidecar is spawned', async () => {
  let displaced = 0;
  const { healer, spawned } = makeHealer({
    fetchSession: async () => ({ version: '0.49.3' }),
    displaceStale: async () => { displaced += 1; return true; },
  });
  await healer.ensure();
  assert.equal(displaced, 1);
  assert.equal(spawned.length, 1);
  healer.stop();
});

test('MODULE_NOT_FOUND packed bin falls back to host node, not looped forever', async () => {
  assert.equal(looksLikeModuleNotFound("Error: Cannot find module './think.js'"), true);
  assert.equal(isCannotLoadOutput('Error [ERR_MODULE_NOT_FOUND]: Cannot find module'), true);
  assert.equal(looksLikeModuleNotFound('sidecar exited (1)'), false);
  const timers = fakeTimers();
  const spawned = [];
  const healer = createSidecarHealer({
    spawn: (cmd, args, opts) => {
      const c = fakeChild();
      spawned.push({ cmd, args, opts, child: c });
      if (cmd === '/fake/electron') {
        queueMicrotask(() => {
          c.stderr.emit('data', "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../lib/think.js' imported from livestatus.js");
          c.emit('exit', 1, null);
        });
      }
      return c;
    },
    execPath: '/fake/electron',
    binPath: '/fake/node_modules/openzoo/bin/openzoo.js',
    fetchSession: async () => null,
    portOccupied: async () => false,
    displaceStale: async () => true,
    sidecarIsAttachable,
    expectedVersion: '0.49.8',
    waitForSession: async (died) => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return !died();
    },
    // No host node at first pick — packed is first; after MODULE_NOT_FOUND
    // the same stub returns a node so fallback can land there.
    resolveHostNode: () => (spawned.some((s) => s.cmd === '/fake/electron')
      ? '/fake/nvm/versions/node/v24.4.0/bin/node'
      : null),
    resolvePathOpenzoo: () => '/usr/local/bin/openzoo',
    log: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    backoffMs: 10,
    healthMs: 50,
  });
  await healer.ensure();
  assert.equal(spawned[0].cmd, '/fake/electron');
  assert.equal(healer.getSpawnMode(), 'host-node');
  await timers.flush();
  assert.ok(spawned.length >= 2, `expected host-node fallback, spawned ${spawned.length}`);
  assert.equal(spawned[1].cmd, '/fake/nvm/versions/node/v24.4.0/bin/node');
  assert.deepEqual(spawned[1].args, ['/fake/node_modules/openzoo/bin/openzoo.js']);
  assert.equal(spawned[1].opts.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(spawned[1].opts.detached, true);
  assert.equal(spawned[1].opts.env.OPENZOO_SILENT, '1');
  const electronSpawns = spawned.filter((s) => s.cmd === '/fake/electron').length;
  assert.equal(electronSpawns, 1, 'packed electron bin must not be looped after MODULE_NOT_FOUND');
  healer.stop();
});

test('host-node MODULE_NOT_FOUND falls back to packed then PATH openzoo', async () => {
  const timers = fakeTimers();
  const spawned = [];
  const healer = createSidecarHealer({
    spawn: (cmd, args, opts) => {
      const c = fakeChild();
      spawned.push({ cmd, args, opts, child: c });
      if (cmd !== '/usr/local/bin/openzoo') {
        queueMicrotask(() => {
          c.stderr.emit('data', 'Cannot find module think.js');
          c.emit('exit', 1, null);
        });
      }
      return c;
    },
    execPath: '/fake/electron',
    binPath: '/fake/node_modules/openzoo/bin/openzoo.js',
    fetchSession: async () => null,
    portOccupied: async () => false,
    displaceStale: async () => true,
    sidecarIsAttachable,
    expectedVersion: '0.49.8',
    waitForSession: async (died) => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return !died();
    },
    resolveHostNode: () => '/opt/homebrew/bin/node',
    resolvePathOpenzoo: () => '/usr/local/bin/openzoo',
    log: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    backoffMs: 10,
    healthMs: 50,
  });
  await healer.ensure();
  await timers.flush();
  await healer.ensure();
  await timers.flush();
  const cmds = spawned.map((s) => s.cmd);
  assert.equal(cmds[0], '/opt/homebrew/bin/node');
  assert.ok(cmds.includes('/fake/electron'));
  assert.ok(cmds.includes('/usr/local/bin/openzoo'));
  const oz = spawned.find((s) => s.cmd === '/usr/local/bin/openzoo');
  assert.deepEqual(oz.args, []);
  assert.equal(oz.opts.detached, true);
  healer.stop();
});

test('resolveHostNode prefers nvm Node 24 over older nvm', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-nvm-'));
  try {
    const nvm = path.join(dir, '.nvm');
    for (const v of ['v20.19.0', 'v24.4.0', 'v22.1.0']) {
      const bin = path.join(nvm, 'versions', 'node', v, 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(path.join(bin, 'node'), '');
    }
    const got = resolveHostNode({ HOME: dir, NVM_DIR: nvm, PATH: '/no/node/here' });
    assert.equal(got, path.join(nvm, 'versions', 'node', 'v24.4.0', 'bin', 'node'));
    const oz = resolvePathOpenzoo({ PATH: path.join(dir, 'bin') });
    assert.equal(oz, null);
    mkdirSync(path.join(dir, 'bin'), { recursive: true });
    writeFileSync(path.join(dir, 'bin', 'openzoo'), '');
    assert.equal(resolvePathOpenzoo({ PATH: path.join(dir, 'bin') }), path.join(dir, 'bin', 'openzoo'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveHostNode finds ~/.local/bin/node when nvm/homebrew/PATH are empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-local-node-'));
  try {
    const local = path.join(dir, '.local', 'bin');
    mkdirSync(local, { recursive: true });
    writeFileSync(path.join(local, 'node'), '');
    const env = { HOME: dir, USERPROFILE: dir, NVM_DIR: path.join(dir, '.nvm'), PATH: '/no/node/here' };
    assert.equal(localBinNode(env), path.join(local, 'node'));
    const exists = (p) => {
      if (p === '/opt/homebrew/bin/node' || p === '/usr/local/bin/node' || p === '/usr/bin/node') return false;
      try { return require('node:fs').existsSync(p); } catch { return false; }
    };
    const got = resolveHostNode(env, exists);
    assert.equal(got, path.join(local, 'node'));
    assert.equal(defaultSpawnMode(env, () => got), 'host-node');
    assert.equal(defaultSpawnMode({ PATH: '/no/node' }, () => null), 'packed');
    assert.equal(defaultSpawnMode(env, () => got, 'win32'), 'packed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('win32 spawn opts: .cmd needs shell, exe does not, never detached+pipe', () => {
  assert.equal(win32NeedsShell('C\\\\npm\\\\openzoo.cmd'), true);
  assert.equal(win32NeedsShell('openzoo.bat'), true);
  assert.equal(win32NeedsShell('C\\\\Program Files\\\\nodejs\\\\node.exe'), false);
  assert.equal(win32NeedsShell('/fake/electron'), false);
  const cmdOpts = sidecarSpawnOpts({}, {
    electronAsNode: false,
    platform: 'win32',
    cmd: 'C\\\\npm\\\\openzoo.cmd',
  });
  assert.equal(cmdOpts.shell, true);
  assert.equal(cmdOpts.detached, undefined);
  assert.deepEqual(cmdOpts.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(win32DetachedPipeHang(cmdOpts), false);
  const exeOpts = sidecarSpawnOpts({}, {
    electronAsNode: true,
    platform: 'win32',
    cmd: 'C\\\\Users\\\\stacc\\\\AppData\\\\Local\\\\Programs\\\\openzoo\\\\openzoo.exe',
  });
  assert.equal(exeOpts.shell, undefined);
  assert.equal(exeOpts.detached, undefined);
  assert.equal(exeOpts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(win32DetachedPipeHang(exeOpts), false);
  const hostOpts = hostNodeSidecarSpawnOpts({ PATH: 'C\\\\Windows' }, {
    platform: 'win32',
    cmd: 'C\\\\Program Files\\\\nodejs\\\\node.exe',
  });
  assert.equal(hostOpts.detached, undefined);
  assert.equal(hostOpts.shell, undefined);
  assert.equal(win32DetachedPipeHang(hostOpts), false);
  const e = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
  assert.equal(isUnbootableSpawnError(e), true);
  assert.equal(isUnbootableSpawnError(Object.assign(new Error('not found'), { code: 'ENOENT' })), true);
  assert.equal(isUnbootableSpawnError(new Error('ok')), false);
});

test('win32 healer prefers packed Electron-as-node even when PATH node exists', async () => {
  const { healer, spawned } = makeHealer({
    platform: 'win32',
    resolveHostNode: () => 'C\\\\Program Files\\\\nodejs\\\\node.exe',
    resolvePathOpenzoo: () => 'C\\\\npm\\\\openzoo.cmd',
    resolvePackedNode: () => 'C\\\\app\\\\resources\\\\node.exe',
  });
  assert.equal(healer.getSpawnMode(), 'packed');
  const result = await healer.ensure();
  assert.equal(result.spawned, true);
  assert.equal(result.spawnMode, 'packed');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, '/fake/electron');
  assert.deepEqual(spawned[0].args, ['/fake/node_modules/openzoo/bin/openzoo.js']);
  assert.equal(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawned[0].opts.detached, undefined);
  assert.equal(spawned[0].opts.shell, undefined);
  assert.equal(win32DetachedPipeHang(spawned[0].opts), false);
  healer.stop();
});

test('win32 healer boots packed :8402 without a host Node', async () => {
  const { healer, spawned } = makeHealer({
    platform: 'win32',
    resolveHostNode: () => null,
    resolvePackedNode: () => null,
    resolvePathOpenzoo: () => null,
  });
  const result = await healer.ensure();
  assert.equal(result.spawned, true);
  assert.equal(result.healthy, true);
  assert.equal(result.spawnMode, 'packed');
  assert.equal(spawned[0].cmd, '/fake/electron');
  assert.equal(spawned[0].opts.detached, undefined);
  healer.stop();
});

test('win32 healer after packed fail uses packed node.exe then host-node without detached pipe', async () => {
  const timers = fakeTimers();
  const spawned = [];
  const healer = createSidecarHealer({
    platform: 'win32',
    spawn: (cmd, args, opts) => {
      const c = fakeChild();
      spawned.push({ cmd, args, opts, child: c });
      if (cmd === '/fake/electron') {
        queueMicrotask(() => {
          c.stderr.emit('data', 'Cannot find module think.js');
          c.emit('exit', 1, null);
        });
      }
      return c;
    },
    execPath: '/fake/electron',
    binPath: '/fake/node_modules/openzoo/bin/openzoo.js',
    fetchSession: async () => null,
    portOccupied: async () => false,
    displaceStale: async () => true,
    sidecarIsAttachable,
    expectedVersion: '0.49.8',
    waitForSession: async (died) => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return !died();
    },
    resolveHostNode: () => 'C\\\\Program Files\\\\nodejs\\\\node.exe',
    resolvePackedNode: () => 'C\\\\app\\\\resources\\\\node.exe',
    resolvePathOpenzoo: () => 'C\\\\npm\\\\openzoo.cmd',
    log: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    backoffMs: 10,
    healthMs: 50,
  });
  await healer.ensure();
  assert.equal(spawned[0].cmd, '/fake/electron');
  await timers.flush();
  assert.ok(spawned.length >= 2, `expected packed-node fallback, spawned ${spawned.length}`);
  assert.equal(spawned[1].cmd, 'C\\\\app\\\\resources\\\\node.exe');
  assert.deepEqual(spawned[1].args, ['/fake/node_modules/openzoo/bin/openzoo.js']);
  assert.equal(spawned[1].opts.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(spawned[1].opts.detached, undefined);
  assert.equal(win32DetachedPipeHang(spawned[1].opts), false);
  healer.stop();
});

test('win32 path-openzoo spawn uses shell:true and is not detached', async () => {
  const timers = fakeTimers();
  const spawned = [];
  const healer = createSidecarHealer({
    platform: 'win32',
    spawn: (cmd, args, opts) => {
      if (/\.cmd$/i.test(cmd) && !opts.shell) {
        const err = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
        throw err;
      }
      const c = fakeChild();
      spawned.push({ cmd, args, opts, child: c });
      if (cmd === '/fake/electron') {
        queueMicrotask(() => {
          c.stderr.emit('data', 'Cannot find module think.js');
          c.emit('exit', 1, null);
        });
      }
      return c;
    },
    execPath: '/fake/electron',
    binPath: '/fake/node_modules/openzoo/bin/openzoo.js',
    fetchSession: async () => null,
    portOccupied: async () => false,
    displaceStale: async () => true,
    sidecarIsAttachable,
    expectedVersion: '0.49.8',
    waitForSession: async (died) => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return !died();
    },
    resolveHostNode: () => null,
    resolvePackedNode: () => null,
    resolvePathOpenzoo: () => 'C\\\\npm\\\\openzoo.cmd',
    log: () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    backoffMs: 10,
    healthMs: 50,
  });
  await healer.ensure();
  assert.equal(spawned[0].cmd, '/fake/electron');
  await timers.flush();
  const oz = spawned.find((s) => /\.cmd$/i.test(s.cmd));
  assert.ok(oz, `expected path-openzoo fallback, cmds=${spawned.map((s) => s.cmd).join(',')}`);
  assert.equal(oz.opts.shell, true);
  assert.equal(oz.opts.detached, undefined);
  assert.equal(win32DetachedPipeHang(oz.opts), false);
  healer.stop();
});

test('copyPackedRuntimeToHome copies NSIS extraResources node-pty and openzoo-claude', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-nsis-'));
  try {
    const resources = path.join(dir, 'resources');
    mkdirSync(path.join(resources, 'node-pty', 'build', 'Release'), { recursive: true });
    writeFileSync(path.join(resources, 'node-pty', 'package.json'), JSON.stringify({
      name: 'node-pty', version: '1.1.0', main: 'lib/index.js',
    }));
    writeFileSync(path.join(resources, 'node-pty', 'build', 'Release', 'pty.node'), Buffer.from([0]));
    mkdirSync(path.join(resources, 'openzoo-claude'), { recursive: true });
    writeFileSync(path.join(resources, 'openzoo-claude', 'package.json'), JSON.stringify({
      name: 'openzoo-claude', version: '2.0.2',
    }));
    const home = path.join(dir, 'home');
    const copied = copyPackedRuntimeToHome({
      resourcesPath: resources,
      env: { HOME: home, USERPROFILE: home },
    });
    assert.equal(copied.length, 2);
    assert.equal(packedRuntimeHome({ HOME: home }), path.join(home, '.openzoo', 'packed'));
    assert.equal(existsSync(path.join(home, '.openzoo', 'packed', 'node-pty', 'package.json')), true);
    assert.equal(existsSync(path.join(home, '.openzoo', 'packed', 'node-pty', 'build', 'Release', 'pty.node')), true);
    assert.equal(existsSync(path.join(home, '.openzoo', 'packed', 'openzoo-claude', 'package.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolvePackedNode finds extraResources node.exe before PATH', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oz-packed-node-'));
  try {
    const resources = path.join(dir, 'resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(resources, 'node.exe'), '');
    const env = { HOME: dir, USERPROFILE: dir, OZ_PACKED_RESOURCES: resources, PATH: 'C\\\\Windows' };
    const got = resolvePackedNode(env, existsSync, path.join(dir, 'openzoo.exe'));
    assert.equal(got, path.join(resources, 'node.exe'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
