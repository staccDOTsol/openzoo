'use strict';

// Keep the packed :8402 sidecar alive after launch.
// Occupied TCP is not health — /v1/session must answer. Occupied + null
// session is wedged: displace then spawn (same as a stale version). Do not
// attach. Empty-wallet HTTP 402 still means the sidecar is up (Pay opens).
// Do not pkill/relaunch the Electron window to heal — only this child.
//
// macOS/Linux: prefer host Node running the packed bin so the sidecar is
// NOT the .app binary (it survives window close / Cmd+Q). Electron-as-node
// is fallback when no host Node exists, then `openzoo` on PATH.
//
// win32: packed Electron-as-node / packed node.exe FIRST. A PATH node.exe
// (Store stub, wrong ABI, missing modules) must not win. Spawn of
// openzoo.cmd without shell:true is EINVAL; detached:true + piped stdio
// hangs. Heal must boot :8402 without a host Node.
//
// Healer.stop() drops health timers only — it must not SIGTERM a healthy
// detached sidecar. before-quit must leave :8402 listening.

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
    OPENZOO_PORT: env.OPENZOO_PORT || '8402',
    OPENZOO_NO_PORT_WALK: '1',
  };
}

function hostNodeSidecarEnv(env = process.env) {
  const next = {
    ...env,
    OPENZOO_SILENT: '1',
    OPENZOO_NO_OPEN: env.OPENZOO_NO_OPEN || '1',
    OPENZOO_PORT: env.OPENZOO_PORT || '8402',
    OPENZOO_NO_PORT_WALK: '1',
  };
  delete next.ELECTRON_RUN_AS_NODE;
  return next;
}

function win32NeedsShell(cmd) {
  return /\.(cmd|bat)$/i.test(String(cmd || ''));
}

function win32DetachedPipeHang({ detached, stdio } = {}) {
  if (!detached) return false;
  const io = Array.isArray(stdio) ? stdio : [];
  return io.some((s) => s === 'pipe');
}

function sidecarSpawnOpts(env, {
  electronAsNode = true,
  detached = !electronAsNode,
  platform = process.platform,
  cmd = '',
} = {}) {
  const opts = {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: electronAsNode ? packedSidecarEnv(env) : hostNodeSidecarEnv(env),
    windowsHide: true,
  };
  if (platform === 'win32') {
    // detached + piped stdio hangs on Windows. Keep stderr piped so
    // MODULE_NOT_FOUND / EINVAL can mark the spawn kind unbootable.
    if (win32NeedsShell(cmd)) opts.shell = true;
    return opts;
  }
  if (detached) opts.detached = true;
  return opts;
}

function packedSidecarSpawnOpts(env = process.env, extras = {}) {
  return sidecarSpawnOpts(env, { electronAsNode: true, detached: false, ...extras });
}

function hostNodeSidecarSpawnOpts(env = process.env, extras = {}) {
  const platform = extras.platform || process.platform;
  return sidecarSpawnOpts(env, {
    electronAsNode: false,
    ...extras,
    platform,
    detached: extras.detached != null ? extras.detached : platform !== 'win32',
  });
}

function isCannotLoadOutput(text) {
  return MODULE_NOT_FOUND_RE.test(String(text || ''));
}

function isUnbootableSpawnError(err) {
  const code = err && err.code;
  if (code === 'ENOENT' || code === 'EINVAL' || code === 'UNKNOWN') return true;
  return isCannotLoadOutput(err && err.message);
}

function looksLikeModuleNotFound(text) {
  return isCannotLoadOutput(text);
}

function isImmediateExit(startedAt, code, now = Date.now()) {
  if (code === 0) return false;
  if (!startedAt) return false;
  return (now - startedAt) <= IMMEDIATE_EXIT_MS;
}

function exeName(base) {
  return process.platform === 'win32' ? `${base}.exe` : base;
}

