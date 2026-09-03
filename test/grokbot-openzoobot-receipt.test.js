import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  receiptFooter,
  receiptLines,
  xTweetReceipt,
  afterXCollapse,
} from '../lib/openzoobotReceipt.js';

test('openzoobot receipt includes openzoo.fun after this call', () => {
  const footer = receiptFooter();
  assert.match(footer, /x402 \(this call\) openzoo\.fun/);
  assert.doesNotMatch(footer, /\(this call\)\n/);
  assert.match(footer, /\*\*PAID\*\* \$0\.004 x402 \(this call\) openzoo\.fun/);
  assert.match(footer, /\*\*WOULDA\*\* \$0\.03 grok\.com \/ xAI API/);
  assert.match(footer, /^grok-4\.6 @ openzoo$/m);
});

test('openzoobot receipt is three hard-broken lines', () => {
  const lines = receiptLines();
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'grok-4.6 @ openzoo');
  const footer = receiptFooter();
  assert.equal(footer.split('\n\n').length, 3);
  assert.match(footer, /\n\n/);
});

test('hard breaks survive X collapsing blank lines', () => {
  const collapsed = afterXCollapse(receiptFooter({ paid: '0.1217', woulda: '0.1217' }));
  const lines = collapsed.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[1], '**PAID** $0.1217 x402 (this call) openzoo.fun');
  assert.equal(lines[2], '**WOULDA** $0.1217 grok.com / xAI API');
});

test('X tweet form drops markdown and keeps (this call) openzoo.fun on one line', () => {
  const tweet = xTweetReceipt({
    paid: '0.1217',
    woulda: '0.1217',
    wouldaLabel: 'OpenRouter list',
    tx: '5V7vAnscKhyvAzrTdk5uKfZ4bcepqGK6v634sEA4pvmtB3Jjd19n746m3ASSSBBGLCth83EeermfTFVJ1dAPAJYv',
  });
  assert.doesNotMatch(tweet, /\*\*/);
  assert.match(tweet, /PAID \$0\.1217 x402 \(this call\) openzoo\.fun/);
  assert.match(tweet, /WOULDA \$0\.1217 OpenRouter list/);
  assert.match(tweet, /\n\n/);
  const collapsed = afterXCollapse(tweet).split('\n');
  assert.equal(collapsed.length, 4);
  assert.equal(collapsed[0], 'grok-4.6 @ openzoo');
});
