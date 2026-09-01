import assert from 'node:assert/strict';
import test from 'node:test';
import { groupReplyIsPass } from '../lib/cursorbackend.js';

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
