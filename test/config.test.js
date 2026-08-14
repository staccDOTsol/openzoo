import test from 'node:test';
import assert from 'node:assert/strict';
import { railFundingHint, unfundableRails, fundingLine, USDC_MINT, TOKEN_MINT } from '../lib/config.js';

test('the funding hint follows the rails a live 402 offers', () => {
  assert.equal(railFundingHint(['solana']), 'USDC or TOKEN on Solana');
  assert.equal(railFundingHint(['base']), 'USDC on Base');
  assert.equal(
    railFundingHint(['solana', 'base']),
    'USDC or TOKEN on Solana · USDC on Base',
  );
});

test('rails with no fundable underlying are named, not guessed at', () => {
  // Robinhood settles in an asset the shim has no EVM conversion path for, so
  // it must never appear as something to fund.
  assert.equal(railFundingHint(['solana', 'base', 'robinhood']), 'USDC or TOKEN on Solana · USDC on Base');
  assert.deepEqual(unfundableRails(['solana', 'base', 'robinhood']), ['Robinhood Chain']);
  assert.deepEqual(unfundableRails(['solana', 'base']), []);
});

test('an unrecognised network the zoo starts quoting is skipped, not invented', () => {
  assert.equal(railFundingHint(['eip155:999999']), '');
  assert.deepEqual(unfundableRails(['eip155:999999']), []);
  assert.equal(railFundingHint([]), '');
  assert.equal(railFundingHint(undefined), '');
});

test('no user-facing funding copy names a wrapper asset', () => {
  const copy = [
    railFundingHint(['solana', 'base', 'robinhood']),
    fundingLine('SoMeAddreSS'),
  ].join(' ');
  for (const banned of ['yUSDCx', 'wTOKENx', 'wUSDGx', 'x402.accrue.fund/start']) {
    assert.ok(!copy.includes(banned), `funding copy leaked ${banned}`);
  }
});

test('fundingLine names the Solana rail explicitly', () => {
  const line = fundingLine('SoMeAddreSS');
  assert.match(line, /on Solana to SoMeAddreSS$/);
  assert.ok(line.includes(USDC_MINT) && line.includes(TOKEN_MINT));
});
