import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeCodexConfig, providerBlock, chatGptCandidates, resolveChatGptApp, findDownloadedDeb,
  codexConfigPath, PROVIDER_ID, API_KEY_ENV,
} from '../lib/chatgpt.js';

const opts = { model: 'claude-opus-5', port: 8402, wireApi: 'responses' };

test('an empty config.toml gets our two top-level keys and the provider table', () => {
  const out = mergeCodexConfig('', opts);
  assert.match(out, /^# written by `npx openzoo chatgpt`/);
  assert.match(out, /\nmodel = "claude-opus-5"\nmodel_provider = "openzoo"\n/);
  assert.match(out, /\[model_providers\.openzoo\]\nname = "openzoo"\nbase_url = "http:\/\/localhost:8402\/v1"\nwire_api = "responses"\nenv_key = "OPENZOO_API_KEY"\nrequires_openai_auth = false\n$/);
});

test('every other table survives; our stale table and old top-level keys are replaced', () => {
  const existing = [
    'model = "gpt-5.2"',
    'model_provider = "openai"',
    'approval_policy = "never"',
    '',
    '[model_providers.openzoo]',
    'name = "openzoo"',
    'base_url = "http://localhost:9999/v1"   # stale',
    '',
    '[model_providers.ollama]',
    'name = "Ollama"',
    'base_url = "http://localhost:11434/v1"',
    '',
    '[mcp_servers.foo]',
    'command = "foo"',
    '',
  ].join('\n');
  const out = mergeCodexConfig(existing, opts);
  assert.ok(!out.includes('9999'), 'stale openzoo table must be gone');
  assert.ok(!out.includes('"gpt-5.2"'), 'old top-level model must be gone');
  assert.ok(!out.includes('model_provider = "openai"'));
  assert.ok(out.includes('approval_policy = "never"'), 'unrelated top-level key kept');
  assert.ok(out.includes('[model_providers.ollama]\nname = "Ollama"\nbase_url = "http://localhost:11434/v1"'), 'other provider kept verbatim');
  assert.ok(out.includes('[mcp_servers.foo]\ncommand = "foo"'), 'unrelated table kept');
  // top-level keys precede the first table — TOML requires it
  assert.ok(out.indexOf('model_provider = "openzoo"') < out.indexOf('['));
  assert.equal((out.match(/\[model_providers\.openzoo\]/g) || []).length, 1);
});

test('running the merge twice is a no-op', () => {
  const once = mergeCodexConfig('[foo]\nbar = 1\n', opts);
  assert.equal(mergeCodexConfig(once, opts), once);
});

test('--bearer writes a static token instead of an env key; --wire chat is honoured', () => {
  const b = providerBlock({ port: 8402, wireApi: 'chat', bearer: true });
  assert.match(b, /wire_api = "chat"/);
  assert.match(b, /experimental_bearer_token = "sk-openzoo"/);
  assert.ok(!b.includes('env_key'));
});

test('app resolution: explicit env wins, then the .deb layout, then the unpack dir, then PATH', () => {
  const home = '/home/u';
  const env = { OPENZOO_CHATGPT_BIN: '/x/ChatGPT', PATH: '/usr/local/bin:/usr/bin' };
  const c = chatGptCandidates({ env, home, platform: 'linux' });
  assert.equal(c[0], '/x/ChatGPT');
  assert.equal(c[1], '/usr/lib/chatgpt/ChatGPT');
  assert.ok(c.includes(path.join(home, '.openzoo', 'apps', 'chatgpt', 'usr', 'lib', 'chatgpt', 'ChatGPT')));
  assert.ok(c.includes(path.join(home, 'apps', 'chatgpt', 'usr', 'lib', 'chatgpt', 'ChatGPT')));
  assert.equal(c[c.length - 1], '/usr/bin/chatgpt');
  const found = resolveChatGptApp({ env: { PATH: '/usr/bin' }, home, platform: 'linux', exists: (p) => p === '/usr/bin/chatgpt' });
  assert.equal(found, '/usr/bin/chatgpt');
  assert.equal(resolveChatGptApp({ env: {}, home, platform: 'linux', exists: () => false }), null);
  const mac = chatGptCandidates({ env: {}, home, platform: 'darwin' });
  assert.equal(mac[0], '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT');
});

test('the newest chatgpt*.deb in ~/Downloads is picked', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-home-'));
  const dl = path.join(home, 'Downloads');
  fs.mkdirSync(dl);
  fs.writeFileSync(path.join(dl, 'chatgpt_amd64.deb'), 'old');
  fs.writeFileSync(path.join(dl, 'other.deb'), 'x');
  const newer = path.join(dl, 'chatgpt_amd64 (1).deb');
  fs.writeFileSync(newer, 'new');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(newer, t, t);
  assert.equal(findDownloadedDeb(home), newer);
  assert.equal(findDownloadedDeb(path.join(home, 'nope')), null);
});

test('config path honours CODEX_HOME', () => {
  assert.equal(codexConfigPath({ CODEX_HOME: '/c' }, '/h'), path.join('/c', 'config.toml'));
  assert.equal(codexConfigPath({}, '/h'), path.join('/h', '.codex', 'config.toml'));
  assert.equal(PROVIDER_ID, 'openzoo');
  assert.equal(API_KEY_ENV, 'OPENZOO_API_KEY');
});
