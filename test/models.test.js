import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, isTinyClassify, pickClassifierModel, raiseReasoningMaxTokens, rewriteChatModel, REASONING_MODEL_RE } from '../lib/models.js';

// Hermetic: resolveModel honours OPENZOO_DEFAULT_MODEL, so an ambient value
// (a dev shell, a project .env) would otherwise flip every family-hint case.
delete process.env.OPENZOO_DEFAULT_MODEL;
delete process.env.OPENZOO_CLASSIFIER_MODEL;

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

// Claude Code auto-mode classifier: 16-token yes/no must never hit the
// reasoning floor or OPENZOO_DEFAULT_MODEL (that pair turned a classify
// into a 4000-token Grok/DeepSeek think and timed out).

const CLASSIFY = {
  model: 'claude-sonnet-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Is this command safe? Reply yes or no.' }],
};

test('isTinyClassify matches the 16-token auto-mode shape', () => {
  assert.equal(isTinyClassify(CLASSIFY), true);
  assert.equal(isTinyClassify(Buffer.from(JSON.stringify(CLASSIFY))), true);
  assert.equal(isTinyClassify({ ...CLASSIFY, max_tokens: 64 }), true);
  assert.equal(isTinyClassify({ ...CLASSIFY, max_tokens: 65 }), false);
  assert.equal(isTinyClassify({ ...CLASSIFY, max_tokens: 0 }), false);
  assert.equal(isTinyClassify({ model: 'x-ai/grok-4.6', max_tokens: 2000, messages: CLASSIFY.messages }), false);
  // A body over BIND_MIN is a real turn even at 16 tokens.
  const big = { ...CLASSIFY, messages: [{ role: 'user', content: 'x'.repeat(20000) }] };
  assert.equal(isTinyClassify(big), false);
});

test('raiseReasoningMaxTokens itself still floors a 16-token grok ask', () => {
  // The floor is correct for a real reasoning turn. The classify skip is
  // in rewriteChatModel, which must not call this for a tiny body.
  const bump = raiseReasoningMaxTokens({ model: 'x-ai/grok-4.6', max_tokens: 16 });
  assert.equal(bump.raised, true);
  assert.ok(bump.to >= 4000);
});

test('tiny max_tokens=16 + grok model does NOT raise', () => {
  const grok = { model: 'x-ai/grok-4.6', max_tokens: 16, messages: CLASSIFY.messages };
  const out = rewriteChatModel(grok, CATALOG);
  assert.equal(out.tiny, true);
  assert.equal(out.raised, false);
  assert.equal(out.parsed.max_tokens, 16);
  assert.equal(REASONING_MODEL_RE.test(out.parsed.model), false);
});

test('tiny claude-sonnet-5 routes to flash when the catalog has it', () => {
  const out = rewriteChatModel(CLASSIFY, CATALOG);
  assert.equal(out.tiny, true);
  assert.equal(out.parsed.model, 'google/gemini-3.7-flash');
  assert.equal(out.parsed.max_tokens, 16);
  assert.equal(out.to, 'google/gemini-3.7-flash');
});

test('real grok max_tokens=2000 still raises to >=4000', () => {
  const grok = { model: 'x-ai/grok-4.6', max_tokens: 2000, messages: [{ role: 'user', content: 'write the function' }] };
  const bump = raiseReasoningMaxTokens(grok);
  assert.equal(bump.raised, true);
  assert.ok(bump.to >= 4000, `expected floor >=4000, got ${bump.to}`);
  const out = rewriteChatModel(grok, CATALOG);
  assert.equal(out.tiny, false);
  assert.equal(out.raised, true);
  assert.ok(out.parsed.max_tokens >= 4000);
  assert.equal(out.parsed.model, 'x-ai/grok-4.6');
});

test('OPENZOO_DEFAULT_MODEL does not capture a tiny classify', () => {
  process.env.OPENZOO_DEFAULT_MODEL = 'x-ai/grok-4.6';
  try {
    const out = rewriteChatModel(CLASSIFY, CATALOG);
    assert.equal(out.tiny, true);
    assert.notEqual(out.parsed.model, 'x-ai/grok-4.6');
    assert.equal(out.parsed.model, 'google/gemini-3.7-flash');
    assert.equal(out.parsed.max_tokens, 16);
    // A real rewrite still honours the override.
    const chat = rewriteChatModel({ model: 'gpt-4o', max_tokens: 2000, messages: CLASSIFY.messages }, CATALOG);
    assert.equal(chat.tiny, false);
    assert.equal(chat.parsed.model, 'x-ai/grok-4.6');
    assert.ok(chat.parsed.max_tokens >= 4000);
  } finally {
    delete process.env.OPENZOO_DEFAULT_MODEL;
  }
});

test('pickClassifierModel prefers env, then flash, then haiku, then first non-reasoner', () => {
  assert.equal(pickClassifierModel(CATALOG), 'google/gemini-3.7-flash');
  assert.equal(pickClassifierModel(['x-ai/grok-4.6', 'anthropic/claude-haiku-4.5']), 'anthropic/claude-haiku-4.5');
  assert.equal(pickClassifierModel(['x-ai/grok-4.6', 'deepseek/deepseek-v4-pro-0813', 'qwen/qwen3.8-2.4t-a95b']), 'qwen/qwen3.8-2.4t-a95b');
  assert.equal(pickClassifierModel(['x-ai/grok-4.6', 'deepseek/deepseek-v4-pro-0813']), null);
  assert.equal(pickClassifierModel(CATALOG, 'nvidia/nemotron-3.5-lightning'), 'nvidia/nemotron-3.5-lightning');
  process.env.OPENZOO_CLASSIFIER_MODEL = 'bytedance-seed/seed-2-1-turbo';
  try {
    assert.equal(pickClassifierModel(CATALOG), 'bytedance-seed/seed-2-1-turbo');
  } finally {
    delete process.env.OPENZOO_CLASSIFIER_MODEL;
  }
});
