import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { timedFetch } from '../lib/upstream.js';
import { shouldReuseProxy, pingHttp } from '../lib/proxyhealth.js';
import { config } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-wedge-'));
const prev = {
  apiBase: config.apiBase,
  port: config.port,
  walletPath: config.walletPath,
  timeout: process.env.OPENZOO_UPSTREAM_TIMEOUT_MS,
  probe: process.env.OPENZOO_UPSTREAM_PROBE_TIMEOUT_MS,
  noTopup: process.env.OPENZOO_NO_AUTOTOPUP,
  sessionPath: process.env.OPENZOO_SESSION_PATH,
};

process.env.OPENZOO_NO_AUTOTOPUP = '1';
process.env.OPENZOO_NO_OPEN = '1';
process.env.OPENZOO_UPSTREAM_TIMEOUT_MS = '400';
process.env.OPENZOO_UPSTREAM_PROBE_TIMEOUT_MS = '200';
process.env.OPENZOO_SESSION_PATH = path.join(tmp, 'session.json');
config.walletPath = path.join(tmp, 'wallet.json');

function listenHung() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(() => { /* accept, never write */ });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try { server.closeAllConnections?.(); } catch { /* already */ }
    server.close(() => resolve());
    setTimeout(resolve, 500).unref?.();
  });
}

describe('proxy wedge', { concurrency: 1 }, () => {
test('shouldReuseProxy requires a live session, not just a listen', () => {
  assert.equal(shouldReuseProxy({ sessionOk: true, portOccupied: true }), true);
  assert.equal(shouldReuseProxy({ sessionOk: false, portOccupied: true }), false);
  assert.equal(shouldReuseProxy({ sessionOk: false, portOccupied: false }), false);
});

test('pingHttp times out on a listen that never answers', async () => {
  const hung = await listenHung();
  try {
    const t0 = Date.now();
    const ok = await pingHttp(`http://127.0.0.1:${hung.address().port}/v1/session`, { timeoutMs: 200 });
    assert.equal(ok, false);
    assert.ok(Date.now() - t0 < 800, `ping took ${Date.now() - t0}ms`);
    assert.equal(shouldReuseProxy({ sessionOk: ok, portOccupied: true }), false);
  } finally {
    await closeServer(hung);
  }
});

test('timedFetch aborts a hung upstream instead of waiting forever', async () => {
  const hung = await listenHung();
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => timedFetch(`http://127.0.0.1:${hung.address().port}/v1/credits`, {}, { timeoutMs: 150 }),
      (err) => err.name === 'TimeoutError' || /aborted|timeout/i.test(String(err.message)),
    );
    assert.ok(Date.now() - t0 < 800, `timedFetch took ${Date.now() - t0}ms`);
  } finally {
    await closeServer(hung);
  }
});

test('GET /v1/session stays fast while N completions hang on a dead upstream', async (t) => {
  const hung = await listenHung();
  const prevPort = config.port;
  const prevBase = config.apiBase;
  config.apiBase = `http://127.0.0.1:${hung.address().port}`;
  config.port = 0;
  process.env.OPENZOO_NO_AUTOTOPUP = '1';
  const { startProxy } = await import('../lib/proxy.js');
  const proxy = await startProxy({ silent: true, autoTunnel: false });
  t.after(async () => {
    await closeServer(proxy.server);
    await closeServer(hung);
    config.port = prevPort;
    config.apiBase = prevBase;
  });
  assert.ok(proxy.server, 'must bind a new listener, not reuse a wedged port');
  const port = proxy.server.address().port;

  const inflight = [];
  for (let i = 0; i < 8; i++) {
    inflight.push(fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openzoo/test',
        messages: [{ role: 'user', content: `hang-${i}` }],
      }),
    }).then(async (res) => {
      const text = await res.text();
      return { status: res.status, text };
    }).catch((err) => ({ error: err })));
  }

  const t0 = Date.now();
  const session = await fetch(`http://127.0.0.1:${port}/v1/session`, {
    signal: AbortSignal.timeout(200),
  });
  const ms = Date.now() - t0;
  assert.equal(session.status, 200);
  assert.ok(ms < 200, `GET /v1/session took ${ms}ms`);
  const body = await session.json();
  assert.equal(typeof body.spentUsd, 'number');
  assert.equal(typeof body.paidCalls, 'number');

  const results = await Promise.all(inflight);
  for (const r of results) {
    if (r.error) {
      assert.match(String(r.error.message || r.error), /aborted|timeout|fetch failed/i);
      continue;
    }
    assert.ok(r.status >= 500, `expected timeout 5xx, got ${r.status} ${r.text}`);
    assert.match(r.text, /timeout|aborted|Timeout/i);
  }
});

test('session handler never awaits credit/price outbound', () => {
  const src = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
  const start = src.indexOf("=== '/v1/session'");
  const end = src.indexOf("=== '/v1/wallet'");
  assert.ok(start > 0 && end > start);
  const block = src.slice(start, end);
  assert.match(block, /IN-MEMORY ONLY/);
  assert.doesNotMatch(block, /await refreshCredit/);
  assert.doesNotMatch(block, /await refreshPrices/);
  assert.doesNotMatch(block, /await creditBalance/);
});

});

test.after(() => {
  config.apiBase = prev.apiBase;
  config.port = prev.port;
  config.walletPath = prev.walletPath;
  if (prev.timeout == null) delete process.env.OPENZOO_UPSTREAM_TIMEOUT_MS;
  else process.env.OPENZOO_UPSTREAM_TIMEOUT_MS = prev.timeout;
  if (prev.probe == null) delete process.env.OPENZOO_UPSTREAM_PROBE_TIMEOUT_MS;
  else process.env.OPENZOO_UPSTREAM_PROBE_TIMEOUT_MS = prev.probe;
  if (prev.noTopup == null) delete process.env.OPENZOO_NO_AUTOTOPUP;
  else process.env.OPENZOO_NO_AUTOTOPUP = prev.noTopup;
  if (prev.sessionPath == null) delete process.env.OPENZOO_SESSION_PATH;
  else process.env.OPENZOO_SESSION_PATH = prev.sessionPath;
});
