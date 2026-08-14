import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { acquireWrappedIfNeeded, UnderlyingShortError } from '../lib/evmwrap.js';

// Live probes against Robinhood Chain — read-only: a fresh random key holds
// nothing, so every path below fails BEFORE any transaction could be signed.
const RH_RPC = process.env.OPENZOO_RH_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const freshKey = `0x${crypto.randomBytes(32).toString('hex')}`;

const TWIN_ROBINHOODS = '0xD906653C147cF35329161665a4AaaAd3bc118743'; // settles ROBINHOODS
const PLAIN_ODDBALLER = '0x923eb7BD5B84a1a114CB57212cE2F2e87AE60E2A';

const acceptFor = (asset) => ({
  network: 'eip155:4663',
  asset,
  maxAmountRequired: '1000000000000000000', // 1 token, 18 decimals
  extra: { decimals: 18 },
});

test('empty wallet against the vault twin: underfunded error names ONLY the plain token', async () => {
  await assert.rejects(
    acquireWrappedIfNeeded({ rpcUrl: RH_RPC, accept: acceptFor(TWIN_ROBINHOODS), evmPrivateKey: freshKey }),
    (e) => {
      assert.ok(e instanceof UnderlyingShortError, `expected UnderlyingShortError, got ${e.name}: ${e.message}`);
      assert.match(e.message, /ROBINHOODS/, 'copy must name the plain token');
      assert.ok(!/wROBINHOODSx/.test(e.message), 'the twin ticker is plumbing and must never surface');
      return true;
    },
  );
});

test('a plain (non-vault) asset is reported as wrapper:false, not converted', async () => {
  const r = await acquireWrappedIfNeeded({ rpcUrl: RH_RPC, accept: acceptFor(PLAIN_ODDBALLER), evmPrivateKey: freshKey });
  assert.equal(r.acquired, false);
  assert.equal(r.wrapper, false);
});
