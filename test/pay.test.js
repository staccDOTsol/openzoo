import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orderCandidatesByMemory, resetRailMemory } from '../lib/pay.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('balance cache re-reads zeros and expires in seconds, not a minute', () => {
  const pay = readFileSync(path.join(root, 'lib', 'pay.js'), 'utf8');
  assert.match(pay, /OPENZOO_BALANCE_TTL_MS \|\| 8_000/);
  assert.match(pay, /OPENZOO_RAIL_MEMO_MS \|\| 15_000/);
  assert.match(pay, /hit\.raw === 0n/);
  assert.match(pay, /cachedTokenBalance\([\s\S]*force:\s*true/);
  const overlay = readFileSync(path.join(root, 'lib', 'cursorbackend.js'), 'utf8');
  assert.match(overlay, /walletUsdCache\.at < 8_000/);
});

test('rail memory still prefers a funded last-good row', () => {
  resetRailMemory();
  const a = { network: 'solana:x', asset: 'aaa' };
  const b = { network: 'solana:x', asset: 'bbb' };
  const ordered = orderCandidatesByMemory([a, b]);
  assert.equal(ordered[0].asset, 'aaa');
});


/**
 * THE SHIM MUST NEVER WRAP. Every Solana accepts[] row is the raw native mint
 * (canonical Circle USDC, the project tokens as their own mints), so a wallet
 * that wraps moves funds into an escrow the gateway does not accept and then
 * cannot pay with them. The whole conversion subsystem — pool discovery, NAV
 * share maths, the 9-account Wrap, the ERC-4626 approve+deposit on Robinhood —
 * is deleted, and a short row is simply short.
 */
/** Comments may cite the dead machinery as history; executable code may not. */
function codeOnly(src) {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}

test('the pay path holds no conversion machinery', () => {
  const pay = codeOnly(readFileSync(path.join(root, 'lib', 'pay.js'), 'utf8'));
  for (const dead of [
    'wrap.js', 'evmwrap.js', 'sendWrap', 'resolvePool', 'poolState',
    'depositForShares', 'buildWrapInstructions', 'acquireWrappedIfNeeded',
    'topUpQuotedAsset', 'skipWrapWhenEmpty', 'hintedUnderlyingMint',
  ]) {
    assert.doesNotMatch(pay, new RegExp(dead.replace('.', '\\.')), `${dead} must be gone from the pay path`);
  }
  // Short is short: one balance read decides it, with no pool walk behind it.
  assert.match(pay, /if \(bal\.raw < need\) \{/);
  assert.match(pay, /throw new UnderfundedError/);
});

test('no module ships a wrapper mint, an escrow, or a transfer tax', () => {
  for (const f of ['pay.js', 'x402.js', 'config.js', 'info.js', 'demo.js', 'proxy.js']) {
    const code = codeOnly(readFileSync(path.join(root, 'lib', f), 'latin1'));
    for (const dead of ['yUSDCx', 'wTOKENx', 'wLEOSx', 'wUSDGx', 'feeBps', 'escrow']) {
      assert.doesNotMatch(code, new RegExp(dead, 'i'), `${f} still references ${dead}`);
    }
  }
});
