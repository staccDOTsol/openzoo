import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CLINE_EXT_ID,
  clineBaseUrl,
  codeServerPassword,
  subscriptionToken,
  writeClineOpenZooSettings,
  writeCodeServerAuth,
} from '../scripts/box-cline-settings.mjs';
import { createBoxDoor, isHealthPath, parseUpstream, probeUpstream } from '../scripts/box-8080-door.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function tmpHome() {
  return mkdtempSync(join(tmpdir(), 'oz-box-agent-'));
}

test('Cline extension id is saoudrizwan.claude-dev', () => {
  assert.equal(CLINE_EXT_ID, 'saoudrizwan.claude-dev');
});

test('subscription token prefers ANTHROPIC_AUTH_TOKEN then OPENZOO_SUB_KEY', () => {
  assert.equal(subscriptionToken({ ANTHROPIC_AUTH_TOKEN: ' tok-a ', OPENZOO_SUB_KEY: 'tok-b' }), 'tok-a');
  assert.equal(subscriptionToken({ OPENZOO_SUB_KEY: 'tok-b' }), 'tok-b');
  assert.equal(subscriptionToken({ OPENZOO_SUBSCRIPTION_KEY: 'tok-c' }), 'tok-c');
  assert.equal(subscriptionToken({}), '');
});

test('Cline base URL is OPENZOO_API_BASE/v1 without doubling', () => {
  assert.equal(clineBaseUrl({}), 'https://x402-tokens.fly.dev/v1');
  assert.equal(clineBaseUrl({ OPENZOO_API_BASE: 'https://x402-tokens.fly.dev' }), 'https://x402-tokens.fly.dev/v1');
  assert.equal(clineBaseUrl({ OPENZOO_API_BASE: 'https://example.test/v1/' }), 'https://example.test/v1');
});

test('code-server password is CODE_SERVER_PASSWORD or sha256 of the sub key', () => {
  assert.equal(codeServerPassword({ CODE_SERVER_PASSWORD: 'pw' }), 'pw');
  const hashed = codeServerPassword({ OPENZOO_SUB_KEY: 'oz_sub' });
  assert.match(hashed, /^[0-9a-f]{64}$/);
  assert.equal(codeServerPassword({ ANTHROPIC_AUTH_TOKEN: 'oz_sub' }), hashed);
  assert.equal(codeServerPassword({}), '');
});

test('writeClineOpenZooSettings writes provider + token and never ANTHROPIC_API_KEY', () => {
  const home = tmpHome();
  try {
    const r = writeClineOpenZooSettings({
      home,
      env: {
        ANTHROPIC_AUTH_TOKEN: 'oz_live_sub',
        ANTHROPIC_API_KEY: 'sk-ant-must-not-land',
        OPENZOO_API_BASE: 'https://x402-tokens.fly.dev',
        OPENZOO_MODEL: 'anthropic/claude-sonnet-5',
      },
    });
    assert.equal(r.hasToken, true);
    assert.equal(r.baseUrl, 'https://x402-tokens.fly.dev/v1');
    const global = JSON.parse(readFileSync(r.globalPath, 'utf8'));
    const secrets = JSON.parse(readFileSync(r.secretsPath, 'utf8'));
    assert.equal(global.apiProvider, 'anthropic');
    assert.equal(global.planModeApiProvider, 'anthropic');
    assert.equal(global.actModeApiProvider, 'anthropic');
    assert.equal(global.anthropicBaseUrl, 'https://x402-tokens.fly.dev/v1');
    assert.equal(secrets.apiKey, 'oz_live_sub');
    assert.equal(secrets.ANTHROPIC_API_KEY, undefined);
    assert.equal(global.ANTHROPIC_API_KEY, undefined);
    const dumped = `${JSON.stringify(global)}${JSON.stringify(secrets)}`;
    assert.doesNotMatch(dumped, /sk-ant-must-not-land/);
    assert.doesNotMatch(dumped, /ANTHROPIC_API_KEY/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeClineOpenZooSettings does not invent a token when env has none', () => {
  const home = tmpHome();
  try {
    const r = writeClineOpenZooSettings({ home, env: { OPENZOO_API_BASE: 'https://x402-tokens.fly.dev' } });
    assert.equal(r.hasToken, false);
    const secrets = JSON.parse(readFileSync(r.secretsPath, 'utf8'));
    assert.equal(secrets.apiKey, undefined);
    const global = JSON.parse(readFileSync(r.globalPath, 'utf8'));
    assert.equal(global.anthropicBaseUrl, 'https://x402-tokens.fly.dev/v1');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeCodeServerAuth never writes auth none and hashes the sub key', () => {
  const home = tmpHome();
  try {
    const auth = writeCodeServerAuth({ home, env: { OPENZOO_SUB_KEY: 'oz_sub' } });
    assert.equal(auth.source, 'sub-key-hash');
    const yaml = readFileSync(auth.file, 'utf8');
    assert.match(yaml, /^auth: password$/m);
    assert.doesNotMatch(yaml, /auth:\s*none/);
    assert.match(yaml, /bind-addr: 127\.0\.0\.1:8081/);
    assert.equal(readFileSync(auth.passFile, 'utf8'), codeServerPassword({ OPENZOO_SUB_KEY: 'oz_sub' }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('box-cline-settings CLI writes settings without printing the token', async () => {
  const home = tmpHome();
  try {
    const child = spawn(process.execPath, [join(root, 'scripts', 'box-cline-settings.mjs')], {
      env: {
        ...process.env,
        HOME: home,
        ANTHROPIC_AUTH_TOKEN: 'oz_cli_secret',
        ANTHROPIC_API_KEY: 'sk-ant-nope',
      },
      encoding: 'utf8',
    });
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      child.stdout.on('data', (c) => { buf += c; });
      child.stderr.on('data', (c) => { buf += c; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(buf) : reject(new Error(buf || `exit ${code}`))));
    });
    assert.match(out, /"hasToken":true/);
    assert.doesNotMatch(out, /oz_cli_secret/);
    assert.doesNotMatch(out, /sk-ant-nope/);
    const secrets = JSON.parse(readFileSync(join(home, '.cline', 'data', 'secrets.json'), 'utf8'));
    assert.equal(secrets.apiKey, 'oz_cli_secret');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('door /health is 200 only when code-server is up; other paths proxy', async () => {
  assert.equal(isHealthPath('/health'), true);
  assert.equal(isHealthPath('/healthz'), true);
  assert.equal(isHealthPath('/login'), false);
  assert.deepEqual(parseUpstream('127.0.0.1:8081'), { host: '127.0.0.1', port: 8081 });

  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`up:${req.url}`);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const door = createBoxDoor({ upstream: { host: '127.0.0.1', port: upPort } });
  await new Promise((r) => door.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${door.address().port}`;
  try {
    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok\n');
    const proxied = await fetch(`${url}/login`);
    assert.equal(proxied.status, 200);
    assert.equal(await proxied.text(), 'up:/login');
  } finally {
    await new Promise((r) => door.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

test('door /health is 503 when code-server is down', async () => {
  assert.equal(await probeUpstream({ host: '127.0.0.1', port: 1 }), false);
  const door = createBoxDoor({ upstream: { host: '127.0.0.1', port: 1 } });
  await new Promise((r) => door.listen(0, '127.0.0.1', r));
  try {
    const health = await fetch(`http://127.0.0.1:${door.address().port}/health`);
    assert.equal(health.status, 503);
  } finally {
    await new Promise((r) => door.close(r));
  }
});
