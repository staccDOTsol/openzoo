/**
 * A TCP LISTEN on :8402 is not health. Only GET /v1/session answering
 * quickly is. Occupied-port + hung session used to be treated as "reuse it"
 * by ensureProxy — worse than a crash, because grokui then fetch-fails forever.
 */
import http from 'node:http';

export function shouldReuseProxy({ sessionOk }) {
  return sessionOk === true;
}

export function pingHttp(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
