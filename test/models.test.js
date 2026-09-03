import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel, unopenrouter, displayNameFor, publishModelList, anthropicModelList, modelsListForRequest, anthropicNativeAlias, ANTHROPIC_NATIVE_ALIASES, isHarnessAliasId, isQuoteableModel, pickClaudePickerRows, quoteableRows } from '../lib/models.js';
import { applyClaudeCodeCatalogEnv, claudeZooEnv, resolveClaudeCli, claudeCodeBinDirs } from '../lib/launch.js';


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
  // quoteable real models + harness aliases + BARE-NAME twins, derived from the
  // catalog so `/model deepseek-v4-pro-0813` resolves without that string having
  // been hand-added to ALIAS_IDS. Computed, not hardcoded: the whole point is
  // that this set tracks the catalog instead of drifting from it.
  const taken = new Set([...quoteable, ...ALIAS_IDS]);
  const bareExpected = [];
  for (const id of quoteable) {
    const short = id.includes('/') ? id.split('/').pop() : null;
    if (!short || taken.has(short)) continue;
    taken.add(short);
    bareExpected.push(short);
  }
  // ...plus FAMILY shortcuts ('grok', 'deepseek', ...) — computed the same way
  // augmentModelList computes them, because Claude Code validates /model
  // against this list only (proven live: the fuzzy per-id probe answered 200
  // and the client refused the id anyway).
  const FAMILY_TOKENS = ['gpt', 'claude', 'gemini', 'grok', 'deepseek', 'qwen',
    'mistral', 'llama', 'glm', 'kimi', 'minimax', 'command', 'nova', 'sonar'];
  const familyExpected = [];
  for (const tok of FAMILY_TOKENS) {
    if (taken.has(tok)) continue;
    const target = resolveModel(tok, quoteable);
    if (!target || !quoteable.includes(target)) continue;
    taken.add(tok);
    familyExpected.push(tok);
  }
  // no auto row, no openzoo-* twins
  assert.equal(merged.data.length, quoteable.length + ALIAS_IDS.length + bareExpected.length + familyExpected.length);
  for (const tok of familyExpected) {
    const row = merged.data.find((m) => m.id === tok);
    assert.ok(row?.served_by, `family shortcut ${tok} missing or unresolved`);
  }
  // The bare name must be present AND point at the real id it came from.
  for (const short of bareExpected) {
    const row = merged.data.find((m) => m.id === short);
    assert.ok(row, `bare alias ${short} missing`);
    assert.ok(row.served_by && row.served_by.endsWith(`/${short}`), `bare alias ${short} resolves wrong`);
  }
  // A real id is never shadowed by a bare twin of some other vendor's row.
  for (const id of quoteable) {
    const row = merged.data.find((m) => m.id === id);
    assert.equal(row.served_by, undefined, `real id ${id} was shadowed by an alias`);
  }
  assert.ok(!merged.data.some((m) => m.id === 'openzoo/auto'));
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
  assert.ok(!ids.includes('openzoo/auto'));
  assert.ok(ALIAS_IDS.every((id) => ids.includes(id)));
  assert.ok(ids.includes('claude-opus-5'));
  assert.ok(ids.includes('claude-opus-5-fast'));
  assert.ok(ids.includes('claude-3-5-opus'));
});

