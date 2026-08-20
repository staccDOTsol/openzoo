/**
 * Time-to-first-byte for hops to x402-tokens.fly.dev / OpenRouter.
 *
 * A hung keep-alive (no headers) must not pin an undici socket forever —
 * that is what wedged GET /v1/session (LISTEN up, HTTP 000) while a
 * brainRace of 4 sat on the same pool. Once headers arrive, the body may
 * stream for as long as generation takes. Do not set fetch `family` here;
 * Happy Eyeballs + ipv4first live in bin/openzoo.js.
 */
export const HEADERS_MS = Number(process.env.OPENZOO_UPSTREAM_HEADERS_MS || 120_000);
export const UPSTREAM_HEADERS_MS = HEADERS_MS;
export const CREDIT_TIMEOUT_MS = Number(process.env.OPENZOO_CREDIT_TIMEOUT_MS || 2_500);

export function headersMs() {
  const n = Number(process.env.OPENZOO_UPSTREAM_HEADERS_MS || 120_000);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
}

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

/** fetch that aborts if headers have not arrived in `ms`, then lets the stream run. */
export async function fetchHeaders(url, init = {}, ms = headersMs()) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  timer.unref?.();
  try {
    const res = await fetch(url, {
      ...init,
      signal: mergeSignal(init.signal, ac.signal),
    });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}
