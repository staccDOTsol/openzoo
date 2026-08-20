/**
 * Per-request timeouts for every hop to x402-tokens.fly.dev / OpenRouter.
 *
 * Completions that wait forever pin undici sockets. The next GET /v1/session
 * then hangs if it shares that pool (or if it does its own outbound). A listen
 * on :8402 with a dead event loop is worse than a crash: ensureProxy used to
 * treat an occupied port as "reuse it".
 *
 * AbortSignal.timeout aborts connect, headers, body, AND the wait for a free
 * pooled socket — so a hung racer is TimeoutError / `fetch failed`, not a
 * stuck port. Do not set fetch `family` here; IPv6 blackhole handling (Happy
 * Eyeballs + ipv4first) lives in bin/openzoo.js.
 */
export function upstreamTimeoutMs() {
  const n = Number(process.env.OPENZOO_UPSTREAM_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

/** Short probes (credits, prices) — never the completion budget. */
export function probeTimeoutMs() {
  const n = Number(process.env.OPENZOO_UPSTREAM_PROBE_TIMEOUT_MS);
  if (Number.isFinite(n) && n > 0) return n;
  return Math.min(5_000, upstreamTimeoutMs());
}

export function mergeAbortSignals(existing, timeout) {
  if (!existing) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([existing, timeout]);
  const c = new AbortController();
  const abort = () => { try { c.abort(); } catch { /* already */ } };
  if (existing.aborted || timeout.aborted) { abort(); return c.signal; }
  existing.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return c.signal;
}

export function timedInit(init = {}, timeoutMs = upstreamTimeoutMs()) {
  return {
    ...init,
    signal: mergeAbortSignals(init.signal, AbortSignal.timeout(timeoutMs)),
  };
}

export function timedFetch(url, init = {}, { timeoutMs } = {}) {
  return fetch(url, timedInit(init, timeoutMs ?? upstreamTimeoutMs()));
}
