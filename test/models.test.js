import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, isTinyClassify, pickClassifierModel, raiseReasoningMaxTokens, rewriteChatModel, REASONING_MODEL_RE, displayNameFor, publishModelList, anthropicModelList, modelsListForRequest, anthropicNativeAlias, ANTHROPIC_NATIVE_ALIASES, isHarnessAliasId, isQuoteableModel, quoteableRows } from '../lib/models.js';
import { applyClaudeCodeCatalogEnv, claudeZooEnv, resolveClaudeCli, claudeCodeBinDirs } from '../lib/launch.js';
import { anthropicToOpenAI } from '../lib/anthropic.js';


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

test('OPENZOO_DEFAULT_MODEL=opus-5 does not swallow an explicit catalog pick', () => {
  process.env.OPENZOO_DEFAULT_MODEL = 'anthropic/claude-opus-5';
  const ids = [...CATALOG, 'anthropic/claude-opus-5'];
  try {
    assert.equal(resolveModel('x-ai/grok-4.6', ids), null);
    assert.equal(resolveModel('openzoo-grok-4.6', ids), 'x-ai/grok-4.6');
    const grok = rewriteChatModel({
      model: 'x-ai/grok-4.6',
      max_tokens: 2000,
      messages: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `turn ${i} ${'x'.repeat(500)}`,
      })),
    }, ids);
    assert.equal(grok.tiny, false);
    assert.equal(grok.parsed.model, 'x-ai/grok-4.6');
    const twin = rewriteChatModel({
      model: 'openzoo-grok-4.6',
      max_tokens: 2000,
      messages: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `turn ${i} ${'x'.repeat(500)}`,
      })),
    }, ids);
    assert.equal(twin.parsed.model, 'x-ai/grok-4.6');
  } finally {
    delete process.env.OPENZOO_DEFAULT_MODEL;
  }
});

function pricedRow(id, prompt = 1e-6, completion = 2e-6) {
  return { id, object: 'model', pricing: { prompt, completion, unit: 'USD' } };
}

test('every shipped alias id resolves against the live-shaped catalog', async () => {
  const { ALIAS_IDS, augmentModelList } = await import('../lib/models.js');
  for (const id of ALIAS_IDS) {
    assert.ok(resolveModel(id, CATALOG), `alias ${id} did not resolve`);
  }
  const rows = CATALOG.map((id) => (
    id.includes(':free') ? { id, pricing: { prompt: 0, completion: 0 } } : pricedRow(id)
  ));
  const merged = augmentModelList({ object: 'list', data: rows });
  const ids = merged.data.map((m) => m.id);
  const quoteable = CATALOG.filter((id) => !id.includes(':batch') && !id.includes(':free'));
  // quoteable real models + harness aliases + openzoo/auto — no openzoo-* twins
  assert.equal(merged.data.length, quoteable.length + ALIAS_IDS.length + 1);
  assert.ok(merged.data.some((m) => m.id === 'openzoo/auto'));
  assert.equal(ids.filter((id) => id.startsWith('openzoo-')).length, 0);
  assert.equal(ids.filter((id) => id.includes(':batch')).length, 0);
  assert.ok(!ids.includes('liquid/lfm-2.5-2.6b:free'));
  for (const id of quoteable) assert.ok(ids.includes(id), `missing ${id}`);
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
  const merged = augmentModelList({ object: 'list', data: C.map((id) => pricedRow(id)) });
  // Twins are no longer published (they cloned every id in Claude /model).
  assert.equal(merged.data.filter((m) => m.id.startsWith('openzoo-')).length, 0);
  assert.ok(!merged.data.some((m) => m.id.includes(':batch')));
  // Incoming openzoo-* ids still resolve — launch.js may still send them.
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
  assert.equal(isTinyClassify({ ...CLASSIFY, max_tokens: 256 }), true);
  assert.equal(isTinyClassify({ ...CLASSIFY, max_tokens: 0 }), false);
});