function pathOpenzooName(platform = process.platform) {
  return platform === 'win32' ? 'openzoo.cmd' : 'openzoo';
}

function existsDefault(p) {
  return fs.existsSync(p);
}

function whichOnPath(name, env = process.env, exists = existsDefault) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

function listNvmNodes(env = process.env, exists = existsDefault) {
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
    .filter((p) => exists(p));
}

// First-run grokui / nvm-less Macs land node at ~/.local/bin (Finder PATH
// is /usr/bin:/bin:/usr/sbin:/sbin — no homebrew). Check it before PATH.
// Windows uses the same ~/.local/bin/node.exe layout (USERPROFILE).
function localBinNode(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.local', 'bin', exeName('node'));
}

function resolveHostNode(env = process.env, exists = existsDefault) {
  const node = exeName('node');
  const nvm = listNvmNodes(env, exists);
  const prefer24 = nvm.find((p) => /[/\\]v24\./.test(p) || /[/\\]v24[/\\]/.test(p));
  const hardcoded = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ].filter((p) => exists(p));
  const local = localBinNode(env);
  const fromLocal = exists(local) ? local : null;
  const fromPath = whichOnPath(node, env, exists);
  const ordered = [prefer24, ...nvm, ...hardcoded, fromLocal, fromPath].filter(Boolean);
  const seen = new Set();
  for (const p of ordered) {
    if (seen.has(p)) continue;
    seen.add(p);
    return p;
  }
  return null;
}

function resolvePathOpenzoo(env = process.env, exists = existsDefault, platform = process.platform) {
  return whichOnPath(pathOpenzooName(platform), env, exists)
    || whichOnPath('openzoo', env, exists)
    || (platform === 'win32' ? whichOnPath('openzoo.exe', env, exists) : null);
}

function resolvePackedNode(env = process.env, exists = existsDefault, execPath = '') {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  // Packed Windows trees ship node.exe; unit tests on darwin/linux still
  // need to resolve that layout. Prefer the platform exe, then the other.
  const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node', 'node.exe'];
  const roots = [];
  if (execPath) {
    const dir = path.dirname(execPath);
    roots.push(dir, path.join(dir, 'resources'), path.join(dir, 'resources', 'node'));
  }
  if (env.OZ_PACKED_RESOURCES) {
    roots.push(env.OZ_PACKED_RESOURCES, path.join(env.OZ_PACKED_RESOURCES, 'node'));
  }
  roots.push(
    path.join(home, '.openzoo', 'packed'),
    path.join(home, '.local', 'bin'),
  );
  const seen = new Set();
  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      if (seen.has(candidate) || (execPath && path.resolve(candidate) === path.resolve(execPath))) {
        continue;
      }
      seen.add(candidate);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

function packedRuntimeHome(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, '.openzoo', 'packed');
}

function copyPackedRuntimeToHome({
  resourcesPath,
  appDir,
  env = process.env,
  exists = existsDefault,
  mkdir = (p) => fs.mkdirSync(p, { recursive: true }),
  rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* none */ } },
  cp = (from, to) => fs.cpSync(from, to, { recursive: true, dereference: true }),
} = {}) {
  const destRoot = packedRuntimeHome(env);
  const copied = [];
  for (const name of ['node-pty', 'openzoo-claude']) {
    const candidates = [
      resourcesPath && path.join(resourcesPath, name),
      resourcesPath && path.join(resourcesPath, 'app', 'node_modules', name),
      appDir && path.join(appDir, 'node_modules', name),
    ].filter(Boolean);
    const from = candidates.find((p) => exists(path.join(p, 'package.json')));
    if (!from) continue;
    const dest = path.join(destRoot, name);
    if (path.resolve(from) === path.resolve(dest)) continue;
    mkdir(destRoot);
    rm(dest);
    cp(from, dest);
    copied.push({ name, from, dest });
  }
  return copied;
}

