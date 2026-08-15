import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../lib/models.js';

// Hermetic: resolveModel honours OPENZOO_DEFAULT_MODEL, so an ambient value
// (a dev shell, a project .env) would otherwise flip every family-hint case.
delete process.env.OPENZOO_DEFAULT_MODEL;

const CATALOG = [
  'google/gemini-3.7-flash',
  'google/gemini-3.7-flash:batch',
  'bytedance-seed/seed-2-1-turbo',
  'bytedance-seed/seed-2.0-code',
  'qwen/qwen3.8-2.4t-a95b',
  'deepseek/deepseek-v4-pro-0813',
  'x-ai/grok-4.6',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-lightning',
  'nvidia/nemotron-3.5-lightning:free',
];

test('an id the zoo serves is never rewritten', () => {
  assert.equal(resolveModel('x-ai/grok-4.6', CATALOG), null);
  assert.equal(resolveModel('deepseek/deepseek-v4-pro-0813', CATALOG), null);
  assert.equal(resolveModel('nvidia/nemotron-3.5-lightning:free', CATALOG), null);
});

test('family hints land in the right vendor, full-strength variant first', () => {
  assert.equal(resolveModel('gemini-2.5-pro', CATALOG), 'google/gemini-3.7-flash');
  assert.equal(resolveModel('grok-3-mini', CATALOG), 'x-ai/grok-4.6');
  assert.equal(resolveModel('deepseek-chat', CATALOG), 'deepseek/deepseek-v4-pro-0813');
  assert.equal(resolveModel('Qwen-Max', CATALOG), 'qwen/qwen3.8-2.4t-a95b');
  assert.equal(resolveModel('nemotron-nano', CATALOG), 'nvidia/nemotron-3.5-lightning');
});

test('foreign ids land on a LIKE model, tier for tier — never one default', () => {
  // flagship ask → the zoo's flagship (2.4T qwen), not whatever is first
  assert.equal(resolveModel('gpt-5.6-sol', CATALOG), 'qwen/qwen3.8-2.4t-a95b');
  assert.equal(resolveModel('claude-opus-4-1', CATALOG), 'qwen/qwen3.8-2.4t-a95b');
  // light ask → a light model, and the full-strength variant of it
  assert.equal(resolveModel('gpt-4o-mini', CATALOG), 'google/gemini-3.7-flash');
  // reasoning ask → the heaviest thing available, never a mini
  assert.equal(tierMatchesHeavyOrReason(resolveModel('o3', CATALOG)), true);
  // code ask → a code model
  assert.equal(resolveModel('composer-2.5', CATALOG), 'bytedance-seed/seed-2.0-code');
  // generic mid ask → a general mid model, NOT the code specialist
  assert.equal(resolveModel('claude-sonnet-4', CATALOG), 'x-ai/grok-4.6');
  assert.equal(resolveModel('gpt-4o', CATALOG), 'x-ai/grok-4.6');
});

function tierMatchesHeavyOrReason(id) {
  return ['qwen/qwen3.8-2.4t-a95b', 'deepseek/deepseek-v4-pro-0813'].includes(id);
}

test('OPENZOO_DEFAULT_MODEL is an explicit override for any rewrite', () => {
  process.env.OPENZOO_DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning';
  try {
    assert.equal(resolveModel('gpt-4o', CATALOG), 'nvidia/nemotron-3.5-lightning');
    assert.equal(resolveModel('gemini-flash', CATALOG), 'nvidia/nemotron-3.5-lightning');
    // ...but never overrides an explicit valid choice
    assert.equal(resolveModel('deepseek/deepseek-v4-pro-0813', CATALOG), null);
    // an env value the zoo does not serve is ignored, not trusted
    process.env.OPENZOO_DEFAULT_MODEL = 'not/a-real-model';
    assert.equal(resolveModel('gpt-4o', CATALOG), 'x-ai/grok-4.6');
  } finally {
    delete process.env.OPENZOO_DEFAULT_MODEL;
  }
});

test('every shipped alias id resolves against the live-shaped catalog', async () => {
  const { ALIAS_IDS, augmentModelList } = await import('../lib/models.js');
  for (const id of ALIAS_IDS) {
    assert.ok(resolveModel(id, CATALOG), `alias ${id} did not resolve`);
  }
  const merged = augmentModelList({ object: 'list', data: CATALOG.map((id) => ({ id })) });
  // real models + one openzoo-<short> twin each + the harness aliases
  assert.equal(merged.data.length, CATALOG.length * 2 + ALIAS_IDS.length);
  // every twin points at a real model and is prefixed
  const twins = merged.data.filter((m) => m.id.startsWith('openzoo-'));
  assert.equal(twins.length, CATALOG.length);
  for (const t of twins) assert.ok(CATALOG.includes(t.served_by), `${t.id} -> ${t.served_by}`);
  // IDEMPOTENT: re-running must not double-add (no openzoo-openzoo-*)
  const again = augmentModelList(merged);
  assert.equal(again.data.length, merged.data.length);
  assert.equal(again.data.filter((m) => m.id.startsWith('openzoo-openzoo')).length, 0);
});

test('degenerate inputs never throw', () => {
  assert.equal(resolveModel(undefined, CATALOG), null);
  assert.equal(resolveModel('gpt-4o', []), null);
  assert.equal(resolveModel('gpt-4o', null), null);
});

test('an openzoo-* twin resolves EXACTLY to the model it was minted from', async () => {
  const { augmentModelList } = await import('../lib/models.js');
  // A catalog with a near-neighbour that similarity scoring used to prefer.
  const C = ['anthropic/claude-opus-5', 'anthropic/claude-opus-5-fast',
             'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5:batch',
             'deepseek/deepseek-v4-pro-0813'];
  const merged = augmentModelList({ object: 'list', data: C.map((id) => ({ id })) });
  for (const t of merged.data.filter((m) => m.id.startsWith('openzoo-'))) {
    assert.equal(resolveModel(t.id, C), t.served_by, `${t.id} must land on its source`);
  }
  // ...and the env override must NOT hijack an explicit twin (it did: every
  // picked model silently became the env one).
  process.env.OPENZOO_DEFAULT_MODEL = 'deepseek/deepseek-v4-pro-0813';
  try {
    assert.equal(resolveModel('openzoo-claude-opus-5', C), 'anthropic/claude-opus-5');
    assert.equal(resolveModel('openzoo-claude-sonnet-5', C), 'anthropic/claude-sonnet-5');
    // a FOREIGN id still honours the override
    assert.equal(resolveModel('gpt-4o', C), 'deepseek/deepseek-v4-pro-0813');
  } finally { delete process.env.OPENZOO_DEFAULT_MODEL; }
});