test('3c-shaped grok nubs are tiny (max_tokens 128 or 2000 on a 1-2 message body)', () => {
  const nub128 = { model: 'x-ai/grok-4.6', max_tokens: 128, messages: CLASSIFY.messages };
  const nub2000 = { model: 'x-ai/grok-4.6', max_tokens: 2000, messages: CLASSIFY.messages };
  const nubTwo = {
    model: 'x-ai/grok-4.6',
    max_tokens: 2000,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Is this safe? yes or no.' },
    ],
  };
  assert.equal(isTinyClassify(nub128), true);
  assert.equal(isTinyClassify(nub2000), true);
  assert.equal(isTinyClassify(nubTwo), true);
  for (const body of [nub128, nub2000, nubTwo]) {
    const out = rewriteChatModel(body, CATALOG);
    assert.equal(out.tiny, true, `expected tiny for max_tokens=${body.max_tokens}`);
    assert.equal(out.raised, false);
    assert.equal(out.parsed.max_tokens, body.max_tokens);
    assert.equal(out.parsed.model, 'google/gemini-3.7-flash');
    assert.equal(REASONING_MODEL_RE.test(out.parsed.model), false);
  }
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

test('fat grok chat (max_tokens 2000+ and a long transcript) still raises to >=4000', () => {
  const grok = {
    model: 'x-ai/grok-4.6',
    max_tokens: 2000,
    messages: Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `turn ${i} ${'x'.repeat(2000)}`,
    })),
  };
  assert.equal(isTinyClassify(grok), false);
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
    const fatMsgs = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `turn ${i} ${'x'.repeat(500)}`,
    }));
    const chat = rewriteChatModel({ model: 'gpt-4o', max_tokens: 2000, messages: fatMsgs }, CATALOG);
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

// opus-5 is openzoo's default session model. HEAVY_RE matches `opus`, but
// pickClassifierModel used to skip only REASONING_MODEL_RE, so a catalog of
// [opus-5, grok] returned opus-5 as "first non-reasoner". rewriteChatModel
// then did `(picked) || from` and a catalog miss left the classify on opus-5.
// AUTO's classify timeout hard-blocks Bash ("cannot determine the safety").

const OPUS5 = 'anthropic/claude-opus-5';
const OPUS_CLASSIFY = {
  model: OPUS5,
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Is this command safe? Reply yes or no.' }],
};
const OPUS_ONLY = [OPUS5, 'x-ai/grok-4.6', 'deepseek/deepseek-v4-pro-0813'];

function assertClassifyNotHardBlocked(out, { maxTokens = 16 } = {}) {
  assert.equal(out.tiny, true);
  assert.equal(out.raised, false);
  assert.equal(out.parsed.max_tokens, maxTokens);
  assert.notEqual(out.parsed.model, OPUS5);
  assert.equal(/opus/i.test(out.parsed.model), false);
  assert.equal(REASONING_MODEL_RE.test(out.parsed.model), false);
  // A 4000-token reasoning floor on this body is what AUTO times out on.
  const floor = raiseReasoningMaxTokens(out.parsed);
  assert.equal(floor.raised, false, 'shipped classify body must not hit the reasoning floor');
}

test('pickClassifierModel never returns opus-5 as first non-reasoner', () => {
  assert.equal(pickClassifierModel(OPUS_ONLY), null);
  assert.equal(pickClassifierModel([OPUS5]), null);
  assert.equal(pickClassifierModel([OPUS5, 'anthropic/claude-opus-5-fast', 'x-ai/grok-4.6']), null);
});

test('opus-5 AUTO classify never stays on opus-5 (full catalog, opus-only, catalog miss)', () => {
  const catalogs = [CATALOG, OPUS_ONLY, []];
  for (const ids of catalogs) {
    const out = rewriteChatModel(OPUS_CLASSIFY, ids);
    assertClassifyNotHardBlocked(out);
    assert.equal(out.from, OPUS5);
  }
  const withFlash = rewriteChatModel(OPUS_CLASSIFY, CATALOG);
  assert.equal(withFlash.parsed.model, 'google/gemini-3.7-flash');
  const noFlash = rewriteChatModel(OPUS_CLASSIFY, OPUS_ONLY);
  assert.equal(noFlash.parsed.model, 'google/gemini-3.7-flash');
  const miss = rewriteChatModel(OPUS_CLASSIFY, []);
  assert.equal(miss.parsed.model, 'google/gemini-3.7-flash');
});

test('opus-5 AUTO classify ignores OPENZOO_DEFAULT_MODEL and does not raise', () => {
  process.env.OPENZOO_DEFAULT_MODEL = OPUS5;
  try {
    for (const ids of [CATALOG, OPUS_ONLY, []]) {
      const out = rewriteChatModel(OPUS_CLASSIFY, ids);
      assertClassifyNotHardBlocked(out);
      assert.notEqual(out.parsed.model, process.env.OPENZOO_DEFAULT_MODEL);
    }
  } finally {
    delete process.env.OPENZOO_DEFAULT_MODEL;
  }
});

