import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  shouldReuseProxy, pingSession, portOccupied, resolveProxyBin,
  ensureProxy, resetEnsureProxyForTest, stopProxy,
} from '../lib/ensureproxy.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try { server.closeAllConnections?.(); } catch { /* already */ }
    server.close(() => resolve());
    setTimeout(resolve, 300).unref?.();
  });
}

describe('ensureProxy health + supervise', { concurrency: 1 }, () => {
  test('occupied TCP is not reuse — only a live /v1/session', () => {
    assert.equal(shouldReuseProxy({ sessionOk: true, portOccupied: true }), true);
    assert.equal(shouldReuseProxy({ sessionOk: false, portOccupied: true }), false);
    assert.equal(shouldReuseProxy({ sessionOk: false, portOccupied: false }), false);
  });

  test('checkout resolveProxyBin finds bin/openzoo.js', () => {
    const bin = resolveProxyBin();
    assert.equal(bin, path.join(root, 'bin', 'openzoo.js'));
    assert.equal(fs.existsSync(bin), true);
  });

  test('occupied-but-dead port is not treated as healthy and does not spawn', async () => {
    const hung = await listen(() => { /* accept, never write */ });
    try {
      const port = hung.address().port;
      const url = `http://127.0.0.1:${port}/v1/session`;
      const t0 = Date.now();
      const ok = await pingSession({ url, timeoutMs: 200 });
      assert.equal(ok, false);
      assert.ok(Date.now() - t0 < 800);
      assert.equal(await portOccupied(port), true);

      let spawned = 0;
      const result = await ensureProxy({
        port,
        sessionUrl: url,
        pingTimeoutMs: 200,
        waitMs: 0,
        spawnImpl: () => { spawned += 1; throw new Error('must not spawn over a wedged listen'); },
      });
      assert.equal(result.reused, false);
      assert.equal(result.healthy, false);
      assert.equal(result.wedged, true);
      assert.equal(spawned, 0);
    } finally {
      await closeServer(hung);
      resetEnsureProxyForTest();
    }
  });

  test('a session that 200s is reused and does not spawn', async () => {
    const live = await listen((req, res) => {
      if ((req.url || '').split('?')[0] === '/v1/session') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"spentUsd":0}');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    try {
      const port = live.address().port;
      let spawned = 0;
      const result = await ensureProxy({
        port,
        sessionUrl: `http://127.0.0.1:${port}/v1/session`,
        pingTimeoutMs: 400,
        waitMs: 0,
        spawnImpl: () => { spawned += 1; throw new Error('must not spawn over a healthy listen'); },
      });
      assert.equal(result.reused, true);
      assert.equal(result.healthy, true);
      assert.equal(result.wedged, false);
      assert.equal(spawned, 0);
    } finally {
      await closeServer(live);
      resetEnsureProxyForTest();
    }
  });

  test('if the child dies, ensureProxy respawns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-ensure-'));
    const script = path.join(dir, 'die.mjs');
    fs.writeFileSync(script, 'process.exit(1);\n');
    let n = 0;
    const spawnImpl = (cmd, args, opts) => {
      n += 1;
      return spawn(cmd, args, { ...opts, stdio: 'ignore' });
    };
    try {
      await ensureProxy({
        bin: script,
        port: 18900 + Math.floor(Math.random() * 500),
        sessionUrl: 'http://127.0.0.1:1/v1/session',
        pingTimeoutMs: 80,
        waitMs: 0,
        supervise: true,
        respawnMs: 40,
        spawnImpl,
        log: () => {},
      });
      await new Promise((r) => setTimeout(r, 180));
      assert.ok(n >= 2, `expected respawn, spawned ${n} time(s)`);
    } finally {
      stopProxy();
      resetEnsureProxyForTest();
    }
  });
});