function defaultSpawnMode(env = process.env, resolveHostNodeFn = resolveHostNode, platform = process.platform) {
  if (platform === 'win32') return 'packed';
  return resolveHostNodeFn(env) ? 'host-node' : 'packed';
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
  resolvePackedNode: resolvePackedNodeFn = resolvePackedNode,
  platform = process.platform,
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
  // host-node | packed | packed-node | path-openzoo
  let spawnMode = defaultSpawnMode(env, resolveHostNodeFn, platform);
  let packedUnbootable = false;
  let packedNodeUnbootable = false;
  let hostNodeUnbootable = false;
  let pathOpenzooUnbootable = false;
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
    // Do NOT unref the health poll. unref() let the keep-alive evaporate
    // once the window went idle / Electron had no other handles.
  }

  function bumpBackoff() {
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoffMs);
    return delay;
  }

  function spawnSpec(kind, cmd, args, electronAsNode) {
    spawnMode = kind === 'packed-node' ? 'packed' : kind;
    return {
      kind,
      cmd,
      args,
      opts: sidecarSpawnOpts(env, {
        electronAsNode,
        detached: platform !== 'win32' && !electronAsNode,
        platform,
        cmd,
      }),
    };
  }

  function pickSpawn() {
    const order = platform === 'win32'
      ? ['packed', 'packed-node', 'host-node', 'path-openzoo']
      : ['host-node', 'packed', 'path-openzoo'];
    for (const kind of order) {
      if (kind === 'packed' && packedUnbootable) continue;
      if (kind === 'packed-node' && packedNodeUnbootable) continue;
      if (kind === 'host-node' && hostNodeUnbootable) continue;
      if (kind === 'path-openzoo' && pathOpenzooUnbootable) continue;
      if (kind === 'packed') return spawnSpec('packed', execPath, [binPath], true);
      if (kind === 'packed-node') {
        const node = resolvePackedNodeFn(env, existsDefault, execPath);
        if (!node) continue;
        return spawnSpec('packed-node', node, [binPath], false);
      }
      if (kind === 'host-node') {
        const node = resolveHostNodeFn(env);
        if (!node) continue;
        return spawnSpec('host-node', node, [binPath], false);
      }
      if (kind === 'path-openzoo') {
        const oz = resolvePathOpenzooFn(env);
        if (!oz) continue;
        return spawnSpec('path-openzoo', oz, [], false);
      }
    }
    return spawnSpec('packed', execPath, [binPath], true);
  }

  function markUnbootable(kind, reason) {
    if (kind === 'packed') {
      packedUnbootable = true;
      spawnMode = platform === 'win32' ? 'packed' : (hostNodeUnbootable ? 'path-openzoo' : 'host-node');
      log(`[openzoo] packed sidecar cannot load (${reason}) — falling back to packed node / host node / PATH openzoo`);
      return;
    }
    if (kind === 'packed-node') {
      packedNodeUnbootable = true;
      spawnMode = hostNodeUnbootable ? 'path-openzoo' : 'host-node';
      log(`[openzoo] packed node.exe cannot load (${reason}) — falling back to host node / PATH openzoo`);
      return;
    }
    if (kind === 'host-node') {
      hostNodeUnbootable = true;
      spawnMode = packedUnbootable ? 'path-openzoo' : 'packed';
      log(`[openzoo] host-node packed bin cannot load (${reason}) — falling back to packed electron / PATH openzoo`);
      return;
    }
    if (kind === 'path-openzoo') {
      pathOpenzooUnbootable = true;
      spawnMode = packedUnbootable ? 'host-node' : 'packed';
      log(`[openzoo] PATH openzoo cannot load (${reason}) — falling back`);
    }
  }

  function spawnSidecar() {
    const spec = pickSpawn();
    let childProc;
    try {
      childProc = spawn(spec.cmd, spec.args, spec.opts);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      log('[openzoo] proxy failed to start:', msg);
      if (isUnbootableSpawnError(e) || isCannotLoadOutput(msg)) {
        markUnbootable(spec.kind, msg || (e && e.code));
      }
      owned = null;
      return null;
    }
    if (!childProc) {
      markUnbootable(spec.kind, 'spawn returned empty');
      owned = null;
      return null;
    }
    owned = childProc;
    lastSpawnHealthy = false;
    childProc._ozKind = spec.kind;
    childProc._ozStartedAt = Date.now();
    childProc._ozDetached = Boolean(spec.opts && spec.opts.detached);
    let stderr = '';
    if (childProc.stderr && typeof childProc.stderr.on === 'function') {
      childProc.stderr.on('data', (buf) => {
        stderr += String(buf);
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });
    }
    // Detached host-node / PATH children should outlive the app. unref the
    // child handle — never the health timer.
    if (spec.opts && spec.opts.detached && typeof childProc.unref === 'function') {
      childProc.unref();
    }
    childProc.on('error', (e) => {
      const msg = e && e.message;
      log('[openzoo] proxy failed to start:', msg);
      if (isUnbootableSpawnError(e) || isCannotLoadOutput(msg)) {
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
      // /v1/session timeout (2–3s) == dead. LISTEN alone is not health.
      // A wedged owned child can peg CPU / block the event loop and still
      // look "alive". Kill THAT sidecar only — never pkill OCC / openzoo-claude PTYs.
      const starting = owned && !lastSpawnHealthy && owned._ozStartedAt
        && (Date.now() - owned._ozStartedAt) < 8000;
      if (owned && !session && !starting) {
        log('[openzoo] /v1/session timeout — owned :8402 is dead; killing sidecar only (not OCC PTYs)');
        try { owned.kill(); } catch { /* gone */ }
        owned = null;
        lastSpawnHealthy = false;
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
      // Occupied + null session is a leftover / TIME_WAIT / half-killed
      // Electron-as-node child — not a live sidecar. Same as stale-version:
      // displace, then spawn. Do not attach. 402 already returned above.
      if (await portOccupied()) {
        log('[openzoo] :8402 is listening but /v1/session did not answer — not reusing a wedged proxy; displacing then spawning');
        const displaced = await displaceStale(8402);
        if (!displaced) {
          log('[openzoo] failed to displace wedged :8402 — refusing to attach');
          schedule(bumpBackoff());
          return { reused: false, healthy: false, wedged: true, child: null };
        }
      }
      spawnSidecar();
      if (!owned) {
        schedule(bumpBackoff());
        return { reused: false, healthy: false, wedged: false, child: null, spawned: false, spawnMode };
      }
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

  // Drop health timers only. Do not SIGTERM a healthy detached sidecar —
  // :8402 must stay up after launch / window close / Cmd+Q. before-quit
  // calls this so the keep-alive poll does not outlive the GUI; the child
  // (host Node + packed bin) keeps listening.
  function stop() {
    stopped = true;
    if (timer) { clearTimeoutFn(timer); timer = null; }
    nextAt = 0;
  }

  return { ensure, stop, schedule, spawnSidecar, child, getSpawnMode: () => spawnMode };
}

module.exports = {
  createSidecarHealer,
  packedSidecarEnv,
  packedSidecarSpawnOpts,
  hostNodeSidecarEnv,
  hostNodeSidecarSpawnOpts,
  sidecarSpawnOpts,
  shouldAttach,
  isCannotLoadOutput,
  looksLikeModuleNotFound,
  isImmediateExit,
  isUnbootableSpawnError,
  win32NeedsShell,
  win32DetachedPipeHang,
  resolveHostNode,
  resolvePathOpenzoo,
  resolvePackedNode,
  copyPackedRuntimeToHome,
  packedRuntimeHome,
  whichOnPath,
  localBinNode,
  pathOpenzooName,
  defaultSpawnMode,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  HEALTH_MS,
  IMMEDIATE_EXIT_MS,
};