test('bare Anthropic classifier ids always alias to a priced anthropic/ twin', () => {
  // Fly x402-tokens 500s `claude-opus-5` ("unknown model") and 402s the twin.
  // Catalog miss, catalog listing the bare name, and a live zoo catalog
  // must all rewrite — the sidecar must never forward the bare id.
  assert.equal(anthropicNativeAlias('claude-opus-5'), 'anthropic/claude-opus-5');
  assert.equal(anthropicNativeAlias('claude-opus-5-fast'), 'anthropic/claude-opus-5-fast');
  assert.equal(anthropicNativeAlias('claude-3-5-opus'), 'anthropic/claude-opus-5');
  assert.equal(anthropicNativeAlias('claude-opus-5[1m]'), 'anthropic/claude-opus-5');
  assert.equal(anthropicNativeAlias('anthropic/claude-opus-5'), null);
  assert.equal(anthropicNativeAlias('openzoo-claude-opus-5'), null);
  assert.equal(isHarnessAliasId('claude-opus-5'), true);
  assert.equal(isHarnessAliasId('claude-opus-5[1m]'), true);

  const catalogs = [
    CATALOG,
    [...CATALOG, 'anthropic/claude-opus-5', 'anthropic/claude-opus-5-fast'],
    ['claude-opus-5', 'anthropic/claude-opus-5'],
    [],
  ];
  for (const id of Object.keys(ANTHROPIC_NATIVE_ALIASES)) {
    const want = ANTHROPIC_NATIVE_ALIASES[id];
    for (const ids of catalogs) {
      assert.equal(resolveModel(id, ids), want, `${id} vs ${ids.length} ids`);
      assert.notEqual(resolveModel(id, ids), id);
    }
  }
});

test('non-tiny /v1/messages claude-opus-5 rewrites off the bare id', () => {
  const fat = {
    model: 'claude-opus-5',
    max_tokens: 2000,
    messages: Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `turn ${i} ${'x'.repeat(500)}`,
    })),
  };
  assert.equal(isTinyClassify(fat), false);
  for (const ids of [CATALOG, [...CATALOG, 'anthropic/claude-opus-5'], [], ['claude-opus-5']]) {
    const out = rewriteChatModel(fat, ids);
    assert.equal(out.tiny, false);
    assert.notEqual(out.parsed.model, 'claude-opus-5');
    assert.equal(out.parsed.model.includes('/'), true, `expected vendor-prefixed id, got ${out.parsed.model}`);
  }
  const withTwin = rewriteChatModel(fat, [...CATALOG, 'anthropic/claude-opus-5']);
  assert.equal(withTwin.parsed.model, 'anthropic/claude-opus-5');
});

test('tiny classify on bare claude-opus-5 still pins to flash, never the bare id', () => {
  const body = {
    model: 'claude-opus-5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Is this command safe? Reply yes or no.' }],
  };
  for (const ids of [CATALOG, [], ['claude-opus-5', 'anthropic/claude-opus-5']]) {
    const out = rewriteChatModel(body, ids);
    assertClassifyNotHardBlocked(out);
    assert.notEqual(out.parsed.model, 'claude-opus-5');
  }
});

test('Anthropic Messages opus-5 classify is pinned off opus-5 after translate', () => {
  // Claude Code speaks /v1/messages; proxy converts then rewriteChatModel.
  const inbound = {
    model: OPUS5,
    max_tokens: 16,
    system: 'Reply yes or no.',
    messages: [{ role: 'user', content: 'Is this Bash command safe?' }],
  };
  const converted = anthropicToOpenAI(inbound);
  assert.equal(isTinyClassify(converted), true);
  for (const ids of [CATALOG, OPUS_ONLY, []]) {
    const out = rewriteChatModel(converted, ids);
    assertClassifyNotHardBlocked(out);
  }
});


// Mock of GET {OPENZOO_API_BASE}/v1/models (live OpenRouter catalog).
// Not a product "33-item" list — the real catalog is whatever the gateway
// returns; augmentModelList then adds openzoo-* twins + ALIAS_IDS.

