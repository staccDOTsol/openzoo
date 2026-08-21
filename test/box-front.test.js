import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const front = path.join(root, 'scripts', 'box-front.mjs');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close((err) => (err ? reject(err) : resolve(p)));
    });
    s.on('error', reject);
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function waitUp(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      await get(port, '/health');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('front never listened');
}

test('GET /health is 200 only when upstream /healthz is 200', async () => {
  let healthy = false;
  const up = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(healthy ? 200 : 503).end(healthy ? 'alive' : 'down');
      return;
    }
    res.writeHead(200).end(`up:${req.url}`);
  });
  const upPort = await listen(up);
  const frontPort = await freePort();
  const child = spawn(process.execPath, [front], {
    env: {
      ...process.env,
      BOX_FRONT_BIND: '127.0.0.1',
      BOX_FRONT_PORT: String(frontPort),
      BOX_UPSTREAM: `127.0.0.1:${upPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitUp(frontPort);
    const down = await get(frontPort, '/health');
    assert.equal(down.status, 503);
    healthy = true;
    const upHealth = await get(frontPort, '/health');
    assert.equal(upHealth.status, 200);
    assert.match(upHealth.body, /^ok/);
    const proxied = await get(frontPort, '/ide');
    assert.equal(proxied.status, 200);
    assert.equal(proxied.body, 'up:/ide');
  } finally {
    child.kill('SIGTERM');
    up.close();
  }
});
