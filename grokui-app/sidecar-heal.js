'use strict';

// Keep the packed :8402 sidecar alive for as long as grokui's window is open.
// Occupied TCP is not health — /v1/session must answer. Empty-wallet HTTP 402
// still means the sidecar is up (Pay opens; that is not "sidecar dead").
// Do not pkill/relaunch the Electron window to heal — only this child.
//
// First spawn is Electron execPath + packed bin. If that cannot load
// (MODULE_NOT_FOUND / immediate exit), fall back to a real Node on PATH
// (nvm Node 24, homebrew) running the same packed bin, then `openzoo` on
// PATH. Do not sit forever restarting a bin that cannot boot.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8000;
const HEALTH_MS = 2000;
const IMMEDIATE_EXIT_MS = 2000;

const MODULE_NOT_FOUND_RE = /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module/i;

function packedSidecarEnv(env = process.env) {
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1',
    // silent:true writes 400s / receipts to ~/.openzoo/proxy.log. Electron
    // spawn stdio inherit + /dev/null used to eat those lines.
    OPENZOO_SILENT: '1',
    OPENZOO_NO_OPEN: env.OPENZOO_NO_OPEN || '1',
  };
}

function hostNodeSidecarEnv(env = process.env) {
  const next = {
    ...env,
    OPENZOO_SILENT: '1',
    OPENZOO_NO_OPEN: env.OPENZOO_NO_OPEN || '1',
  };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function sidecarSpawnOpts(env, { electronAsNode = true } = {}) {
  return {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: electronAsNode ? packedSidecarEnv(env) : hostNodeSidecarEnv(env),
    windowsHide: true,
  };
}

function packedSidecarSpawnOpts(env = process.env) {
  return sidecarSpawnOpts(env, { electronAsNode: true });
}

function isCannotLoadOutput(text) {
  return MODULE_NOT_FOUND_RE.test(String(text || ''));
}

function isImmediateExit(startedAt, code, now = Date.now()) {
  if (code === 0) return false;
  if (!startedAt) return false;
  return (now - startedAt) <= IMMEDIATE_EXIT_MS;
}

function exeName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

function pathOpenzooName() {
  return process.platform === 'win32' ? 'openzoo.cmd' : 'openzoo';
}

function whichOnPath(name, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function listNvmNodes(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const nvm = env.NVM_DIR || path.join(home, '.nvm');
  const versions = path.join(nvm, 'versions', 'node');
  let dirs = [];
  try { dirs = fs.readdirSync(versions); } catch { return []; }
  const node = exeName('node');
  return dirs
    .filter((d) => /^v\d+/.test(d))
    .sort((a, b) => parseInt(b.slice(1), 10) - parseInt(a.slice(1), 10))
    .map((d) => path.join(versions, d, 'bin', node))
    .filter((p) => fs.existsSync(p));
}

function resolveHostNode(env = process.env) {
  const node = exeName('node');
  const nvm = listNvmNodes(env);
  const prefer24 = nvm.find((p) => /[/\\]v24\./.test(p) || /[/\\]v24[/\\]/.test(p));
  const hardcoded = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter((p) => fs.existsSync(p));
  const fromPath = whichOnPath(node, env);
  const ordered = [prefer24, ...nvm, ...hardcoded, fromPath].filter(Boolean);
  const seen = new Set();
  for (const p of ordered) {
    if (seen.has(p)) continue;
    seen.add(p);
    return p;
  }
  return null;
}

function resolvePathOpenzoo(env = process.env) {
  return whichOnPath(pathOpenzooName(), env)
    || whichOnPath('openzoo', env);
}

// Reuse only a healthy :8402. Starting a second bundled proxy resets
// session counters and can race the one that already paid — but a process
// that LISTENs and does not answer GET /v1/session is wedged. Treating
// "port occupied" as reuse is worse than a crash (completions then throw
// undici `fetch failed` forever). Ping must time out; occupied ≠ healthy.
// Occupied+healthy is not enough: compare the listener's openzoo version
// to grokui-app's expected/shipped version.
function shouldAttach(session, { sidecarIsAttachable, expectedVersion } = {}) {
  if (!session) return false;
  // Empty-wallet 402 still opens Pay — that is not "sidecar dead".
  if (session.paymentRequired) return true;
  const expected = typeof expectedVersion === 'function' ? expectedVersion() : expectedVersion;
  if (typeof sidecarIsAttachable === 'function') {
    return sidecarIsAttachable({ listenerVersion: session.version, expectedVersion: expected });
  }
  return true;
}

function createSidecarHealer({
  spawn,
  execPath,
  binPath,
  fetchSession,
  portOccupied,
  displaceStale,
  sidecarIsAttachable,
  expectedVersion,
  waitForSession,
  resolveHostNode: resolveHostNodeFn = resolveHostNode,
  resolvePathOpenzoo: resolvePathOpenzooFn = resolvePathOpenzoo,
  log = console.error,
  env = process.env,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
  healthMs = HEALTH_MS,
} = {}) {
  let owned = null;
  let ensuring = false;
  let stopped = false;
  let timer = null;
  let nextAt = 0;
  let backoff = backoffMs;
  // packed | host-node | path-openzoo
  let spawnMode = 'packed';
  let packedUnbootable = false;
  let lastSpawnHealthy = false;

  function child() { return owned; }

  function schedule(ms) {
    if (stopped) return;
    const when = Date.now() + ms;
    if (timer && nextAt && nextAt <= when) return;
    if (timer) clearTimeoutFn(timer);
    nextAt = when;
    timer = setTimeoutFn(() => {
      timer = null;
      nextAt = 0;
      return ensure();
    }, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function bumpBackoff() {
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoffMs);
    return delay;
  }

  function pickSpawn() {
    if (spawnMode === 'packed' && packedUnbootable) spawnMode = 'host-node';
    if (spawnMode === 'host-node') {
      const node = resolveHostNodeFn(env);
      if (node) {
        return {
          kind: 'host-node',
          cmd: node,
          args: [binPath],
          opts: sidecarSpawnOpts(env, { electronAsNode: false }),
        };
      }
      spawnMode = 'path-openzoo';
    }
    if (spawnMode === 'path-openzoo') {
      const oz = resolvePathOpenzooFn(env);
      if (oz) {
        return {
          kind: 'path-openzoo',
          cmd: oz,
          args: [],
          opts: sidecarSpawnOpts(env, { electronAsNode: false }),
        };
      }
      const node = resolveHostNodeFn(env);
      if (node) {
        spawnMode = 'host-node';
        return {
          kind: 'host-node',
          cmd: node,
          args: [binPath],
          opts: sidecarSpawnOpts(env, { electronAsNode: false }),
        };
      }
    }
    return {
      kind: 'packed',
      cmd: execPath,
      args: [binPath],
      opts: packedSidecarSpawnOpts(env),
    };
  }

  function markUnbootable(kind, reason) {
    if (kind === 'packed') {
      packedUnbootable = true;
      spawnMode = 'host-node';
      log(`[openzoo] packed sidecar cannot load (${reason}) — falling back to host node / PATH openzoo`);
      return;
    }
    if (kind === 'host-node') {
      spawnMode = 'path-openzoo';
      log(`[openzoo] host-node packed bin cannot load (${reason}) — falling back to PATH openzoo`);
    }
  }

  function spawnSidecar() {
    const spec = pickSpawn();
    const childProc = spawn(spec.cmd, spec.args, spec.opts);
    owned = childProc;
    lastSpawnHealthy = false;
    childProc._ozKind = spec.kind;
    childProc._ozStartedAt = Date.now();
    let stderr = '';
    if (childProc.stderr && typeof childProc.stderr.on === 'function') {
      childProc.stderr.on('data', (buf) => {
        stderr += String(buf);
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
    }
    childProc.on('error', (e) => {
      const msg = e && e.message;
      log('[openzoo] proxy failed to start:', msg);
      if (isCannotLoadOutput(msg) || (e && e.code === 'ENOENT')) {
        markUnbootable(spec.kind, msg || e.code);
      }
    });
    childProc.on('exit', (code, signal) => {
      if (owned !== childProc) return;
      owned = null;
      if (stopped) return;
      const cannotLoad = isCannotLoadOutput(stderr)
        || (!lastSpawnHealthy && isImmediateExit(childProc._ozStartedAt, code));
      if (cannotLoad) markUnbootable(spec.kind, isCannotLoadOutput(stderr) ? 'MODULE_NOT_FOUND' : `immediate exit ${code ?? signal}`);
      log(`[openzoo] sidecar exited (${code ?? signal}) — respawning`);
      schedule(backoff);
    });
    return childProc;
  }

  async function ensure() {
    if (stopped || ensuring) return { skipped: true };
    ensuring = true;
    try {
      const session = await fetchSession();
      if (shouldAttach(session, { sidecarIsAttachable, expectedVersion })) {
        backoff = backoffMs;
        schedule(healthMs);
        return { reused: true, healthy: true, wedged: false, child: null };
      }
      if (session) {
        const expected = typeof expectedVersion === 'function' ? expectedVersion() : expectedVersion;
        log(
          `[openzoo] :8402 is a stale sidecar (openzoo ${session.version || 'unknown'} < ${expected}) — not attaching; grokui will spawn the matching one`,
        );
        const displaced = await displaceStale(8402);
        if (!displaced) {
          log('[openzoo] failed to displace stale :8402 — refusing to attach');
          schedule(bumpBackoff());
          return { reused: false, healthy: false, wedged: false, child: owned };
        }
        if (owned) {
          try { owned.kill(); } catch { /* already gone */ }
          owned = null;
        }
      }
      // Our child is still starting (or hung). Do not treat that as wedged
      // and do not spawn a second packed sidecar over it.
      if (owned) {
        schedule(healthMs);
        return { reused: false, healthy: false, wedged: false, child: owned };
      }
      if (await portOccupied()) {
        log('[openzoo] :8402 is listening but /v1/session did not answer — not reusing a wedged proxy');
        schedule(bumpBackoff());
        return { reused: false, healthy: false, wedged: true, child: null };
      }
      spawnSidecar();
      const up = waitForSession
        ? await waitForSession(() => stopped || !owned)
        : true;
      if (up) {
        lastSpawnHealthy = true;
        backoff = backoffMs;
        schedule(healthMs);
        return { reused: false, healthy: true, wedged: false, child: owned, spawned: true, spawnMode };
      }
      schedule(bumpBackoff());
      return { reused: false, healthy: false, wedged: false, child: owned, spawned: true, spawnMode };
    } catch (e) {
      log('[openzoo] proxy ensure failed:', e && e.message);
      schedule(bumpBackoff());
      return { reused: false, healthy: false, error: e };
    } finally {
      ensuring = false;
    }
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeoutFn(timer); timer = null; }
    nextAt = 0;
    const proc = owned;
    owned = null;
    if (proc) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  }

  return { ensure, stop, schedule, spawnSidecar, child, getSpawnMode: () => spawnMode };
}

module.exports = {
  createSidecarHealer,
  packedSidecarEnv,
  packedSidecarSpawnOpts,
  hostNodeSidecarEnv,
  sidecarSpawnOpts,
  shouldAttach,
  isCannotLoadOutput,
  isImmediateExit,
  resolveHostNode,
  resolvePathOpenzoo,
  whichOnPath,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  HEALTH_MS,
  IMMEDIATE_EXIT_MS,
};