const ZOO_CATALOG = [
  'deepseek/deepseek-v4-flash',
  'meta-llama/llama-4-scout',
  'z-ai/glm-4.7-flash',
  'bytedance-seed/seed-2.0-mini',
  'meta-llama/llama-4-maverick',
  'z-ai/glm-4.5-air',
  'minimax/minimax-m2.5',
  'z-ai/glm-4.6v',
  'minimax/minimax-m2',
  'inclusionai/ling-3.0-flash',
  'deepseek/deepseek-v4-pro-0813',
  'z-ai/glm-4.7',
  'google/gemini-3.7-flash',
  'x-ai/grok-4.3',
  'moonshotai/kimi-k2.7-code',
  'z-ai/glm-5',
  'moonshotai/kimi-k2.6',
  'mistralai/mistral-large-2512',
  'bytedance-seed/seed-2.0-code',
  'qwen/qwen3.8-27b',
  'anthropic/claude-opus-5',
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-fable-5',
  'openai/gpt-5.5',
  'anthropic/claude-sonnet-5',
  'x-ai/grok-4.6',
  'moonshotai/kimi-k3',
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.4',
  'qwen/qwen3.8-max',
  'x-ai/grok-4.5',
  'x-ai/grok-4.20',
  'google/gemini-3.7-pro',
  'qwen/qwen3.8-2.4t-a95b',
  'nvidia/nemotron-3.5-lightning',
];

function zooPayload() {
  return {
    object: 'list',
    data: [
      ...ZOO_CATALOG.map((id) => pricedRow(id)),
      pricedRow('anthropic/claude-opus-5:batch'),
      pricedRow('anthropic/claude-fable-5:batch'),
      pricedRow('openzoo-claude-fable-5'),
      pricedRow('~anthropic/claude-opus-latest'),
      { id: 'openrouter/auto', object: 'model', pricing: { prompt: -3, completion: -3, unit: 'USD' } },
      { id: 'liquid/lfm-2.5-2.6b:free', object: 'model', pricing: { prompt: 0, completion: 0, unit: 'USD' } },
      { id: 'google/lyria-3-pro-preview', object: 'model', pricing: { unit: 'megapixel', usd: 0.12 } },
    ],
  };
}

function fakeClaudeAliases(ids) {
  return ids.filter((id) => {
    if (!/^claude-/i.test(id)) return false;
    const rest = id.slice('claude-'.length).toLowerCase();
    return /grok|deepseek|gemini|qwen|llama|glm|kimi|mistral|nemotron|minimax|seed/.test(rest);
  });
}

test('isQuoteableModel drops :batch, twins, $0, missing token price', () => {
  assert.equal(isQuoteableModel(pricedRow('x-ai/grok-4.6')), true);
  assert.equal(isQuoteableModel(pricedRow('anthropic/claude-fable-5:batch')), false);
  assert.equal(isQuoteableModel(pricedRow('openzoo-claude-fable-5')), false);
  assert.equal(isQuoteableModel(pricedRow('~anthropic/claude-opus-latest')), false);
  assert.equal(isQuoteableModel({ id: 'openrouter/auto', pricing: { prompt: -3, completion: -3 } }), false);
  assert.equal(isQuoteableModel({ id: 'liquid/lfm-2.5-2.6b:free', pricing: { prompt: 0, completion: 0 } }), false);
  assert.equal(isQuoteableModel({ id: 'google/lyria-3-pro-preview', pricing: { unit: 'megapixel', usd: 0.12 } }), false);
  assert.equal(isQuoteableModel({ id: 'x-ai/grok-4.6' }), false);
  assert.equal(isQuoteableModel({ id: 'openzoo/auto' }), true);
});

