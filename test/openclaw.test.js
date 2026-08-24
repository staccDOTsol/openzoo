import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openclawModelEntry, mergeOpenClawConfig, isReasoningId, PROVIDER_KEY,
} from '../lib/openclaw.js';

// The one conversion that matters: gateway pricing is USD PER TOKEN
// (OpenRouter units), OpenClaw's cost block is USD PER MILLION tokens.
// $3/Mtok in, $15/Mtok out — the classic Sonnet shape.
test('openclawModelEntry converts USD/token to USD/Mtok', () => {
  const e = openclawModelEntry({
    id: 'anthropic/claude-sonnet-5',
    pricing: { prompt: '0.000003', completion: '0.000015' },
    context_length: 2000000,
  });
  assert.equal(e.cost.input, 3);
  assert.equal(e.cost.output, 15);
  assert.equal(e.cost.cacheRead, 0);
  assert.equal(e.contextWindow, 2000000);
  assert.equal(e.maxTokens, 8192);
  assert.equal(e.reasoning, false);
});

test('openclawModelEntry survives missing pricing and context', () => {
  const e = openclawModelEntry({ id: 'x/y' });
  assert.equal(e.cost.input, 0);
  assert.equal(e.cost.output, 0);
  assert.equal(e.contextWindow, 128000); // self-hosted default, never NaN
});

// Asymmetric costs: a wrong `true` breaks requests, a wrong `false` only
// hides a toggle — so only unambiguous ids may flip it.
test('isReasoningId is conservative', () => {
  assert.equal(isReasoningId('openai/o3-pro'), true);
  assert.equal(isReasoningId('deepseek/deepseek-reasoner'), true);
  assert.equal(isReasoningId('qwen/qwq-32b'), true);
  assert.equal(isReasoningId('anthropic/claude-opus-5'), false);
  assert.equal(isReasoningId('x-ai/grok-4.6'), false); // "grok" must not match r1/o1 shapes
  assert.equal(isReasoningId('meta-llama/llama-3.1-405b'), false); // "o1" inside a word/version
});

test('merge preserves foreign providers and unrelated keys', () => {
  const existing = {
    channels: { telegram: { token: 'keepme' } },
    models: { providers: { xai: { baseUrl: 'https://api.x.ai' } } },
    agents: { defaults: { model: { primary: 'xai/grok-4.3' } } },
  };
  const { cfg, changedDefault } = mergeOpenClawConfig(existing, {
    port: 8402,
    entries: [{ id: 'a/b', cost: { input: 1, output: 2 } }],
    defaultId: 'a/b',
    forceDefault: false,
  });
  assert.equal(cfg.channels.telegram.token, 'keepme');
  assert.equal(cfg.models.providers.xai.baseUrl, 'https://api.x.ai');
  assert.equal(cfg.models.providers[PROVIDER_KEY].baseUrl, 'http://localhost:8402/v1');
  // an existing primary is never silently re-pointed
  assert.equal(changedDefault, false);
  assert.equal(cfg.agents.defaults.model.primary, 'xai/grok-4.3');
});

test('merge claims the default when none exists, or when forced', () => {
  const blank = mergeOpenClawConfig({}, {
    port: 8402, entries: [{ id: 'a/b' }], defaultId: 'a/b', forceDefault: false,
  });
  assert.equal(blank.changedDefault, true);
  assert.equal(blank.cfg.agents.defaults.model.primary, `${PROVIDER_KEY}/a/b`);

  const forced = mergeOpenClawConfig(
    { agents: { defaults: { model: { primary: 'xai/grok-4.3' } } } },
    { port: 8402, entries: [{ id: 'a/b' }], defaultId: 'a/b', forceDefault: true },
  );
  assert.equal(forced.changedDefault, true);
  assert.equal(forced.cfg.agents.defaults.model.primary, `${PROVIDER_KEY}/a/b`);
});

// Replaced wholesale: a half-merged provider block would resurrect dead
// models or stale prices on every re-run.
test('re-merge replaces our provider block, not appends', () => {
  const first = mergeOpenClawConfig({}, {
    port: 8402, entries: [{ id: 'old/model' }], defaultId: 'old/model',
  }).cfg;
  const second = mergeOpenClawConfig(first, {
    port: 8402, entries: [{ id: 'new/model' }], defaultId: 'new/model',
  }).cfg;
  const models = second.models.providers[PROVIDER_KEY].models;
  assert.deepEqual(models.map((m) => m.id), ['new/model']);
});
