import test from 'node:test';
import assert from 'node:assert/strict';
import { evmRpcForNetwork } from '../lib/config.js';
import { chainName } from '../lib/pay.js';

/**
 * THE ROW'S CHAIN IS THE ROW'S CHAIN.
 *
 * Regression for 2026-09-09: the payment preflight picked its RPC from the
 * RAIL NAME, and railOf() calls every non-Base, non-Robinhood chain "evm". A
 * Polygon row's balance was therefore read over the Robinhood RPC, the read
 * threw, the catch swallowed it, and the wallet signed an authorization for a
 * chain it held nothing on while 76 USDC sat on Base.
 */
test('every rail the gateway offers resolves to an RPC of its own', () => {
  const offered = ['eip155:8453', 'eip155:4663', 'eip155:137', 'eip155:42161', 'eip155:10', 'eip155:480'];
  const urls = offered.map((n) => evmRpcForNetwork(n));
  for (const [i, u] of urls.entries()) assert.ok(u, `${offered[i]} has no RPC`);
  assert.equal(new Set(urls).size, offered.length, 'two chains share one RPC');
});

test('a chain we do not know reports no RPC rather than someone else\'s', () => {
  assert.equal(evmRpcForNetwork('eip155:999999'), null);
  assert.equal(evmRpcForNetwork('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'), null);
  assert.equal(evmRpcForNetwork(''), null);
});

test('funding instructions name the chain a human recognises', () => {
  assert.equal(chainName('eip155:137'), 'Polygon');
  assert.equal(chainName('eip155:8453'), 'Base');
  assert.equal(chainName('eip155:999999'), 'eip155:999999');
});
