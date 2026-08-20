import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OZ_AGENT_PORTS = '0';

const {
  TIERS, TIER_NAMES, parseTier, isGrok46Model, tierModels,
} = await import('../lib/podagent.mjs');

test('TIER_NAMES is cheap / medium / expensive / grok4.6', () => {
  assert.deepEqual(TIER_NAMES, ['cheap', 'medium', 'expensive', 'grok4.6']);
  assert.equal(TIER_NAMES.includes('grok4.6'), true);
  assert.ok(TIERS.cheap.length > 2);
  assert.ok(TIERS.medium.length > 2);
  assert.ok(TIERS.expensive.length > 2);
  assert.ok(TIERS.expensive.includes('x-ai/grok-4.6'));
  assert.ok(TIERS.expensive.some((id) => /opus|gpt-/i.test(id)));
});

test('parseTier accepts grok 4.6 aliases and rejects junk', () => {
  assert.equal(parseTier('cheap'), 'cheap');
  assert.equal(parseTier('MEDIUM'), 'medium');
  assert.equal(parseTier('expensive'), 'expensive');
  assert.equal(parseTier('grok4.6'), 'grok4.6');
  assert.equal(parseTier('grok-4.6'), 'grok4.6');
  assert.equal(parseTier('grok 4.6'), 'grok4.6');
  assert.equal(parseTier('  Grok 4.6  '), 'grok4.6');
  assert.equal(parseTier('grok46'), 'grok4.6');
  assert.equal(parseTier(''), null);
  assert.equal(parseTier('frontier'), null);
  assert.equal(parseTier('opus'), null);
});

test('isGrok46Model is family-only — not 4.5, 4.20, opus, gpt', () => {
  assert.equal(isGrok46Model('x-ai/grok-4.6'), true);
  assert.equal(isGrok46Model('x-ai/grok-4.6-fast'), true);
  assert.equal(isGrok46Model('x-ai/grok-4.6:nitro'), true);
  assert.equal(isGrok46Model('x-ai/grok-4.6-20260810'), true);
  assert.equal(isGrok46Model('x-ai/grok-4.5'), false);
  assert.equal(isGrok46Model('x-ai/grok-4.3'), false);
  assert.equal(isGrok46Model('x-ai/grok-4.20'), false);
  assert.equal(isGrok46Model('anthropic/claude-opus-5'), false);
  assert.equal(isGrok46Model('openai/gpt-5.5'), false);
  assert.equal(isGrok46Model('z-ai/glm-4.6'), false);
});

test('tierModels(grok4.6) only returns grok 4.6 ids', async () => {
  const curated = TIERS['grok4.6'];
  assert.ok(curated.length >= 1);
  for (const id of curated) {
    assert.equal(isGrok46Model(id), true, `${id} is not a grok 4.6 id`);
    assert.doesNotMatch(id, /opus|gpt-|claude|grok-4\.5|grok-4\.3|grok-4\.20/i);
  }
  const ids = await tierModels('grok4.6', 99);
  assert.ok(ids.length >= 1);
  for (const id of ids) {
    assert.equal(isGrok46Model(id), true, `tierModels leaked ${id}`);
  }
  const viaAlias = await tierModels('grok 4.6', 99);
  assert.deepEqual(viaAlias, ids);
  const expensive = await tierModels('expensive', 99);
  assert.ok(expensive.some((id) => /opus|gpt-/i.test(id)), 'expensive still has frontier non-grok');
});
