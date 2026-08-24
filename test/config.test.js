import test from 'node:test';
import assert from 'node:assert/strict';
import { railFundingHint, unfundableRails, fundingLine, USDC_MINT, TOKEN_MINT } from '../lib/config.js';

test('the funding hint follows the rails a live 402 offers', () => {
  assert.equal(railFundingHint(['solana']), 'USDC or TOKEN or LEOS on Solana');
  assert.equal(railFundingHint(['base']), 'USDC on Base');
  assert.equal(
    railFundingHint(['solana', 'base']),
    'USDC or TOKEN or LEOS on Solana · USDC on Base',
  );
});

test('robinhood is fundable with plain tokens now the EVM conversion path exists', () => {
  // lib/evmwrap.js converts plain USDG / memecoins into the quoted vault at
  // payment time, so Robinhood funds like any other rail — with the gas caveat
  // riding the hint, since the conversion txs are the wallet's own.
  assert.equal(
    railFundingHint(['solana', 'base', 'robinhood']),
    'USDC or TOKEN or LEOS on Solana · USDC on Base · USDG or ODDBALLER or IOU or ROBINHOODS on Robinhood Chain (plus a sliver of RH ETH for the conversion gas)',
  );
  assert.deepEqual(unfundableRails(['solana', 'base', 'robinhood']), []);
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
