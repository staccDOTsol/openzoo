'use strict';

// Keep the packed :8402 sidecar alive for as long as grokui's window is open.
// Occupied TCP is not health — /v1/session must answer. Empty-wallet HTTP 402
// still means the sidecar is up (Pay opens; that is not "sidecar dead").
// Do not pkill/relaunch the Electron window to heal — only this child.

const DEFAULT_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 8000;
const HEALTH_MS = 2000;

function looksLikeModuleNotFound(text) {
  const s = String(text || '');
  return /ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND/.test(s);
}

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

function packedSidecarSpawnOpts(env = process.env) {
  return {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: packedSidecarEnv(env),
    windowsHide: true,
  };
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
  let fatal = false;
  let timer = null;
  let nextAt = 0;
  let backoff = backoffMs;

  function child() { return owned; }

  function schedule(ms) {
    if (stopped || fatal) return;
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

  function spawnSidecar() {
    // Same spawn as today: Electron execPath + node_modules/openzoo/bin/openzoo.js
    const childProc = spawn(execPath, [binPath], packedSidecarSpawnOpts(env));
    owned = childProc;
    let bootLog = '';
    const take = (buf) => {
      bootLog += String(buf);
      if (bootLog.length > 8000) bootLog = bootLog.slice(-8000);
    };
    if (childProc.stdout) childProc.stdout.on('data', take);
    if (childProc.stderr) childProc.stderr.on('data', take);
    childProc.on('error', (e) => {
      const msg = e && e.message;
      log('[openzoo] proxy failed to start:', msg);
      if (looksLikeModuleNotFound(msg) || looksLikeModuleNotFound(e && e.code)) {
        bootLog += `\n${msg || e.code}`;
        fatal = true;
        if (timer) { clearTimeoutFn(timer); timer = null; nextAt = 0; }
      }
    });
    childProc.on('exit', (code, signal) => {
      if (owned !== childProc) return;
      owned = null;
      if (stopped) return;
      if (looksLikeModuleNotFound(bootLog)) {
        fatal = true;
        if (timer) { clearTimeoutFn(timer); timer = null; nextAt = 0; }
        log(`[openzoo] sidecar MODULE_NOT_FOUND — not respawning:\n${bootLog.slice(-800)}`);
        return;
      }
      log(`[openzoo] sidecar exited (${code ?? signal}) — respawning`);
      schedule(backoff);
    });
    return childProc;
  }

  async function ensure() {
    if (stopped || ensuring || fatal) return { skipped: true };
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
        backoff = backoffMs;
        schedule(healthMs);
        return { reused: false, healthy: true, wedged: false, child: owned, spawned: true };
      }
      schedule(bumpBackoff());
      return { reused: false, healthy: false, wedged: false, child: owned, spawned: true };
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
    fatal = true;
    if (timer) { clearTimeoutFn(timer); timer = null; }
    nextAt = 0;
    const proc = owned;
    owned = null;
    if (proc) {
      try { proc.kill(); } catch { /* already gone */ }
    }
  }

  return { ensure, stop, schedule, spawnSidecar, child };
}

module.exports = {
  createSidecarHealer,
  packedSidecarEnv,
  packedSidecarSpawnOpts,
  shouldAttach,
  looksLikeModuleNotFound,
  DEFAULT_BACKOFF_MS,
  MAX_BACKOFF_MS,
  HEALTH_MS,
};
