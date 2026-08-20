import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  createSidecarHealer,
  packedSidecarEnv,
  packedSidecarSpawnOpts,
  shouldAttach,
} = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grokui-app', 'sidecar-heal.js'),
);
const { sidecarIsAttachable } = require(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'grokui-app', 'sidecar-version.js'),
);

function fakeChild() {
  const c = new EventEmitter();
  c.killed = false;
  c.kill = () => {
    c.killed = true;
    c.emit('exit', 1, null);
  };
  return c;
}

function fakeTimers() {
  const pending = [];
  const setTimeoutFn = (fn, ms) => {
    const t = { fn, ms, cancelled: false };
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
    spawn: (_cmd, args, opts) => {
      const c = fakeChild();
      spawned.push({ args, opts, child: c });
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
  assert.equal(opts.stdio, 'ignore');
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

test('occupied-but-dead port is wedged and does not spawn', async () => {
  const { healer, spawned } = makeHealer({
    fetchSession: async () => null,
    portOccupied: async () => true,
  });
  const result = await healer.ensure();
  assert.equal(result.wedged, true);
  assert.equal(result.healthy, false);
  assert.equal(spawned.length, 0);
  healer.stop();
});

test('free port spawns Electron execPath + packed openzoo.js', async () => {
  const { healer, spawned } = makeHealer();
  const result = await healer.ensure();
  assert.equal(result.spawned, true);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, ['/fake/node_modules/openzoo/bin/openzoo.js']);
  assert.equal(spawned[0].opts.stdio, 'ignore');
  assert.equal(spawned[0].opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawned[0].opts.env.OPENZOO_SILENT, '1');
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

test('stop() kills the child and does not respawn', async () => {
  const { healer, spawned, timers } = makeHealer();
  await healer.ensure();
  healer.stop();
  assert.equal(spawned[0].child.killed, true);
  await timers.flush();
  assert.equal(spawned.length, 1);
});

test('stale listener is displaced then packed sidecar is spawned', async () => {
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