test('publishModelList keeps quoteable zoo ids, not a single opus-5 and not clones', async () => {
  const { ALIAS_IDS } = await import('../lib/models.js');
  const published = publishModelList(zooPayload());
  const ids = published.data.map((m) => m.id);
  assert.ok(ids.length > 1, `expected a catalog, got ${ids.length} id(s)`);
  assert.notEqual(ids.length, 1);
  assert.ok(ids.includes('x-ai/grok-4.6'));
  assert.ok(ids.includes('deepseek/deepseek-v4-flash'));
  assert.ok(ids.includes('google/gemini-3.7-flash'));
  assert.ok(ids.includes('anthropic/claude-opus-5'));
  for (const id of ZOO_CATALOG) assert.ok(ids.includes(id), `missing ${id}`);
  assert.equal(ids.filter((id) => id === 'anthropic/claude-opus-5').length, 1);
  assert.equal(ids.filter((id) => id.includes(':batch')).length, 0);
  assert.equal(ids.filter((id) => id.startsWith('openzoo-')).length, 0);
  assert.ok(!ids.includes('openzoo-claude-fable-5'));
  assert.ok(!ids.includes('openrouter/auto'));
  assert.ok(!ids.includes('liquid/lfm-2.5-2.6b:free'));
  assert.ok(!ids.includes('~anthropic/claude-opus-latest'));
  assert.equal(fakeClaudeAliases(ids).length, 0, `must not mint claude-* for non-Anthropic animals: ${fakeClaudeAliases(ids)}`);
  assert.equal(published.data.find((m) => m.id === 'x-ai/grok-4.6').display_name, 'grok-4.6 (x-ai)');
  assert.equal(displayNameFor('anthropic/claude-opus-5'), 'claude-opus-5 (anthropic)');
  assert.equal(published.object, 'list');
  assert.ok(ids.includes('openzoo/auto'));
  assert.ok(ALIAS_IDS.every((id) => ids.includes(id)));
  assert.ok(ids.includes('claude-opus-5'));
  assert.ok(ids.includes('claude-opus-5-fast'));
  assert.ok(ids.includes('claude-3-5-opus'));
});

test('anthropicModelList is the quoteable catalog in Anthropic shape (Claude Code reads id + display_name)', () => {
  const shaped = anthropicModelList(zooPayload());
  const published = publishModelList(zooPayload(), { aliases: false });
  const ids = shaped.data.map((m) => m.id);
  assert.ok(shaped.data.length > 4, `picker must not cap at 4 Claude ids, got ${ids.join(', ')}`);
  assert.equal(ids[0], 'openzoo/auto');
  assert.ok(ids.includes('google/gemini-3.7-flash'), 'OpenRouter ids must be selectable');
  assert.ok(ids.includes('x-ai/grok-4.6'));
  assert.ok(ids.includes('openai/gpt-5.5'));
  assert.ok(ids.includes('anthropic/claude-opus-5'));
  assert.ok(ids.includes('anthropic/claude-sonnet-5'));
  assert.ok(ids.includes('anthropic/claude-haiku-4.5'));
  assert.ok(ids.includes('anthropic/claude-fable-5'));
  assert.ok(ids.includes('deepseek/deepseek-v4-pro-0813'));
  assert.ok(ids.includes('qwen/qwen3.8-2.4t-a95b'));
  for (const id of ZOO_CATALOG) assert.ok(ids.includes(id), `missing ${id}`);
  assert.equal(ids.length, published.data.length);
  assert.deepEqual(ids.slice().sort(), published.data.map((m) => m.id).sort());
  assert.ok(!ids.includes('anthropic/claude-opus-5:batch'));
  assert.ok(!ids.includes('openzoo-claude-fable-5'));
  assert.ok(!ids.includes('gpt-4o'));
  assert.equal(ids.filter((id) => id.includes(':batch')).length, 0);
  assert.equal(ids.filter((id) => id.startsWith('openzoo-')).length, 0);
  assert.equal(fakeClaudeAliases(ids).length, 0);
  for (const row of shaped.data) {
    assert.equal(row.type, 'model');
    assert.ok(row.display_name);
    assert.ok(!('object' in row), 'Anthropic shape is type/id/display_name, not OpenAI object');
  }
  const grok = shaped.data.find((m) => m.id === 'x-ai/grok-4.6');
  assert.equal(grok.display_name, 'grok-4.6 (x-ai)');
  assert.ok(!/^claude-/.test(grok.id));
  const gemini = shaped.data.find((m) => m.id === 'google/gemini-3.7-flash');
  assert.equal(gemini.display_name, 'gemini-3.7-flash (google)');
});

