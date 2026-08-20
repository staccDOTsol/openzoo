import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchHeaders, HEADERS_MS } from '../lib/fetch.js';
import { CREDIT_TIMEOUT_MS } from '../lib/info.js';
import { config } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-fetch-'));
const prev = {
  apiBase: config.apiBase,
  port: config.port,
  walletPath: config.walletPath,
  noTopup: process.env.OPENZOO_NO_AUTOTOPUP,
  sessionPath: process.env.OPENZOO_SESSION_PATH,
};

process.env.OPENZOO_NO_AUTOTOPUP = '1';
process.env.OPENZOO_NO_OPEN = '1';
process.env.OPENZOO_SESSION_PATH = path.join(tmp, 'session.json');
config.walletPath = path.join(tmp, 'wallet.json');

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
    setTimeout(resolve, 400).unref?.();
  });
}

describe('fetchHeaders + session unwedge', { concurrency: 1 }, () => {
  test('HEADERS_MS defaults to 30s; credit probe is 2.5s', () => {
    assert.equal(HEADERS_MS, 30_000);
    assert.equal(CREDIT_TIMEOUT_MS, 2500);
  });

  test('fetchHeaders aborts when the upstream never sends headers', async () => {
    const hung = await listen(() => { /* accept, never write */ });
    try {
      const t0 = Date.now();
      await assert.rejects(
        () => fetchHeaders(`http://127.0.0.1:${hung.address().port}/v1/credits`, {}, 150),
        (err) => err.name === 'AbortError' || err.name === 'TimeoutError' || /aborted|timeout/i.test(String(err.message)),
      );
      assert.ok(Date.now() - t0 < 800, `fetchHeaders took ${Date.now() - t0}ms`);
    } finally {
      await closeServer(hung);
    }
  });

  test('fetchHeaders lets the body stream after headers arrive', async () => {
    const slow = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      setTimeout(() => { res.end('streamed'); }, 350);
    });
    try {
      const res = await fetchHeaders(`http://127.0.0.1:${slow.address().port}/v1/chat`, {}, 150);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'streamed');
    } finally {
      await closeServer(slow);
    }
  });

  test('GET /v1/session still 200 while a fake upstream hangs', async (t) => {
    const hung = await listen(() => { /* never write */ });
    const prevPort = config.port;
    const prevBase = config.apiBase;
    config.apiBase = `http://127.0.0.1:${hung.address().port}`;
    config.port = 0;
    process.env.OPENZOO_UPSTREAM_HEADERS_MS = '400';
    const { startProxy } = await import('../lib/proxy.js');
    const proxy = await startProxy({ silent: true, autoTunnel: false });
    t.after(async () => {
      await closeServer(proxy.server);
      await closeServer(hung);
      config.port = prevPort;
      config.apiBase = prevBase;
    });
    assert.ok(proxy.server);
    const port = proxy.server.address().port;

    const inflight = [];
    for (let i = 0; i < 4; i++) {
      inflight.push(fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'openzoo/test',
          messages: [{ role: 'user', content: `hang-${i}` }],
        }),
      }).then(async (res) => ({ status: res.status, text: await res.text() }))
        .catch((err) => ({ error: err })));
    }

    const t0 = Date.now();
    const session = await fetch(`http://127.0.0.1:${port}/v1/session`, {
      signal: AbortSignal.timeout(200),
    });
    assert.equal(session.status, 200);
    assert.ok(Date.now() - t0 < 200, `GET /v1/session took ${Date.now() - t0}ms`);
    const body = await session.json();
    assert.equal(typeof body.spentUsd, 'number');

    const results = await Promise.all(inflight);
    for (const r of results) {
      if (r.error) {
        assert.match(String(r.error.message || r.error), /aborted|timeout|fetch failed/i);
        continue;
      }
      assert.ok(r.status >= 500, `expected timeout 5xx, got ${r.status} ${r.text}`);
      assert.match(r.text, /aborted|timeout|Timeout/i);
    }
  });

  test('session and wallet never await fly.dev; HUD poll is 2s', () => {
    const proxy = readFileSync(path.join(root, 'lib', 'proxy.js'), 'utf8');
    const session = proxy.slice(proxy.indexOf("=== '/v1/session'"), proxy.indexOf("=== '/v1/wallet'"));
    const wallet = proxy.slice(proxy.indexOf("=== '/v1/wallet'"), proxy.indexOf("=== '/mcp'"));
    assert.match(session, /refreshCredit\(\)\.catch\(\(\) => \{\}\)/);
    assert.doesNotMatch(session, /await refreshCredit/);
    assert.doesNotMatch(session, /await refreshPrices/);
    assert.match(wallet, /refreshCredit\(\)\.catch\(\(\) => \{\}\)/);
    assert.doesNotMatch(wallet, /await refreshCredit/);

    const grokui = readFileSync(path.join(root, 'lib', 'grokui.mjs'), 'utf8');
    assert.match(grokui, /fetch\(`\$\{PROXY\}\/session`, \{ signal: AbortSignal\.timeout\(2000\) \}\)/);
    assert.match(grokui, /8402\/v1\/session', \{ signal: AbortSignal\.timeout\(2000\) \}\)/);

    const pay = readFileSync(path.join(root, 'lib', 'pay.js'), 'utf8');
    assert.match(pay, /fetchHeaders/);
    const info = readFileSync(path.join(root, 'lib', 'info.js'), 'utf8');
    assert.match(info, /AbortSignal\.timeout\(CREDIT_TIMEOUT_MS\)/);
    const models = readFileSync(path.join(root, 'lib', 'models.js'), 'utf8');
    assert.match(models, /fetchHeaders/);
    const cfg = readFileSync(path.join(root, 'lib', 'config.js'), 'utf8');
    assert.match(cfg, /fetchHeaders/);
  });
});

test.after(() => {
  config.apiBase = prev.apiBase;
  config.port = prev.port;
  config.walletPath = prev.walletPath;
  if (prev.noTopup == null) delete process.env.OPENZOO_NO_AUTOTOPUP;
  else process.env.OPENZOO_NO_AUTOTOPUP = prev.noTopup;
  if (prev.sessionPath == null) delete process.env.OPENZOO_SESSION_PATH;
  else process.env.OPENZOO_SESSION_PATH = prev.sessionPath;
});