test('anthropicModelList is a short honest picker (Claude Code reads id + display_name)', () => {
  const shaped = anthropicModelList(zooPayload());
  const ids = shaped.data.map((m) => m.id);
  assert.ok(shaped.data.length > 1);
  assert.ok(shaped.data.length <= 12, `Claude picker should be short, got ${ids.join(', ')}`);
  assert.ok(ids.includes('anthropic/claude-opus-5'));
  assert.ok(ids.includes('anthropic/claude-sonnet-5'));
  assert.ok(ids.includes('anthropic/claude-haiku-4.5'));
  assert.ok(ids.includes('anthropic/claude-fable-5'));
  assert.ok(ids.includes('x-ai/grok-4.6'));
  assert.ok(ids.includes('google/gemini-3.7-flash'));
  assert.ok(ids.includes('deepseek/deepseek-v4-pro-0813'));
  assert.ok(ids.includes('qwen/qwen3.8-2.4t-a95b'));
  assert.ok(!ids.includes('openzoo/auto'));
  assert.ok(!ids.includes('anthropic/claude-opus-5:batch'));
  assert.ok(!ids.includes('openzoo-claude-fable-5'));
  assert.ok(!ids.includes('gpt-4o'));
  assert.equal(ids.filter((id) => id.includes(':batch')).length, 0);
  assert.equal(ids.filter((id) => id.startsWith('openzoo-')).length, 0);
  assert.equal(fakeClaudeAliases(ids).length, 0);
  for (const row of shaped.data) {
    assert.equal(row.type, 'model');
    assert.ok(row.display_name);
  }
  const grok = shaped.data.find((m) => m.id === 'x-ai/grok-4.6');
  assert.equal(grok.display_name, 'grok-4.6 (x-ai)');
  assert.ok(!/^claude-/.test(grok.id));
  const picked = pickClaudePickerRows(publishModelList(zooPayload(), { aliases: false }).data);
  assert.deepEqual(picked.map((m) => m.id), ids);
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
  // A BOGUS PATH MUST NOT PRODUCE A BOGUS RESOLUTION — that is the real claim.
  //
  // This asserted `null`, which only held on a machine with no Claude Code
  // installed: claudeCodeBinDirs() probes ~/.local/bin, /opt/homebrew/bin and
  // /usr/local/bin BEFORE $PATH (deliberately — see resolveClaudeCli), and
  // those are absolute, so no env stub can hide them. On any dev box that had
  // `claude` the suite failed for a reason that was never a defect.
  const resolved = resolveClaudeCli({ PATH: '/no/such/claude-bin' });
  if (resolved !== null) {
    assert.ok(
      claudeCodeBinDirs().some((d) => resolved.startsWith(`${d}/`)),
      `resolved ${resolved}, which is not one of the known bin dirs`,
    );
    assert.ok(!resolved.startsWith('/no/such/claude-bin'), 'resolved out of the bogus PATH');
  }
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
  assert.ok(cids.includes('x-ai/grok-4.6'), 'Claude-shaped list must keep grok, not filter to claude-*');
  assert.ok(cids.includes('deepseek/deepseek-v4-pro-0813'));
  assert.ok(!cids.includes('openzoo/auto'));
  assert.ok(cids.length > 1);
  assert.ok(cids.length <= 12);
  assert.equal(fakeClaudeAliases(cids).length, 0);
  assert.equal(shaped.data.find((m) => m.id === 'x-ai/grok-4.6').type, 'model');
});

// Sidecar /v1/messages: Claude Code's classifier POSTs model=claude-opus-5.
// Fly 500s that bare id. The proxy must rewrite before the request leaves.

test('POST /v1/messages is forwarded byte-for-byte (passthrough shim)', async (t) => {
  const http = await import('node:http');
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');
  const { config } = await import('../lib/config.js');
  const { resetZooModelIdsCache } = await import('../lib/models.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oz-pass-'));
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
  const up = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url.split('?')[0] === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [pricedRow('anthropic/claude-opus-5')] }));
        return;
      }
      let buf = '';
      req.on('data', (c) => { buf += c; });
      req.on('end', () => {
        seen.push({ path: req.url.split('?')[0], raw: buf });
        // Anthropic-shaped answer — the backend speaks /v1/messages natively.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'msg_test', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'yes' }],
          model: JSON.parse(buf || '{}').model, stop_reason: 'end_turn',
        }));
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
  const body = JSON.stringify({
    model: 'claude-opus-5',
    max_tokens: 32000,
    messages: [{ role: 'user', content: 'continue the task' }],
  });
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
    body,
  });
  const text = await r.text();
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${text}`);
  assert.match(text, /yes/);

  // THE CONTRACT: the path is preserved and the body reaches the backend
  // byte-for-byte — no model rewrite, no classify pin, no translation.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/v1/messages');
  assert.equal(seen[0].raw, body);

  // Alias probes still answer so harnesses validate their configured id.
  const probe = await fetch(`http://127.0.0.1:${port}/v1/models/claude-opus-5`);
  assert.equal(probe.status, 200);
  assert.equal((await probe.json()).id, 'claude-opus-5');
});


test('unopenrouter: a vendor-prefixed id becomes the bare door id when the catalog serves it', () => {
  const ids = ['grok-4.3', 'claude-sonnet-5', 'x-ai/grok-4.6', 'openzoo/auto'];
  assert.equal(resolveModel('x-ai/grok-4.3', ids), 'grok-4.3');
  assert.equal(resolveModel('anthropic/claude-sonnet-5', ids), 'claude-sonnet-5');
  assert.equal(unopenrouter('x-ai/grok-4.6', ids), null);      // no bare row: untouched
  assert.equal(unopenrouter('openzoo/auto', ids), null);       // router alias is not a vendor
  assert.equal(unopenrouter('openzoo-opus-5', ids), null);     // twins are not vendors
  process.env.OPENZOO_UNOPENROUTER = '1';
  assert.equal(unopenrouter('x-ai/grok-4.6', ids), 'grok-4.6');
  process.env.OPENZOO_UNOPENROUTER = '0';
  assert.equal(unopenrouter('x-ai/grok-4.3', ids), null);
  delete process.env.OPENZOO_UNOPENROUTER;
});

test('unopenrouter maps z-ai/glm-5.2 onto the door spelling zai-org/GLM-5.2', () => {
  const ids = ['zai-org/GLM-5.2', 'grok-4.6'];
  assert.equal(unopenrouter('z-ai/glm-5.2', ids), 'zai-org/GLM-5.2');
  assert.equal(resolveModel('z-ai/glm-5.2', ids), 'zai-org/GLM-5.2');
});
