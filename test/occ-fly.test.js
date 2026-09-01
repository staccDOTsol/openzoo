import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHostedOcc } from '../lib/hosted-occ.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fly = readFileSync(path.join(root, 'fly.toml'), 'utf8');
const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');

test('fly.toml is openzoo-occ on :8080 with zoo completions door', () => {
  assert.match(fly, /^app\s*=\s*"openzoo-occ"/m);
  assert.match(fly, /OPENZOO_OCC_BIND\s*=\s*"0\.0\.0\.0"/);
  assert.match(fly, /OPENZOO_OCC_PORT\s*=\s*"8080"/);
  assert.match(fly, /OPENZOO_OCC_BASE_URL\s*=\s*"https:\/\/x402-tokens\.fly\.dev\/v1"/);
  assert.match(fly, /internal_port\s*=\s*8080/);
  assert.match(fly, /path\s*=\s*"\/healthz"/);
  const envBlock = fly.split('[env]')[1]?.split('[')[0] || '';
  assert.doesNotMatch(envBlock, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(fly, /grokui-v1\.6\.1[23]/);
  assert.match(fly, /dockerfile\s*=\s*"Dockerfile"/);
  assert.doesNotMatch(fly, /box\.Dockerfile/);
});

test('OCC Dockerfile starts node bin/openzoo.js occ and ships openzoo-claude', () => {
  assert.match(dockerfile, /CMD\s*\[\s*"node"\s*,\s*"bin\/openzoo\.js"\s*,\s*"occ"\s*\]/);
  assert.match(dockerfile, /OPENZOO_OCC_BIND=0\.0\.0\.0/);
  assert.match(dockerfile, /OPENZOO_OCC_PORT=8080/);
  assert.match(dockerfile, /OPENZOO_OCC_BASE_URL=https:\/\/x402-tokens\.fly\.dev\/v1/);
  assert.match(dockerfile, /openzoo-claude@2\.0\.2/);
  assert.match(dockerfile, /node-pty@1\.1\.0/);
  assert.match(dockerfile, /vendor\/openzoo-claude/);
  assert.match(dockerfile, /Do not ENV ANTHROPIC_API_KEY/);
  assert.doesNotMatch(dockerfile, /ENV\s+ANTHROPIC_API_KEY=/);
  assert.doesNotMatch(dockerfile, /box-boot\.sh/);
});

test('fly env: GET /healthz is 200; missing Bearer is 401 without spawn', async () => {
  let spawned = 0;
  const started = await startHostedOcc({
    env: {
      ...process.env,
      OPENZOO_OCC_BIND: '127.0.0.1',
      OPENZOO_OCC_PORT: '0',
      OPENZOO_OCC_BASE_URL: 'https://x402-tokens.fly.dev/v1',
    },
    bind: '127.0.0.1',
    port: 0,
    verify: async () => ({ ok: false, status: 401, error: 'unauthorized' }),
    spawn: () => {
      spawned += 1;
      throw new Error('must not spawn without Bearer');
    },
    log: () => {},
  });
  try {
    const hz = await fetch(`${started.url}/healthz`);
    assert.equal(hz.status, 200);
    assert.deepEqual(await hz.json(), { ok: true, service: 'hosted-occ' });
    const miss = await fetch(`${started.url}/occ/sessions`, { method: 'POST', body: '{}' });
    assert.equal(miss.status, 401);
    assert.equal((await miss.json()).error, 'unauthorized');
    assert.equal(spawned, 0);
    assert.equal(started.sessions.size, 0);
    assert.equal(started.completionsUrl, 'https://x402-tokens.fly.dev/v1');
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    started.close();
  }
});
