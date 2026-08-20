import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-actual-billed-'));
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

// MEASURED 2026-08-19: 32,000 reserved output tokens quoted at $0.9858;
// OpenRouter usage.cost was $0.007962 — 124× smaller. A ~1× call.
const RESERVE_QUOTE = 0.9858;
const USAGE_COST = 0.007962;

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

function completionJson({ billedUsd = RESERVE_QUOTE, cost = USAGE_COST, extra = {} } = {}) {
  return {
    id: 'chatcmpl-actual',
    object: 'chat.completion',
    model: 'openzoo/test',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48, cost },
    x402: { billedUsd, directUsd: billedUsd, savedUsd: 0, pricing: 'markup', ...extra },
  };
}

async function startAgainst(upstream, t) {
  const prevPort = config.port;
  const prevBase = config.apiBase;
  config.apiBase = `http://127.0.0.1:${upstream.address().port}`;
  config.port = 0;
  const { startProxy } = await import('../lib/proxy.js');
  const proxy = await startProxy({ silent: true, autoTunnel: false });
  t.after(async () => {
    await closeServer(proxy.server);
    await closeServer(upstream);
    config.port = prevPort;
    config.apiBase = prevBase;
  });
  assert.ok(proxy.server);
  return proxy.server.address().port;
}

async function chat(port, { stream = false, prompt = 'hi' } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'openzoo/test',
      stream,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 32000,
    }),
  });
  assert.equal(res.status, 200);
  if (stream) await res.text();
  else await res.json();
}

async function infoActual(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/info`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.actual;
}

describe('billedWithActual is post-completion billed, not the quote reserve', { concurrency: 1 }, () => {
  test('proxy pairs usage.cost with settled billed, not x402.billedUsd reserve', () => {
    const proxy = readFileSync(path.join(root, 'lib/proxy.js'), 'utf8');
    assert.match(proxy, /pairActualBilled/);
    assert.doesNotMatch(proxy, /billedWithActual \+= Number\(data\?\.x402\?\.billedUsd\)/);
    assert.doesNotMatch(proxy, /billedWithActual \+= x\.billedUsd/);
  });

  test('JSON prepaid: reserved quote ≠ settled → HUD markupX is ~1× not 124×', async (t) => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completionJson()));
    });
    const port = await startAgainst(upstream, t);
    await chat(port, { prompt: 'reserve-vs-settled' });
    const actual = await infoActual(port);
    assert.equal(actual.calls, 1);
    assert.equal(actual.upstreamUsd, USAGE_COST);
    assert.equal(actual.billedUsd, USAGE_COST);
    assert.equal(actual.markupX, 1);
    assert.ok(actual.markupX < 2, `markupX ${actual.markupX} must not be the 124× reserve lie`);
    assert.ok(Math.abs(actual.marginUsd) < 1e-9);
  });

  test('JSON prepaid: explicit billedActual is the HUD billed twin', async (t) => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completionJson({ extra: { billedActual: 0.0106 } })));
    });
    const port = await startAgainst(upstream, t);
    await chat(port, { prompt: 'explicit-billed-actual' });
    const actual = await infoActual(port);
    assert.equal(actual.upstreamUsd, USAGE_COST);
    assert.equal(actual.billedUsd, 0.0106);
    assert.ok(actual.markupX > 1 && actual.markupX < 2);
  });

  test('SSE prepaid: actualUsd pairs with settled billed, not the reserve', async (t) => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"s","choices":[{"delta":{"content":"ok"}}]}\n\n');
      res.write(`: x402 ${JSON.stringify({
        billedUsd: RESERVE_QUOTE,
        actualUsd: USAGE_COST,
        savedUsd: 0,
        directUsd: RESERVE_QUOTE,
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const port = await startAgainst(upstream, t);
    await chat(port, { stream: true, prompt: 'sse-reserve-vs-settled' });
    const actual = await infoActual(port);
    assert.equal(actual.calls, 1);
    assert.equal(actual.upstreamUsd, USAGE_COST);
    assert.equal(actual.billedUsd, USAGE_COST);
    assert.equal(actual.markupX, 1);
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
