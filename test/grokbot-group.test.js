import assert from 'node:assert/strict';
import test from 'node:test';
import { groupReplyIsPass, groupReplyIsRepeat } from '../lib/cursorbackend.js';

test('groupReplyIsPass treats PASS and wrap-up lines as done', () => {
  assert.equal(groupReplyIsPass('PASS'), true);
  assert.equal(groupReplyIsPass('gm: PASS'), true);
  assert.equal(groupReplyIsPass('I have nothing more to add.'), true);
  assert.equal(groupReplyIsPass('we are agreed'), true);
  assert.equal(groupReplyIsPass('ok'), true);
  assert.equal(groupReplyIsPass(
    'rule utilitarianism still smuggles in whose preferences count, and that is the whole fight.',
  ), false);
});

test('groupReplyIsPass: empty, short, and measured wrap-up phrases', () => {
  assert.equal(groupReplyIsPass(''), true);
  assert.equal(groupReplyIsPass('   '), true);
  assert.equal(groupReplyIsPass('yeah'), true);
  assert.equal(groupReplyIsPass("i'm done"), true);
  assert.equal(groupReplyIsPass('i am done'), true);
  assert.equal(groupReplyIsPass("that's all"), true);
  assert.equal(groupReplyIsPass("that's my last word"), true);
  assert.equal(groupReplyIsPass("we're aligned"), true);
  assert.equal(groupReplyIsPass("i'll stop"), true);
  assert.equal(groupReplyIsPass('no further'), true);
  assert.equal(groupReplyIsPass('conversation is over'), true);
  assert.equal(groupReplyIsPass('natural conclusion'), true);
  assert.equal(groupReplyIsPass('i pass'), true);
  assert.equal(groupReplyIsPass('I have nothing else to add'), true);
});

test('groupReplyIsPass: real turns stay in the ping/pong', () => {
  assert.equal(groupReplyIsPass('Please pass this file to Firstmate before you merge.'), false);
  assert.equal(groupReplyIsPass(
    'Keep the worker alive until origin has the footer comment, then review.',
  ), false);
  assert.equal(groupReplyIsPass(
    'The arcade restore still needs CopyBtn aria-label plus a clipboard failure state.',
  ), false);
});

test('groupReplyIsPass treats loop/recursion meta-talk as done', () => {
  const loop = 'It sounds like you are facing a challenge with infinite bot chatter recursion. This can often happen when bots keep triggering each other\'s responses in a loop.';
  assert.equal(groupReplyIsPass(loop), true);
  assert.equal(groupReplyIsRepeat(loop, [
    'It sounds like you are facing a challenge with infinite bot chatter recursion. This can often happen when bots keep triggering each other.',
  ]), true);
  assert.equal(groupReplyIsRepeat(
    'Keep the worker alive until origin has the footer comment, then review the PR.',
    ['The arcade restore still needs CopyBtn aria-label plus a clipboard failure state.'],
  ), false);
});
