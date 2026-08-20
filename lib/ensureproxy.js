/**
 * Bring up (and keep up) the local :8402 proxy that grokui completions hit.
 *
 * Occupied TCP is not health. A LISTEN that does not answer GET /v1/session
 * within a short timeout is wedged — treating that as "reuse it" is why
 * Electron ended up with no working proxy child and grokui threw
 * `TypeError: fetch failed` / ECONNREFUSED (or hung session / HTTP 000).
 *
 * Do not kill a process we did not spawn (user's live sidecar stays up).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROXY_PORT = 8402;
export const SESSION_URL = 'http://127.0.0.1:8402/v1/session';

export function shouldReuseProxy({ sessionOk }) {
  return sessionOk === true;
}

export function pingSession({ url = SESSION_URL, timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const ok = Boolean(res.statusCode && res.statusCode < 500);
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export function portOccupied(port = PROXY_PORT, { timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(timeoutMs, () => { s.destroy(); resolve(false); });
  });
}

export function resolveProxyBin(here = path.dirname(fileURLToPath(import.meta.url))) {
  const checkout = path.join(here, '..', 'bin', 'openzoo.js');
  const bundled = path.join(here, '..', 'node_modules', 'openzoo', 'bin', 'openzoo.js');
  const electronBundled = path.join(here, 'node_modules', 'openzoo', 'bin', 'openzoo.js');
  for (const p of [checkout, bundled, electronBundled]) {
    if (existsSync(p)) return p;
  }
  throw new Error('openzoo proxy bin not found (checkout bin/openzoo.js or grokui-app/node_modules/openzoo)');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let owned = null;
let shuttingDown = false;
let respawnTimer = null;
let shutdownHooked = false;

function hookShutdown() {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const bye = () => { shuttingDown = true; stopOwned(); };
  process.once('exit', bye);
  process.once('SIGINT', bye);
  process.once('SIGTERM', bye);
}

function stopOwned() {
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  if (!owned) return;
  try { owned.kill(); } catch { /* already gone */ }
  owned = null;
}

/** Test seam: drop owned child + timers without killing a live sidecar. */
export function resetEnsureProxyForTest() {
  shuttingDown = false;
  stopOwned();
}

export function stopProxy() {
  shuttingDown = true;
  stopOwned();
}

export async function ensureProxy({
  execPath = process.execPath,
  bin,
  port = PROXY_PORT,
  sessionUrl = SESSION_URL,
  env = process.env,
  supervise = true,
  respawnMs = 1000,
  pingTimeoutMs = 1500,
  waitMs = 0,
  spawnImpl = spawn,
  log = console.error,
} = {}) {
  if (await pingSession({ url: sessionUrl, timeoutMs: pingTimeoutMs })) {
    return { reused: true, healthy: true, wedged: false, child: null };
  }
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    await sleep(100);
    if (await pingSession({ url: sessionUrl, timeoutMs: pingTimeoutMs })) {
      return { reused: true, healthy: true, wedged: false, child: null };
    }
  }
  if (await portOccupied(port)) {
    log('[openzoo] :' + port + ' is listening but /v1/session did not answer — not reusing a wedged proxy');
    return { reused: false, healthy: false, wedged: true, child: null };
  }

  const resolved = bin || resolveProxyBin();
  const spawnOnce = () => {
    const child = spawnImpl(execPath, [resolved], {
      stdio: 'inherit',
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        OPENZOO_NO_OPEN: env.OPENZOO_NO_OPEN || '1',
      },
      windowsHide: true,
    });
    owned = child;
    child.on('error', (e) => log('[openzoo] proxy failed to start:', e.message));
    if (supervise) {
      child.on('exit', (code, signal) => {
        if (owned === child) owned = null;
        if (shuttingDown) return;
        log(`[openzoo] proxy exited (${code ?? signal}) — respawning`);
        respawnTimer = setTimeout(() => {
          respawnTimer = null;
          ensureProxy({
            execPath, bin: resolved, port, sessionUrl, env, supervise, respawnMs,
            pingTimeoutMs, waitMs: 0, spawnImpl, log,
          }).catch((e) => log('[openzoo] proxy respawn failed:', e.message));
        }, respawnMs);
        respawnTimer.unref?.();
      });
    }
    return child;
  };

  hookShutdown();
  shuttingDown = false;
  const child = spawnOnce();
  return { reused: false, healthy: false, wedged: false, child, spawned: true };
}
