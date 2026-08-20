import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  skipWrapWhenEmpty, hintedUnderlyingMint, solanaFundingEmpty,
  orderCandidatesByMemory, resetRailMemory,
} from '../lib/pay.js';
import { USDC_MINT, TOKEN_MINT } from '../lib/config.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('skip wrap when wrapped and underlying are both empty', () => {
  assert.equal(skipWrapWhenEmpty(0n, 0n, 17n), true);
  assert.equal(skipWrapWhenEmpty(0, 0, 17), true);
  assert.equal(skipWrapWhenEmpty(5n, 0n, 17n), true);
});

test('do not skip wrap when the wallet holds underlying to convert', () => {
  assert.equal(skipWrapWhenEmpty(0n, 1_000_000n, 17n), false);
  assert.equal(skipWrapWhenEmpty(16n, 100n, 17n), false);
});

test('already-funded wrapped balance does not look empty', () => {
  assert.equal(skipWrapWhenEmpty(17n, 0n, 17n), false);
  assert.equal(skipWrapWhenEmpty(20n, 0n, 17n), false);
});

test('hintedUnderlyingMint maps 402 twin symbols without RPC', () => {
  assert.equal(hintedUnderlyingMint({ extra: { symbol: 'yUSDCx' } }), USDC_MINT);
  assert.equal(hintedUnderlyingMint({ extra: { symbol: 'wTOKENx' } }), TOKEN_MINT);
  assert.equal(hintedUnderlyingMint({ extra: { acquire: { underlying: { address: USDC_MINT } } } }), USDC_MINT);
  assert.equal(hintedUnderlyingMint({ extra: { symbol: 'unknownTwin' } }), null);
});

test('solanaFundingEmpty is true only when every funding mint is 0', () => {
  assert.equal(solanaFundingEmpty([]), false);
  assert.equal(solanaFundingEmpty([{ raw: 0n }, { raw: 0n }, { raw: 0n }]), true);
  assert.equal(solanaFundingEmpty([{ raw: 0n }, { raw: 1n }, { raw: 0n }]), false);
});

test('rail memory still prefers a funded last-good row', () => {
  resetRailMemory();
  const a = { network: 'solana:x', asset: 'aaa' };
  const b = { network: 'solana:x', asset: 'bbb' };
  const ordered = orderCandidatesByMemory([a, b]);
  assert.equal(ordered[0].asset, 'aaa');
});

test('underfunded 402 body is not a handshake to retry', async () => {
  process.env.OZ_AGENT_PORTS = '0';
  const { isUnderfunded402Body } = await import('../lib/podagent.mjs');
  assert.equal(isUnderfunded402Body({ error: { message: 'openzoo wallet underfunded: this call needs more' } }), true);
  assert.equal(isUnderfunded402Body({ error: { message: 'HTTP 402, the wallet is empty' } }), true);
  assert.equal(isUnderfunded402Body({ error: { message: 'payment required' } }), false);
  assert.equal(isUnderfunded402Body({ x402Version: 1, accepts: [], error: 'payment required' }), false);
});

test('topUpQuotedAsset fail-fasts on 0+0 before poolState / sendWrap', () => {
  const pay = readFileSync(path.join(root, 'lib', 'pay.js'), 'utf8');
  assert.match(pay, /function skipWrapWhenEmpty/);
  assert.match(pay, /solanaFundingEmpty/);
  assert.match(pay, /hintedUnderlyingMint/);
  const top = pay.slice(pay.indexOf('async topUpQuotedAsset'), pay.indexOf('async fetch('));
  assert.match(top, /skipWrapWhenEmpty/);
  const wrapLoop = top.indexOf('for (let attempt = 0; attempt < 3');
  const failFast = top.indexOf('skipWrapWhenEmpty');
  assert.ok(failFast >= 0 && failFast < wrapLoop, 'empty check must run before the sendWrap loop');
  assert.doesNotMatch(top.slice(0, wrapLoop), /sendWrap\(/);
});