test('applyClaudeCodeCatalogEnv opts Claude Code into GET /v1/models discovery', async () => {
  const env = applyClaudeCodeCatalogEnv({
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
  });
  assert.equal(env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
  assert.equal(env.ANTHROPIC_MODEL, undefined, 'must not pin a single sonnet/opus');
  const skipped = applyClaudeCodeCatalogEnv({ OPENZOO_NO_GATEWAY_DISCOVERY: '1' });
  assert.equal(skipped.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY, undefined);
  const aliased = applyClaudeCodeCatalogEnv({ ANTHROPIC_MODEL: 'claude-sonnet-5' });
  assert.equal(aliased.ANTHROPIC_MODEL, 'openzoo-claude-sonnet-5');
  const grok = applyClaudeCodeCatalogEnv({ ANTHROPIC_MODEL: 'x-ai/grok-4.6' });
  assert.equal(grok.ANTHROPIC_MODEL, 'x-ai/grok-4.6');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const launchSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/launch.js'), 'utf8');
  assert.doesNotMatch(launchSrc, /\|\| 'claude-sonnet-5'/);
  // Terminal `openzoo claude` must keep Auto permissions (classifier on).
  // grokui Auto is the one that passes --permission-mode bypassPermissions.
  assert.doesNotMatch(launchSrc, /bypassPermissions/);
});

test('claudeZooEnv is the openzoo claude writer: gateway token, no Anthropic API key', () => {
  const env = claudeZooEnv({
    ANTHROPIC_API_KEY: 'sk-ant-real',
    PATH: '/usr/bin',
    HOME: '/tmp',
  }, { port: 8402 });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://localhost:8402/v1');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-openzoo');
  assert.equal(env.DISABLE_COMPACT, '1');
  assert.equal(env.DISABLE_AUTO_COMPACT, '1');
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
  assert.match(env.PATH, /\/usr\/bin/);
  const dirs = claudeCodeBinDirs('/Users/x');
  assert.ok(dirs.some((d) => d.endsWith('/.local/bin')));
  assert.equal(resolveClaudeCli({ PATH: '/no/such/claude-bin', OPENZOO_CLAUDE_PATH_ONLY: '1' }), null);
});

test('GET /v1/models (OpenAI + Claude-shaped) returns the mocked zoo catalog, not opus-5-only', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const proxySrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../lib/proxy.js'), 'utf8');
  assert.match(proxySrc, /modelsListForRequest\(payload, req\.headers\)/);
  assert.match(proxySrc, /path === '\/v1\/models'/);

  // Mocked upstream catalog — same body the proxy publishes after unpaid fetchHeaders.
  const openai = modelsListForRequest(zooPayload(), {});
  const ids = openai.data.map((m) => m.id);
  assert.ok(ids.length >= ZOO_CATALOG.length, `got ${ids.length} models`);
  assert.ok(ids.includes('x-ai/grok-4.6'));
  assert.ok(ids.includes('deepseek/deepseek-v4-flash'));
  assert.ok(ids.includes('anthropic/claude-opus-5'));
  assert.notEqual(ids.length, 1);
  assert.ok(!(ids.length === 1 && ids[0] === 'anthropic/claude-opus-5'));
  assert.equal(ids.filter((id) => id.includes(':batch')).length, 0);
  assert.equal(ids.filter((id) => id.startsWith('openzoo-')).length, 0);
  assert.equal(fakeClaudeAliases(ids).length, 0);
  assert.equal(openai.object, 'list');
  assert.ok(openai.data.find((m) => m.id === 'x-ai/grok-4.6')?.display_name);
  assert.deepEqual(quoteableRows(zooPayload().data).map((m) => m.id).sort(),
    ZOO_CATALOG.slice().sort());

  const shaped = modelsListForRequest(zooPayload(), {
    'anthropic-version': '2023-06-01',
    'x-app': 'cli',
  });
  const cids = shaped.data.map((m) => m.id);
  assert.equal(cids[0], 'openzoo/auto');
  assert.ok(cids.includes('x-ai/grok-4.6'), 'Claude-shaped list must keep grok, not filter to claude-*');
  assert.ok(cids.includes('google/gemini-3.7-flash'));
  assert.ok(cids.includes('deepseek/deepseek-v4-pro-0813'));
  assert.ok(cids.includes('openai/gpt-5.5'));
  assert.ok(cids.length > 4, `must be the quoteable catalog, not 4 Claude rows (${cids.join(', ')})`);
  assert.ok(cids.length >= ZOO_CATALOG.length);
  assert.equal(fakeClaudeAliases(cids).length, 0);
  assert.equal(shaped.data.find((m) => m.id === 'x-ai/grok-4.6').type, 'model');
});

// Sidecar /v1/messages: Claude Code's classifier POSTs model=claude-opus-5.
// Fly 500s that bare id. The proxy must rewrite before the request leaves.

