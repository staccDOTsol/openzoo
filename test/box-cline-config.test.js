import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLINE_KEYS,
  clineGlobalState,
  clineSecrets,
  clineProviders,
  subscriptionToken,
  writeClineConfig,
  zooCompletionsUrl,
  zooOrigin,
} from '../scripts/box-cline-config.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = readFileSync(path.join(root, 'box.Dockerfile'), 'utf8');
const boot = readFileSync(path.join(root, 'box-boot.sh'), 'utf8');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'docker-box.yml'), 'utf8');

test('Cline marketplace id is saoudrizwan.claude-dev (verified Open VSX)', () => {
  assert.match(dockerfile, /saoudrizwan\.claude-dev/);
  assert.match(dockerfile, /open-vsx\.org\/api\/saoudrizwan\/claude-dev/);
  assert.match(dockerfile, /CODE_SERVER_VERSION=4\.133\.0/);
  assert.match(dockerfile, /CLINE_VERSION=4\.1\.11/);
  assert.doesNotMatch(dockerfile, /FROM alpine/i);
  assert.doesNotMatch(dockerfile, /ANTHROPIC_API_KEY=/);
});

test('box-boot starts code-server on 8080 with password auth, never --auth none', () => {
  assert.match(boot, /--auth password/);
  assert.doesNotMatch(boot, /^\s*[^#\n]*--auth none/m);
  assert.match(boot, /unset ANTHROPIC_API_KEY/);
  assert.match(boot, /OPENZOO_IDE_PASSWORD/);
  assert.match(boot, /box-front/);
  assert.match(boot, /OPENZOO_NO_TUNNEL/);
  assert.match(boot, /code-server/);
  assert.match(boot, /OZ_UI_B64 present — ignored/);
  assert.match(boot, /openzoo proxy/);
});

test('docker-box smoke checks /health, Cline, and no ANTHROPIC_API_KEY', () => {
  assert.match(workflow, /8080\/health/);
  assert.match(workflow, /saoudrizwan\.claude-dev/);
  assert.match(workflow, /ANTHROPIC_API_KEY/);
  assert.match(workflow, /code-server/);
});

test('zooOrigin strips trailing /v1 because Cline Anthropic SDK appends /v1/messages', () => {
  assert.equal(zooOrigin({}), 'https://x402-tokens.fly.dev');
  assert.equal(zooOrigin({ OPENZOO_API_BASE: 'https://x402-tokens.fly.dev/v1' }), 'https://x402-tokens.fly.dev');
  assert.equal(zooCompletionsUrl({}), 'https://x402-tokens.fly.dev/v1');
});

test('subscription token prefers ANTHROPIC_AUTH_TOKEN then OPENZOO_SUB_KEY, never ANTHROPIC_API_KEY', () => {
  assert.equal(subscriptionToken({ ANTHROPIC_API_KEY: 'sk-ant-house' }), '');
  assert.equal(subscriptionToken({
    ANTHROPIC_API_KEY: 'sk-ant-house',
    OPENZOO_SUB_KEY: 'oz_sub',
  }), 'oz_sub');
  assert.equal(subscriptionToken({
    ANTHROPIC_AUTH_TOKEN: 'oz_auth',
    OPENZOO_SUB_KEY: 'oz_sub',
  }), 'oz_auth');
});

test('cline globalState uses documented Cline keys, Anthropic provider, OpenZoo origin', () => {
  const g = clineGlobalState({ OPENZOO_MODEL: 'anthropic/claude-sonnet-5' });
  assert.equal(g[CLINE_KEYS.planModeApiProvider], 'anthropic');
  assert.equal(g[CLINE_KEYS.actModeApiProvider], 'anthropic');
  assert.equal(g[CLINE_KEYS.anthropicBaseUrl], 'https://x402-tokens.fly.dev');
  assert.equal(g[CLINE_KEYS.openAiBaseUrl], 'https://x402-tokens.fly.dev/v1');
  assert.equal(g[CLINE_KEYS.planModeApiModelId], 'claude-sonnet-5');
  assert.equal(g[CLINE_KEYS.actModeApiModelId], 'claude-sonnet-5');
  assert.equal(g[CLINE_KEYS.welcomeViewCompleted], true);
  assert.equal(g[CLINE_KEYS.isNewUser], false);
});

test('cline secrets write apiKey from the sub Bearer and drop ANTHROPIC_API_KEY', () => {
  const s = clineSecrets(
    { ANTHROPIC_AUTH_TOKEN: 'oz_tok', ANTHROPIC_API_KEY: 'sk-ant' },
    { ANTHROPIC_API_KEY: 'leftover', apiKey: 'old' },
  );
  assert.equal(s.apiKey, 'oz_tok');
  assert.equal(s.openAiApiKey, 'oz_tok');
  assert.equal(s.ANTHROPIC_API_KEY, undefined);
});

test('writeClineConfig writes ~/.cline/data files without requiring a token', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'oz-cline-'));
  try {
    const { hasToken } = writeClineConfig({
      home,
      env: { OPENZOO_API_BASE: 'https://x402-tokens.fly.dev' },
    });
    assert.equal(hasToken, false);
    const g = JSON.parse(readFileSync(path.join(home, '.cline', 'data', 'globalState.json'), 'utf8'));
    assert.equal(g.anthropicBaseUrl, 'https://x402-tokens.fly.dev');
    const s = JSON.parse(readFileSync(path.join(home, '.cline', 'data', 'secrets.json'), 'utf8'));
    assert.equal(s.apiKey, undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('writeClineConfig persists the sub token in secrets.json (mode-safe JSON)', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'oz-cline-'));
  try {
    mkdirSync(path.join(home, '.cline', 'data'), { recursive: true });
    writeFileSync(path.join(home, '.cline', 'data', 'globalState.json'), '{"keep":true}\n');
    writeClineConfig({
      home,
      env: { ANTHROPIC_AUTH_TOKEN: 'oz_secret', OPENZOO_MODEL: 'claude-sonnet-5' },
    });
    const g = JSON.parse(readFileSync(path.join(home, '.cline', 'data', 'globalState.json'), 'utf8'));
    assert.equal(g.keep, true);
    assert.equal(g.planModeApiProvider, 'anthropic');
    const s = JSON.parse(readFileSync(path.join(home, '.cline', 'data', 'secrets.json'), 'utf8'));
    assert.equal(s.apiKey, 'oz_secret');
    const p = clineProviders({ ANTHROPIC_AUTH_TOKEN: 'oz_secret' });
    assert.equal(p.lastUsedProvider, 'anthropic');
    assert.equal(p.providers.anthropic.settings.baseUrl, 'https://x402-tokens.fly.dev');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
