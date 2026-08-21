import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../lib/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-failed-x402-'));
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

async function startAgainst(upstream, t) {
  const prevPort = config.port;
  const prevBase = config.apiBase;
  const prevSession = process.env.OPENZOO_SESSION_PATH;
  process.env.OPENZOO_SESSION_PATH = path.join(tmp, `session-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  config.apiBase = `http://127.0.0.1:${upstream.address().port}`;
  config.port = 0;
  const { startProxy } = await import('../lib/proxy.js');
  const proxy = await startProxy({ silent: true, autoTunnel: false });
  t.after(async () => {
    await closeServer(proxy.server);
    await closeServer(upstream);
    config.port = prevPort;
    config.apiBase = prevBase;
    if (prevSession == null) delete process.env.OPENZOO_SESSION_PATH;
    else process.env.OPENZOO_SESSION_PATH = prevSession;
  });
  assert.ok(proxy.server);
  return { port: proxy.server.address().port, spent: proxy.spent };
}

async function chat(port, { prompt = 'hi' } = {}) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'openzoo/test',
      messages: [{ role: 'user', content: prompt }],
    }),
  });
}

async function sessionOf(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/session`);
  assert.equal(res.status, 200);
  return res.json();
}

describe('failed x402 still bills the user at house cost', { concurrency: 1 }, () => {
  test('400 JSON with x402.cogsUsd=0.01 and billedUsd=0.002 meters spent ≥ 0.01', async (t) => {
    const upstream = await listen((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: 'No user query', type: 'invalid_request_error' },
        x402: { billedUsd: 0.002, cogsUsd: 0.01, directUsd: 0.01, savedUsd: 0 },
      }));
    });
    const { port } = await startAgainst(upstream, t);
    const r = await chat(port, { prompt: 'failed-with-x402' });
    assert.equal(r.status, 400);
    const sess = await sessionOf(port);
    assert.ok(sess.spentUsd >= 0.01, `spent ${sess.spentUsd} must be ≥ cogs 0.01`);
    assert.equal(sess.cogsUsd, 0.01);
    assert.ok(sess.spentUsd >= sess.cogsUsd, 'never add cogs without spent');
    assert.equal(sess.paidCalls, 1);
  });

  test('400 with no x402 does not invent a charge', async (t) => {
    const upstream = await listen((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid_parameter' } }));
    });
    const { port } = await startAgainst(upstream, t);
    const r = await chat(port, { prompt: 'failed-no-x402' });
    assert.equal(r.status, 400);
    const sess = await sessionOf(port);
    assert.equal(sess.spentUsd, 0);
    assert.equal(sess.cogsUsd, 0);
    assert.equal(sess.paidCalls, 0);
  });

  test('successful spill keeps billed when cogs ≤ billed', async (t) => {
    const upstream = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-spill',
        object: 'chat.completion',
        model: 'openzoo/test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, cost: 0.007 },
        x402: { billedUsd: 0.01, cogsUsd: 0.007, directUsd: 0.04, savedUsd: 0.03, pricing: 'spill' },
      }));
    });
    const { port } = await startAgainst(upstream, t);
    const r = await chat(port, { prompt: 'ok-spill' });
    assert.equal(r.status, 200);
    const sess = await sessionOf(port);
    assert.equal(sess.spentUsd, 0.01);
    assert.equal(sess.cogsUsd, 0.007);
    assert.ok(sess.spentUsd >= sess.cogsUsd);
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