test('POST /v1/messages model=claude-opus-5 does not 500 unavailable', async (t) => {
  const http = await import('node:http');
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { config } = await import('../lib/config.js');
  const { resetZooModelIdsCache } = await import('../lib/models.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-opus5-'));
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

  const seen = [];
  const catalog = {
    object: 'list',
    data: [
      { id: 'anthropic/claude-opus-5', object: 'model' },
      { id: 'anthropic/claude-opus-5-fast', object: 'model' },
      { id: 'anthropic/claude-sonnet-5', object: 'model' },
      { id: 'google/gemini-3.7-flash', object: 'model' },
    ],
  };
  const completion = {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'yes' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 8, completion_tokens: 1 },
  };

  const up = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.split('?')[0] === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(catalog));
        return;
      }
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(buf || '{}'); } catch { body = {}; }
        seen.push({ path: req.url, model: body.model });
        const bare = String(body.model || '');
        if (!bare.includes('/') && /^claude-/i.test(bare)) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `unknown model ${bare}` }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...completion, model: body.model }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });

  resetZooModelIdsCache();
  config.apiBase = `http://127.0.0.1:${up.address().port}`;
  config.port = 0;
  const { startProxy } = await import('../lib/proxy.js');
  const proxy = await startProxy({ silent: true, autoTunnel: false });
  t.after(async () => {
    await new Promise((resolve) => {
      try { proxy.server?.closeAllConnections?.(); } catch { /* already */ }
      if (!proxy.server) { resolve(); return; }
      proxy.server.close(() => resolve());
      setTimeout(resolve, 400).unref?.();
    });
    await new Promise((resolve) => {
      try { up.closeAllConnections?.(); } catch { /* already */ }
      up.close(() => resolve());
      setTimeout(resolve, 400).unref?.();
    });
    config.apiBase = prev.apiBase;
    config.port = prev.port;
    config.walletPath = prev.walletPath;
    if (prev.noTopup == null) delete process.env.OPENZOO_NO_AUTOTOPUP;
    else process.env.OPENZOO_NO_AUTOTOPUP = prev.noTopup;
    if (prev.sessionPath == null) delete process.env.OPENZOO_SESSION_PATH;
    else process.env.OPENZOO_SESSION_PATH = prev.sessionPath;
    resetZooModelIdsCache();
  });

  const port = proxy.server.address().port;
  const post = (model, extra = {}) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Is this command safe? Reply yes or no.' }],
      ...extra,
    }),
  });

  for (const id of ['claude-opus-5', 'claude-opus-5-fast', 'claude-3-5-opus', 'claude-opus-5[1m]']) {
    const r = await post(id);
    const text = await r.text();
    assert.notEqual(r.status, 500, `${id} must not 500: ${text}`);
    assert.doesNotMatch(text, /unknown model|temporarily unavailable/i);
    assert.equal(r.status, 200, `${id} expected 200, got ${r.status} ${text}`);
    const msg = JSON.parse(text);
    const content = msg.content ?? msg.choices?.[0]?.message?.content;
    assert.match(JSON.stringify(content), /yes/, `body: ${text}`);
  }

  const forwarded = seen.filter((h) => h.model != null);
  assert.ok(forwarded.length >= 1, `expected an upstream POST, got ${JSON.stringify(seen)}`);
  for (const hit of forwarded) {
    assert.ok(String(hit.model).includes('/'), `upstream must not see a bare Anthropic id: ${hit.model}`);
    assert.notEqual(hit.model, 'claude-opus-5');
    assert.notEqual(hit.model, 'claude-opus-5-fast');
    assert.notEqual(hit.model, 'claude-3-5-opus');
  }
  // Tiny classify pins to flash; that is a live priced id, not the bare one.
  assert.ok(forwarded.some((h) => h.model === 'google/gemini-3.7-flash'));

  const probe = await fetch(`http://127.0.0.1:${port}/v1/models/claude-opus-5`);
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).id, 'claude-opus-5');

  // Non-tiny chat with the same bare id must also rewrite (not only classify).
  const fat = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 2000,
      messages: Array.from({ length: 20 }, (_, i) => ({
        role: i % 2 ? 'assistant' : 'user',
        content: `turn ${i} ${'x'.repeat(500)}`,
      })),
    }),
  });
  const fatText = await fat.text();
  assert.equal(fat.status, 200, `fat claude-opus-5 expected 200, got ${fat.status} ${fatText}`);
  const last = seen[seen.length - 1];
  assert.equal(last.model, 'anthropic/claude-opus-5');
});
