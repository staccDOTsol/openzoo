import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitThink, stripThinkTags, wrapThink, takeThink,
  reasoningPlaintext, messageReasoning, reasoningPresent,
  looksEncryptedReasoning,
} from '../lib/think.js';
import { isRaceCountable, clipRacePreview } from '../lib/livestatus.js';

test('splitThink extracts think/thinking blocks and leaves the answer', () => {
  const leaked = 'visible\n<think>secret plan</think>\nmore\n<thinking>nope</thinking>\n</think>';
  const parts = splitThink(leaked);
  assert.equal(parts.visible.includes('<think'), false);
  assert.equal(parts.visible.includes('</think>'), false);
  assert.match(parts.visible, /visible/);
  assert.match(parts.visible, /more/);
  assert.match(parts.thinking, /secret plan/);
  assert.match(parts.thinking, /nope/);
  assert.equal(stripThinkTags(leaked), parts.visible);
  assert.equal(stripThinkTags('<thinking>unclosed'), '');
  assert.equal(splitThink('<thinking>unclosed').thinking, 'unclosed');
});

test('takeThink / wrapThink round-trip; empty thinking is omitted', () => {
  assert.equal(wrapThink('', 'hello'), 'hello');
  assert.equal(wrapThink('plan', 'hello'), '<think>plan</think>\nhello');
  const settled = takeThink(wrapThink('plan', 'hello'));
  assert.equal(settled.text, 'hello');
  assert.equal(settled.thinking, 'plan');
  assert.equal(takeThink('just an answer').thinking, undefined);
});

test('reasoningPlaintext covers provider fields and skips encrypted blobs', () => {
  assert.equal(reasoningPlaintext('because 2+2'), 'because 2+2');
  assert.equal(reasoningPlaintext({ reasoning_content: 'step one' }), 'step one');
  assert.equal(reasoningPlaintext({ reasoning: 'step two' }), 'step two');
  assert.equal(reasoningPlaintext({ thinking: 'ponder' }), 'ponder');
  assert.equal(reasoningPlaintext({ thought: 'hmm' }), 'hmm');
  assert.equal(reasoningPlaintext({ summary: 'short' }), 'short');
  assert.equal(reasoningPlaintext({
    type: 'reasoning.encrypted',
    data: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }), '');
  const cipher = 'A'.repeat(64);
  assert.equal(looksEncryptedReasoning(cipher), true);
  assert.equal(reasoningPlaintext(cipher), '');
  assert.equal(reasoningPlaintext({ encrypted_content: cipher, summary: 'ok' }), 'ok');
  assert.equal(reasoningPlaintext({ content: 'the answer' }), '');
});

test('messageReasoning never treats message.content as a thought', () => {
  assert.equal(messageReasoning({
    content: 'the answer',
    reasoning_content: 'because',
  }), 'because');
  assert.equal(messageReasoning({ content: 'the answer' }), '');
  assert.equal(messageReasoning(null, { reasoning: 'live' }), 'live');
  assert.equal(messageReasoning({ reasoning: { summary: 'sum' } }), 'sum');
  assert.equal(reasoningPresent({ reasoning_content: 'x' }), true);
  assert.equal(reasoningPresent({ reasoning_encrypted_content: 'x' }), true);
  assert.equal(reasoningPresent({ content: 'nope' }), false);
});

test('think-only arrivals are not a race answer and stay out of the grid preview', () => {
  assert.equal(isRaceCountable('<think>only thinking</think>'), false);
  assert.equal(isRaceCountable('<think>plan</think>\nDONE: built it'), true);
  assert.equal(clipRacePreview('<think>secret\nplan</think>\nvisible line'), 'visible line');
});
