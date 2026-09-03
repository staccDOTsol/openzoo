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

// Robinhood is USDG and nothing else. The ODDBALLER / IOU / ROBINHOODS
// memecoins were only ever payable through X402Wrapper vault twins the payer
// had to mint first; the gateway dropped them along with every wrapped rail,
// and offering to fund a wallet with a token no row accepts reads as "you have
// funds" and then fails at payment. No conversion gas caveat either — canonical
// Paxos USDG implements EIP-3009, so there is no approve+deposit to pay for.
test('robinhood funds with USDG only, and needs no conversion gas', () => {
  assert.equal(
    railFundingHint(['solana', 'base', 'robinhood']),
    'USDC or TOKEN or LEOS on Solana · USDC on Base · USDG on Robinhood Chain',
  );
  assert.deepEqual(unfundableRails(['solana', 'base', 'robinhood']), []);
  assert.deepEqual(unfundableRails(['solana', 'base']), []);
});

test('no funding copy names a memecoin the gateway stopped accepting', () => {
  const copy = [
    railFundingHint(['solana', 'base', 'robinhood']),
    railFundingHint(['robinhood']),
    fundingLine('SoMeAddreSS'),
  ].join(' ');
  for (const dead of ['ODDBALLER', 'IOU', 'ROBINHOODS']) {
    assert.ok(!copy.includes(dead), `funding copy still offers ${dead}`);
  }
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
