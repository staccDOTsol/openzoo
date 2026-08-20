import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OZ_AGENT_PORTS = '0';

const {
  TIERS, TIER_NAMES, TIER_ALIASES, normalizeTier, tierModels,
} = await import('../lib/podagent.mjs');

const GROK46 = ['x-ai/grok-4.6', 'x-ai/grok-4.5', 'x-ai/grok-4.3', 'x-ai/grok-4.20'];

test('TIER_NAMES is cheap / medium / expensive / grok4.6', () => {
  assert.deepEqual(TIER_NAMES, ['cheap', 'medium', 'expensive', 'grok4.6']);
  assert.ok(TIERS.cheap.length > 2);
  assert.ok(TIERS.medium.length > 2);
  assert.ok(TIERS.expensive.length > 2);
  assert.ok(TIERS.expensive.some((id) => /opus|gpt-/i.test(id)));
});

test('TIER_ALIASES + normalizeTier map grok spellings onto grok4.6', () => {
  assert.equal(TIER_ALIASES.grok, 'grok4.6');
  assert.equal(TIER_ALIASES['grok 4.6'], 'grok4.6');
  assert.equal(TIER_ALIASES['grok-4.6'], 'grok4.6');
  assert.equal(TIER_ALIASES['grok4.6'], 'grok4.6');
  assert.equal(normalizeTier('cheap'), 'cheap');
  assert.equal(normalizeTier('MEDIUM'), 'medium');
  assert.equal(normalizeTier('expensive'), 'expensive');
  assert.equal(normalizeTier('grok'), 'grok4.6');
  assert.equal(normalizeTier('grok4.6'), 'grok4.6');
  assert.equal(normalizeTier('grok-4.6'), 'grok4.6');
  assert.equal(normalizeTier('grok 4.6'), 'grok4.6');
  assert.equal(normalizeTier('  Grok 4.6  '), 'grok4.6');
  assert.equal(normalizeTier(''), null);
  assert.equal(normalizeTier('frontier'), null);
  assert.equal(normalizeTier('opus'), null);
});

test('TIERS.grok4.6 is four grok chat models, 4.6 first — no imagine/stt/tts/video', () => {
  assert.deepEqual(TIERS['grok4.6'], GROK46);
  assert.equal(TIERS['grok4.6'][0], 'x-ai/grok-4.6');
  for (const id of TIERS['grok4.6']) {
    assert.match(id, /^x-ai\/grok-/);
    assert.doesNotMatch(id, /imagine|stt|tts|video|opus|gpt-|claude/i);
  }
});

test('tierModels(grok4.6) stays on the grok chat pool', async () => {
  const ids = await tierModels('grok4.6', 99);
  assert.ok(ids.length >= 1);
  assert.ok(ids.length <= GROK46.length);
  for (const id of ids) {
    assert.ok(GROK46.includes(id), `tierModels leaked ${id}`);
    assert.doesNotMatch(id, /imagine|stt|tts|video|opus|gpt-/i);
  }
  assert.deepEqual(await tierModels('grok 4.6', 99), ids);
  assert.deepEqual(await tierModels('grok', 99), ids);
  const expensive = await tierModels('expensive', 99);
  assert.ok(expensive.some((id) => /opus|gpt-/i.test(id)), 'expensive still has frontier non-grok');
});
