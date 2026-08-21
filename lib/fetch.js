/**
 * Time-to-first-byte for hops to x402-tokens.fly.dev / OpenRouter.
 *
 * Completions keep a long headers wait (stream). Probes (session/models/
 * credits) use a short cap + their own undici Agent so a hung fly keep-alive
 * cannot make GET /v1/session look dead. Do not set fetch `family` here;
 * Happy Eyeballs + ipv4first live in bin/openzoo.js.
 */
import { createRequire } from 'node:module';

export const HEADERS_MS = Number(process.env.OPENZOO_UPSTREAM_HEADERS_MS || 120_000);
export const UPSTREAM_HEADERS_MS = HEADERS_MS;
export const CREDIT_TIMEOUT_MS = Number(process.env.OPENZOO_CREDIT_TIMEOUT_MS || 2_500);
export const PROBE_HEADERS_MS = Number(process.env.OPENZOO_PROBE_HEADERS_MS || 2_500);

export function headersMs() {
  const n = Number(process.env.OPENZOO_UPSTREAM_HEADERS_MS || 120_000);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

function makeAgents() {
  try {
    const require = createRequire(import.meta.url);
    let Agent;
    try { ({ Agent } = require('undici')); }
    catch { ({ Agent } = require('node:undici')); }
    if (!Agent) return { fly: undefined, probe: undefined };
    return {
      fly: new Agent({ connections: 16, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 60_000, pipelining: 1 }),
      probe: new Agent({ connections: 4, keepAliveTimeout: 1_000, keepAliveMaxTimeout: 4_000, pipelining: 0 }),
    };
  } catch {
    return { fly: undefined, probe: undefined };
  }
}

const agents = makeAgents();
export const flyDispatcher = agents.fly;
export const probeDispatcher = agents.probe;

function mergeSignal(existing, timeout) {
  if (!existing) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([existing, timeout]);
  const c = new AbortController();
  const abort = () => { try { c.abort(); } catch { /* already */ } };
  if (existing.aborted || timeout.aborted) { abort(); return c.signal; }
  existing.addEventListener('abort', abort, { once: true });
  timeout.addEventListener('abort', abort, { once: true });
  return c.signal;
}

async function fetchWithDispatcher(url, init, ms, dispatcher) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      ...init,
      signal: mergeSignal(init.signal, ac.signal),
      ...(dispatcher ? { dispatcher } : {}),
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/** Completions / long streams. Isolated fly Agent. Default 120s headers. */
export async function fetchHeaders(url, init = {}, ms = headersMs()) {
  return fetchWithDispatcher(url, init, ms, flyDispatcher);
}

/** session / models / credits. Own Agent + 2.5s cap. Never the fly pool. */
export async function fetchProbe(url, init = {}, ms = PROBE_HEADERS_MS) {
  return fetchWithDispatcher(url, init, ms, probeDispatcher);
}

/** First try + these delays ≈ 5 retries. Jitter ~0.2. */
export const FETCH_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000, 2000, 4000]);

export function isRetryableFetchError(err) {
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || '');
  const code = String(err.code || err.cause?.code || '');
  const blob = `${name} ${msg} ${code}`;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (msg === 'fetch failed' || /fetch failed/i.test(msg)) return true;
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|UND_ERR/i.test(blob)) return true;
  return false;
}

export function isRetryableHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** 400 / 401 / 402 (pay) / 403 / 404 and other 4xx except 429 — do not retry. */
export function isNoRetryHttpStatus(status) {
  const n = Number(status);
  if (n === 429) return false;
  return n >= 400 && n < 500;
}

function jitterMs(base, jitter = 0.2) {
  const j = Number.isFinite(jitter) ? jitter : 0.2;
  return Math.max(0, base * (1 + (Math.random() * 2 - 1) * j));
}

/**
 * Retry transient network / 429 / 5xx. Same body/headers each try.
 * Never retries a completed 200. Never retries 402 (pay) or other 4xx except 429.
 */
export async function fetchRetry(url, init = {}, opts = {}) {
  const delays = opts.delays || FETCH_RETRY_DELAYS_MS;
  const fetchImpl = opts.fetch || globalThis.fetch;
  const jitter = opts.jitter == null ? 0.2 : opts.jitter;
  const maxAttempts = delays.length + 1;
  let lastRes = null;
  let lastErr = null;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetchImpl(url, init);
      lastRes = res;
      if (res.ok || isNoRetryHttpStatus(res.status) || !isRetryableHttpStatus(res.status)) {
        return res;
      }
      lastErr = Object.assign(new Error('HTTP ' + res.status), { status: res.status, response: res });
    } catch (err) {
      lastErr = err;
      if (!isRetryableFetchError(err)) throw err;
    }
    if (i >= maxAttempts - 1) break;
    const wait = jitterMs(delays[Math.min(i, delays.length - 1)], jitter);
    opts.onRetry?.({ attempt: i + 1, wait, error: lastErr, response: lastRes });
    await new Promise((r) => setTimeout(r, wait));
  }
  opts.onGiveUp?.({ error: lastErr, response: lastRes });
  if (lastRes) return lastRes;
  throw lastErr;
}
